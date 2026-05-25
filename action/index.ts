import * as core from '@actions/core';
import * as github from '@actions/github';
import { ReviewOrchestrator } from '../src/review/orchestrator.js';
import type { ReviewResult } from '../src/types/review.js';
import { KimiClient } from '../src/kimi/client.js';
import { loadConfig } from '../src/config/loader.js';
import { calculateCost } from '../src/utils/tokens.js';
import { maybeAutofix } from '../src/autofix/orchestrator.js';

const MERGE_TOKEN = 'claude:suggested merge';

function hasBlockingIssues(r: ReviewResult): boolean {
  return r.stats.critical + r.stats.warning > 0;
}

/** A review where Kimi's response could not be parsed as JSON.
 *  In that case parseKimiResponse returns a stub with all-zero stats —
 *  which would otherwise look identical to a genuinely clean review and
 *  trigger a false-positive merge handoff to Claude. */
function isParseFailure(r: ReviewResult): boolean {
  return /failed to parse kimi response/i.test(r.summary)
    || r.summary === 'Review completed (partial parse)';
}

async function run(): Promise<void> {
  try {
    const kimiApiKey = core.getInput('kimi_api_key', { required: true });
    const githubToken = core.getInput('github_token');
    const model = core.getInput('model') || 'kimi-for-coding';
    const baseUrl = core.getInput('base_url') || undefined;
    const failOn = (core.getInput('fail_on') || 'warning') as 'critical' | 'warning' | 'never';
    const autofixEnabled = (core.getInput('autofix') || 'true').toLowerCase() !== 'false';
    const maxAutofixIterations = parseInt(core.getInput('max_autofix_iterations') || '2', 10);
    const skipIfReviewed = (core.getInput('skip_if_reviewed') || 'true').toLowerCase() !== 'false';

    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    if (!context.payload.pull_request) {
      core.info('Not a pull request event, skipping.');
      return;
    }

    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const pullNumber = context.payload.pull_request.number;
    const headSha = context.payload.pull_request.head.sha;
    const headRef = context.payload.pull_request.head.ref;

    core.info(`Reviewing PR #${pullNumber} (${headSha.slice(0, 7)}) on ${headRef}`);

    const restOctokit = octokit.rest;

    // --- Idempotency check: skip if this exact head SHA was already reviewed by us ---
    if (skipIfReviewed) {
      try {
        const { data: existingReviews } = await restOctokit.pulls.listReviews({
          owner,
          repo,
          pull_number: pullNumber,
          per_page: 100,
        });
        const alreadyReviewed = existingReviews.some(
          (r) =>
            (r.user?.login === 'github-actions[bot]' || r.user?.type === 'Bot') &&
            r.commit_id === headSha &&
            (r.body || '').includes('Kimi Code Review'),
        );
        if (alreadyReviewed) {
          core.info(`Kimi already reviewed ${headSha.slice(0, 7)}; skipping duplicate run.`);
          core.setOutput('autofix_outcome', 'skipped-already-reviewed');
          return;
        }
      } catch (e) {
        core.warning(
          `Idempotency check failed (continuing with review): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const config = await loadConfig(restOctokit as any, owner, repo);
    config.review.failOn = failOn;

    const kimi = new KimiClient({ apiKey: kimiApiKey, model, baseUrl });
    const orchestrator = new ReviewOrchestrator(restOctokit as any, kimi, config);

    // Phase 1: initial review
    const first = await orchestrator.reviewPullRequest({ owner, repo, pullNumber, headSha });

    core.setOutput('review_summary', first.result.summary);
    core.setOutput('annotations_count', first.result.annotations.length.toString());
    core.setOutput('critical_count', first.result.stats.critical.toString());
    core.setOutput(
      'tokens_used',
      (first.result.tokensUsed.input + first.result.tokensUsed.output).toString(),
    );
    core.setOutput('cost_estimate', calculateCost(first.result.tokensUsed).toString());

    core.summary
      .addHeading('Kimi Code Review', 2)
      .addRaw(`**Score:** ${first.result.score}/100\n\n`)
      .addRaw(first.result.summary)
      .addTable([
        [
          { data: 'Severity', header: true },
          { data: 'Count', header: true },
        ],
        ['Critical', first.result.stats.critical.toString()],
        ['Warning', first.result.stats.warning.toString()],
        ['Suggestion', first.result.stats.suggestion.toString()],
      ]);
    await core.summary.write();

    let finalResult = first.result;
    let autofixOutcome = 'skipped';
    let finalHeadSha = headSha;

    // Phase 2: autofix if review has critical/warning AND it's not a parse-failure.
    if (autofixEnabled && first.prContext && hasBlockingIssues(first.result) && !isParseFailure(first.result)) {
      core.info(`Autofix: running (cap ${maxAutofixIterations})...`);
      try {
        const af = await maybeAutofix({
          kimi,
          ctx: first.prContext,
          result: first.result,
          config,
          headBranch: headRef,
          maxIterations: maxAutofixIterations,
          octokit: restOctokit as any,
        });

        if (af.pushed && af.commitSha) {
          autofixOutcome = `applied (commit ${af.commitSha.slice(0, 8)})`;
          core.info(`Autofix pushed ${af.commitSha} — re-reviewing the new head.`);
          finalHeadSha = af.commitSha;

          // Phase 3: re-review the autofix commit (GITHUB_TOKEN pushes don't trigger workflows,
          // so we do the second review inline)
          try {
            const second = await orchestrator.reviewPullRequest({
              owner,
              repo,
              pullNumber,
              headSha: af.commitSha,
            });
            finalResult = second.result;
            core.info(
              `Re-review: score=${second.result.score}, c/w/s=${second.result.stats.critical}/${second.result.stats.warning}/${second.result.stats.suggestion}`,
            );
          } catch (e) {
            core.warning(
              `Re-review after autofix failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else {
          autofixOutcome = `noop (${af.reason})`;
          core.info(`Autofix: ${autofixOutcome}`);
        }
      } catch (e) {
        autofixOutcome = `errored: ${e instanceof Error ? e.message : 'unknown'}`;
        core.warning(`Autofix threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (isParseFailure(first.result)) {
      autofixOutcome = 'skipped-parse-failure';
      core.warning('Kimi review was a parse-failure stub; autofix and merge-handoff skipped.');
    }

    // Phase 4: if the final review is clean AND parsed successfully, signal Claude to merge.
    // Idempotency: skip if an existing comment with the merge token already exists.
    if (autofixEnabled && !hasBlockingIssues(finalResult) && !isParseFailure(finalResult)) {
      try {
        let alreadySuggested = false;
        try {
          const { data: existingComments } = await restOctokit.issues.listComments({
            owner,
            repo,
            issue_number: pullNumber,
            per_page: 100,
          });
          alreadySuggested = existingComments.some(
            (c) => (c.body || '').includes(MERGE_TOKEN),
          );
        } catch {
          /* fall through and try to post anyway */
        }

        if (alreadySuggested) {
          core.info(`Merge already suggested previously; not re-posting.`);
        } else {
          await restOctokit.issues.createComment({
            owner,
            repo,
            issue_number: pullNumber,
            body:
              `Kimi has reviewed this PR — no remaining critical or warning issues.` +
              (autofixOutcome.startsWith('applied') ? ` Autofix applied at ${finalHeadSha.slice(0, 8)}.` : '') +
              `\n\n${MERGE_TOKEN}`,
          });
          core.info(`Posted ${MERGE_TOKEN}`);
          if (autofixOutcome === 'skipped') autofixOutcome = 'merge-suggested';
          else autofixOutcome += '; merge-suggested';
        }
      } catch (e) {
        core.warning(`Failed to post merge-suggest: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    core.setOutput('autofix_outcome', autofixOutcome);

    if (failOn === 'critical' && finalResult.stats.critical > 0) {
      core.setFailed(`Found ${finalResult.stats.critical} critical issue(s)`);
    } else if (
      failOn === 'warning' &&
      (finalResult.stats.critical > 0 || finalResult.stats.warning > 0)
    ) {
      core.setFailed(
        `Found ${finalResult.stats.critical} critical and ${finalResult.stats.warning} warning issue(s)`,
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Kimi review failed: ${error.message}`);
    } else {
      core.setFailed('Kimi review failed with unknown error');
    }
  }
}

run();
