import type { Octokit } from '@octokit/rest';
import type { ReviewAnnotation, ReviewResult, Severity } from '../types/review.js';
import { calculateCost } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '🔵',
  nitpick: '⚪',
};

/** Heuristic: was this PR opened by Jules? Used to decide whether to @-mention
 *  Jules in the review body (so we don't ping Jules on user-authored PRs). */
function isJulesPR(headBranch: string | undefined, authorLogin: string | undefined): boolean {
  const b = (headBranch || '').toLowerCase();
  if (b.startsWith('jules/')) return true;
  // Jules sometimes ships under a generic slug + an embedded numeric session id at the end.
  if (/-\d{15,}$/.test(b) && /palette|sentinel|bolt|maint|jules/.test(b)) return true;
  const a = (authorLogin || '').toLowerCase();
  if (a === 'google-labs-jules[bot]') return true;
  return false;
}

export async function createPRReview(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitSha: string;
    result: ReviewResult;
    failOn: 'critical' | 'warning' | 'never';
    headBranch?: string;
    authorLogin?: string;
  },
): Promise<void> {
  const { owner, repo, pullNumber, commitSha, result, failOn, headBranch, authorLogin } = params;

  const shouldRequestChanges =
    failOn === 'critical'
      ? result.stats.critical > 0
      : failOn === 'warning'
        ? result.stats.critical > 0 || result.stats.warning > 0
        : false;

  const event = shouldRequestChanges ? 'REQUEST_CHANGES' : 'COMMENT';
  const jules = isJulesPR(headBranch, authorLogin);
  const body = buildReviewBody(result, shouldRequestChanges, jules);

  // Create the review with inline comments
  const comments = result.annotations
    .filter((a) => a.severity !== 'nitpick') // nitpicks only go to Check annotations
    .map((a) => ({
      path: a.path,
      line: a.endLine,
      side: 'RIGHT' as const,
      body: formatAnnotationComment(a),
    }));

  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitSha,
      event,
      body,
      comments,
    });

    logger.info(
      { pullNumber, event, commentCount: comments.length, jules },
      'PR review created',
    );
  } catch (err) {
    // If inline comments fail (e.g., line not in diff), fall back to body-only review
    logger.warn({ err }, 'Failed to create review with inline comments, falling back');
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitSha,
      event,
      body: body + '\n\n> _Note: Some inline comments could not be placed on the diff._',
    });
  }
}

function buildReviewBody(
  result: ReviewResult,
  shouldRequestChanges: boolean,
  isJules: boolean,
): string {
  const cost = calculateCost(result.tokensUsed);
  const lines: string[] = [];

  lines.push('## 🤖 Kimi Code Review\n');
  lines.push(result.summary);
  lines.push('');
  lines.push(`**Score:** ${result.score}/100`);
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|----------|-------|');
  for (const [severity, count] of Object.entries(result.stats)) {
    if (count > 0) {
      lines.push(`| ${SEVERITY_EMOJI[severity as Severity]} ${severity} | ${count} |`);
    }
  }

  if (shouldRequestChanges && isJules) {
    lines.push('');
    lines.push('@jules — please address the feedback above. Push fixes to the same branch and Kimi will re-review automatically.');
  }

  lines.push('');
  lines.push('<details>');
  lines.push('<summary>Token Usage & Cost</summary>\n');
  lines.push(`- Input: ${result.tokensUsed.input.toLocaleString()} tokens`);
  lines.push(`- Output: ${result.tokensUsed.output.toLocaleString()} tokens`);
  lines.push(`- Cached: ${result.tokensUsed.cached.toLocaleString()} tokens`);
  lines.push(`- Estimated cost: $${cost}`);
  lines.push('</details>\n');

  lines.push('---');
  lines.push('*Powered by [Kimi Code Reviewer](https://github.com/kimi-code-reviewer/kimi-code-reviewer) — Moonshot AI 256K context*');

  return lines.join('\n');
}

function formatAnnotationComment(a: ReviewAnnotation): string {
  const parts: string[] = [];
  parts.push(`${SEVERITY_EMOJI[a.severity]} **[${a.severity}]** ${a.title}\n`);
  parts.push(a.body);

  if (a.suggestedFix) {
    parts.push('\n**Suggested fix:**');
    parts.push('```suggestion');
    parts.push(a.suggestedFix);
    parts.push('```');
  }

  return parts.join('\n');
}
