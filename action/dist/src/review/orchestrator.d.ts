import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { PullRequestContext, ReviewResult } from '../types/review.js';
import { KimiClient } from '../kimi/client.js';
interface ReviewParams {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
}
export interface ReviewExecution {
    result: ReviewResult;
    prContext: PullRequestContext | null;
}
export declare class ReviewOrchestrator {
    private octokit;
    private kimi;
    private config;
    constructor(octokit: Octokit, kimi: KimiClient, config: ReviewConfig);
    reviewPullRequest(params: ReviewParams): Promise<ReviewExecution>;
}
export {};
//# sourceMappingURL=orchestrator.d.ts.map