import type { Octokit } from '@octokit/rest';
import type { ReviewResult } from '../types/review.js';
export declare function createPRReview(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitSha: string;
    result: ReviewResult;
    failOn: 'critical' | 'warning' | 'never';
    headBranch?: string;
    authorLogin?: string;
}): Promise<void>;
//# sourceMappingURL=comments.d.ts.map