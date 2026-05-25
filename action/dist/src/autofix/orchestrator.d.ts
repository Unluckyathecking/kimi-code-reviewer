import type { Octokit } from '@octokit/rest';
import { KimiClient } from '../kimi/client.js';
import type { PullRequestContext, ReviewResult } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
export interface AutofixResult {
    attempted: boolean;
    applied: boolean;
    pushed: boolean;
    reason: string;
    commitSha?: string;
}
export declare function maybeAutofix(params: {
    kimi: KimiClient;
    ctx: PullRequestContext;
    result: ReviewResult;
    config: ReviewConfig;
    headBranch: string;
    maxIterations: number;
    octokit: Octokit;
}): Promise<AutofixResult>;
/** Returns true if any commit on the current branch carries the autofix marker. */
export declare function branchHasAutofixCommits(): boolean;
//# sourceMappingURL=orchestrator.d.ts.map