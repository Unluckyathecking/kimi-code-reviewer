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

/** Resolve which AI agent (if any) is responsible for iterating on this PR.
 *  Returns the mention handle to tag, or null if we shouldn't auto-mention. */
function resolveAgentHandle(
  headBranch: string | undefined,
  authorLogin: string | undefined,
): { handle: string; name: string } | null {
  const branch = (headBranch || '').toLowerCase();
  const author = (authorLogin || '').toLowerCase();

  // Bot author is the strongest signal.
  if (author === 'google-labs-jules[bot]') return { handle: '@jules', name: 'Jules' };
  if (author === 'chatgpt-codex-connector[bot]') return { handle: '@codex', name: 'Codex' };

  // Branch prefix conventions used by autonomous agents in this org.
  if (branch.startsWith('jules/')) return { handle: '@jules', name: 'Jules' };
  if (branch.startsWith('codex/')) return { handle: '@codex', name: 'Codex' };

  // Jules-engine personas (Bolt/Palette/Sentinel) often slug-prefix without the
  // jules/ namespace; the trailing 15+ digit session id is the giveaway.
  if (/(palette|sentinel|bolt)/.test(branch) && /\d{15,}/.test(branch)) {
    return { handle: '@jules', name: 'Jules' };
  }

  // Unknown / user-authored PR — don't auto-mention anyone.
  return null;
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
  const agent = resolveAgentHandle(headBranch, authorLogin);
  const body = buildReviewBody(result, shouldRequestChanges, agent);

  // Inline comments on each non-nitpick annotation.
  const comments = result.annotations
    .filter((a) => a.severity !== 'nitpick')
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
      { pullNumber, event, commentCount: comments.length, agent: agent?.name ?? 'none' },
      'PR review created',
    );
  } catch (err) {
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

function buildActionPlan(
  result: ReviewResult,
  agent: { handle: string; name: string },
): string {
  // Order: critical first, then warning. Drop suggestions and nitpicks from
  // the plan — those go to the inline thread but don't block merge.
  const ordered = result.annotations
    .filter((a) => a.severity === 'critical' || a.severity === 'warning')
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));

  if (ordered.length === 0) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push(`### 📋 Action plan for ${agent.handle}`);
  lines.push('');
  lines.push(
    `${agent.name}, complete the items below — critical first, then warning. ` +
      `Push fixes to the same branch and I will re-review automatically. ` +
      `If any item genuinely can't be fixed in this PR's scope, leave a yes/no question for me in the PR description (prefix it with \`@kimi\`) and proceed with the rest.`,
  );
  lines.push('');

  ordered.forEach((a, i) => {
    const sev = `${SEVERITY_EMOJI[a.severity]} **[${a.severity}]**`;
    lines.push(`${i + 1}. ${sev} \`${a.path}:${a.startLine}\` — ${a.title}`);
    const reason = (a.body || '').split('\n')[0].slice(0, 240).trim();
    if (reason) lines.push(`   - **Why:** ${reason}`);
    if (a.suggestedFix) {
      lines.push(`   - **Suggested fix:**`);
      lines.push('     ```');
      for (const fl of a.suggestedFix.split('\n').slice(0, 12)) {
        lines.push(`     ${fl}`);
      }
      if (a.suggestedFix.split('\n').length > 12) {
        lines.push('     // … (truncated; full diff in the inline comment)');
      }
      lines.push('     ```');
    }
  });

  lines.push('');
  return lines.join('\n');
}

function buildReviewBody(
  result: ReviewResult,
  shouldRequestChanges: boolean,
  agent: { handle: string; name: string } | null,
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

  // Action plan only when there's work to do AND we know who's working it.
  if (shouldRequestChanges && agent) {
    lines.push(buildActionPlan(result, agent));
  } else if (shouldRequestChanges && !agent) {
    // No identified agent — leave a generic line so a human reviewer knows
    // what to forward this to. Don't tag anyone.
    lines.push('');
    lines.push(
      `### 📋 Action plan`,
    );
    lines.push('');
    lines.push(
      'This PR appears to be human-authored (no Jules/Codex/agent signature on the branch or author). ' +
        'Address the critical and warning annotations above, then push to the same branch — Kimi will re-review automatically.',
    );
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
