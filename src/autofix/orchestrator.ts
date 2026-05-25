import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Octokit } from '@octokit/rest';
import { KimiClient } from '../kimi/client.js';
import type { PullRequestContext, ReviewResult, ChatMessage } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export interface AutofixResult {
  attempted: boolean;
  applied: boolean;
  pushed: boolean;
  reason: string;
  commitSha?: string;
}

const COMMIT_MARKER = '[kimi-autofix]';

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    const stderr = e.stderr ? (Buffer.isBuffer(e.stderr) ? e.stderr.toString() : e.stderr) : '';
    throw new Error(`git ${args.join(' ')} failed: ${stderr || e.message}`);
  }
}

/** Count existing autofix commits on the current branch by scanning HEAD's history. */
function countAutofixIterations(): number {
  try {
    const log = git(['log', '--format=%s', `--grep=${COMMIT_MARKER}`, '-n', '100']);
    if (!log) return 0;
    return log.split('\n').filter((s) => s.includes(COMMIT_MARKER)).length;
  } catch {
    return 0;
  }
}

function buildAutofixMessages(
  ctx: PullRequestContext,
  result: ReviewResult,
  config: ReviewConfig,
): ChatMessage[] {
  // Take only critical + warning annotations — autofix should not chase nitpicks.
  const actionable = result.annotations.filter(
    (a) => a.severity === 'critical' || a.severity === 'warning',
  );

  const annotationsText = actionable
    .map(
      (a, i) =>
        `${i + 1}. [${a.severity}] ${a.path}:${a.startLine}-${a.endLine} — ${a.title}\n   ${a.body}${a.suggestedFix ? `\n   Suggested fix snippet:\n${a.suggestedFix}` : ''}`,
    )
    .join('\n\n');

  const fileBlocks: string[] = [];
  for (const [path, content] of ctx.fileContents) {
    fileBlocks.push(`### ${path}\n\`\`\`\n${content}\n\`\`\``);
  }

  const system = `You are a senior staff engineer applying YOUR OWN code review feedback as a patch.

You previously reviewed this pull request and flagged ${actionable.length} actionable issues (critical/warning).

Your task: produce a unified git diff that fixes EVERY listed issue against the current PR head.

OUTPUT FORMAT (strict):
- Output ONLY the unified diff, starting with the first \`diff --git\` line.
- No prose, no markdown code fences, no explanations before or after.
- Each hunk header MUST be a real \`@@ -X,Y +A,B @@\` line that \`git apply\` can consume.
- File paths use the form \`a/<path>\` and \`b/<path>\` exactly as they appear in the file list below.

RULES:
- Modify only files listed below. Do not create or delete files. Do not touch lockfiles, Dockerfiles, or CI config.
- Address every CRITICAL and WARNING. Ignore suggestions and nitpicks.
- Keep the diff minimal — only the lines needed to fix the flagged issues.
- Do not add or remove dependencies. Do not change exported function/type signatures unless the flagged issue forces it.
- If any single issue cannot be fixed safely with a minimal patch (e.g. requires architectural changes), include comments in the diff for the ones you can do and skip the impossible one rather than producing a bad diff.
- If you cannot fix ANY of the issues safely, output the literal string \`NO_PATCH: <one-line reason>\` and nothing else.

The patch will be applied with \`git apply\` against the current working tree (which is the PR head), then committed by github-actions[bot] and pushed back to the PR branch, triggering another Kimi review of the result.`;

  const user = `## Files at the current PR head\n\n${fileBlocks.join('\n\n')}\n\n## Your review of this PR\n\n**Summary:** ${result.summary}\n\n**Score:** ${result.score}/100\n\n## Actionable annotations to fix\n\n${annotationsText}\n\n## Now produce the unified diff (or NO_PATCH: <reason>):`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function extractDiff(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('NO_PATCH:')) return null;

  // 1. fenced block?
  const fenced = trimmed.match(/```(?:diff|patch)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenced ? fenced[1] : trimmed;

  // 2. find the start of the diff
  const startIdx = candidate.indexOf('diff --git');
  if (startIdx < 0) return null;
  let diff = candidate.slice(startIdx);

  // 3. trim anything after the diff (e.g. a blank line + prose)
  // git diffs have no trailing prose by convention; cut at the first long blank+prose pattern
  diff = diff.replace(/\n+(?=\S)\n[^\-+@d ].*$/s, '\n');
  if (!diff.endsWith('\n')) diff += '\n';
  return diff;
}

export async function maybeAutofix(params: {
  kimi: KimiClient;
  ctx: PullRequestContext;
  result: ReviewResult;
  config: ReviewConfig;
  headBranch: string;
  maxIterations: number;
  octokit: Octokit;
}): Promise<AutofixResult> {
  const { kimi, ctx, result, config, headBranch, maxIterations } = params;

  // Only act on critical/warning. SUGGESTION/NITPICK reviews don't trigger autofix.
  const actionable = result.stats.critical + result.stats.warning;
  if (actionable === 0) {
    return { attempted: false, applied: false, pushed: false, reason: 'no critical/warning to fix' };
  }

  const priorIters = countAutofixIterations();
  if (priorIters >= maxIterations) {
    return {
      attempted: false,
      applied: false,
      pushed: false,
      reason: `iteration cap reached (${priorIters}/${maxIterations}); leaving for @jules`,
    };
  }

  logger.info({ priorIters, maxIterations, actionable }, 'Kimi autofix starting');

  // Ask Kimi for a patch.
  const messages = buildAutofixMessages(ctx, result, config);
  const response = await kimi.chatCompletion({ messages });
  const raw = response.choices[0]?.message?.content ?? '';

  const diff = extractDiff(raw);
  if (!diff) {
    logger.warn({ rawPreview: raw.slice(0, 300) }, 'Autofix: no usable diff in Kimi response');
    return {
      attempted: true,
      applied: false,
      pushed: false,
      reason: raw.trim().startsWith('NO_PATCH:') ? raw.trim() : 'no diff extractable',
    };
  }

  const patchPath = join(tmpdir(), `kimi-autofix-${Date.now()}.patch`);
  writeFileSync(patchPath, diff, 'utf-8');

  try {
    // Configure git identity for the bot.
    git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
    git(['config', 'user.name', 'github-actions[bot]']);

    // Apply the patch.
    try {
      git(['apply', '--check', patchPath]);
    } catch (e) {
      logger.warn({ err: (e as Error).message, diffPreview: diff.slice(0, 400) }, 'Autofix: git apply --check failed');
      return {
        attempted: true,
        applied: false,
        pushed: false,
        reason: `git apply --check failed: ${(e as Error).message.slice(0, 200)}`,
      };
    }
    git(['apply', patchPath]);

    // Stage + commit.
    git(['add', '-A']);
    const status = git(['status', '--porcelain']);
    if (!status) {
      return { attempted: true, applied: false, pushed: false, reason: 'patch produced no net changes' };
    }

    const iter = priorIters + 1;
    const message = `fix: address Kimi review feedback ${COMMIT_MARKER} iter=${iter}/${maxIterations}`;
    git(['commit', '-m', message]);
    const sha = git(['rev-parse', 'HEAD']);

    // Push back to the PR branch.
    try {
      git(['push', 'origin', `HEAD:${headBranch}`]);
      logger.info({ sha, headBranch }, 'Autofix pushed');
      return { attempted: true, applied: true, pushed: true, reason: 'autofix committed and pushed', commitSha: sha };
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'Autofix: push failed');
      return {
        attempted: true,
        applied: true,
        pushed: false,
        reason: `commit succeeded but push failed: ${(e as Error).message.slice(0, 200)}`,
        commitSha: sha,
      };
    }
  } finally {
    try {
      unlinkSync(patchPath);
    } catch {
      /* ignore */
    }
  }
}

/** Returns true if any commit on the current branch carries the autofix marker. */
export function branchHasAutofixCommits(): boolean {
  return countAutofixIterations() > 0;
}
