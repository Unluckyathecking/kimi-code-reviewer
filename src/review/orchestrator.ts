import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { PullRequestContext, ReviewResult } from '../types/review.js';
import { KimiClient } from '../kimi/client.js';
import { packContext } from '../kimi/context-packer.js';
import { buildReviewMessages } from '../kimi/prompt-builder.js';
import { buildCacheOptimizedMessages } from '../kimi/cache-strategy.js';
import { parseKimiResponse } from '../kimi/response-parser.js';
import { extractPullRequestContext } from '../github/pulls.js';
import { createCheckRun, completeCheckRun } from '../github/checks.js';
import { createPRReview } from '../github/comments.js';
import { filterFiles } from './file-filter.js';
import { buildSummary } from './summary-builder.js';
import { ReviewError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

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

export class ReviewOrchestrator {
  constructor(
    private octokit: Octokit,
    private kimi: KimiClient,
    private config: ReviewConfig,
  ) {}

  async reviewPullRequest(params: ReviewParams): Promise<ReviewExecution> {
    const { owner, repo, pullNumber, headSha } = params;

    // Step 1: Create Check Run
    const checkRunId = await createCheckRun(this.octokit, {
      owner,
      repo,
      headSha,
    });

    try {
      // Step 2: Extract PR context
      logger.info({ pullNumber }, 'Extracting PR context');
      const prContext = await extractPullRequestContext(
        this.octokit,
        owner,
        repo,
        pullNumber,
        this.config,
      );

      // Step 3: Filter files
      const filteredFiles = filterFiles(prContext.changedFiles, this.config);
      prContext.changedFiles = filteredFiles;

      if (filteredFiles.length === 0) {
        const result: ReviewResult = {
          summary: 'No reviewable files in this PR (all files matched exclude patterns).',
          score: 100,
          annotations: [],
          stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
          tokensUsed: { input: 0, output: 0, cached: 0 },
        };

        await completeCheckRun(this.octokit, {
          owner,
          repo,
          checkRunId,
          conclusion: 'success',
          summary: result.summary,
          annotations: [],
        });

        return { result, prContext };
      }

      // Step 4: Pack context (256K optimization)
      const packed = packContext(prContext, this.config);
      logger.info(
        { strategy: packed.strategy, totalTokens: packed.totalTokens },
        'Context packed',
      );

      // Step 5: Build messages (cache-optimized order)
      const systemPrompt = buildReviewMessages(prContext, this.config)[0].content;
      const messages = buildCacheOptimizedMessages(
        systemPrompt,
        prContext,
        this.config,
        prContext.fileContents,
      );

      // Step 6: Call Kimi API
      logger.info({ messageCount: messages.length }, 'Calling Kimi API');
      const response = await this.kimi.chatCompletion({
        messages,
        responseFormat: { type: 'json_object' },
      });

      // Step 7: Parse response
      const result = parseKimiResponse(response.choices[0].message.content, {
        input: response.usage.prompt_tokens,
        output: response.usage.completion_tokens,
        cached: response.usage.cached_tokens ?? 0,
      });

      // Step 8: Filter by severity
      const minSeverityOrder = ['critical', 'warning', 'suggestion', 'nitpick'];
      const minIdx = minSeverityOrder.indexOf(this.config.review.minSeverity);
      result.annotations = result.annotations.filter(
        (a) => minSeverityOrder.indexOf(a.severity) <= minIdx,
      );

      // Step 9: Limit annotations
      if (result.annotations.length > this.config.review.maxAnnotations) {
        result.annotations = result.annotations.slice(0, this.config.review.maxAnnotations);
      }

      // Step 10: Determine conclusion
      const conclusion =
        this.config.review.failOn === 'critical' && result.stats.critical > 0
          ? 'failure'
          : this.config.review.failOn === 'warning' &&
              (result.stats.critical > 0 || result.stats.warning > 0)
            ? 'failure'
            : 'success';

      // Step 11: Update Check Run
      const summaryMd = buildSummary(result);
      await completeCheckRun(this.octokit, {
        owner,
        repo,
        checkRunId,
        conclusion,
        summary: summaryMd,
        annotations: result.annotations,
      });

      // Step 12: Create PR Review
      await createPRReview(this.octokit, {
        owner,
        repo,
        pullNumber,
        commitSha: headSha,
        result,
        failOn: this.config.review.failOn,
      });

      logger.info(
        {
          pullNumber,
          score: result.score,
          annotations: result.annotations.length,
          conclusion,
        },
        'Review completed',
      );

      return { result, prContext };
    } catch (err) {
      logger.error({ err, pullNumber }, 'Review failed');

      await completeCheckRun(this.octokit, {
        owner,
        repo,
        checkRunId,
        conclusion: 'failure',
        summary: `Review failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        annotations: [],
      });

      throw new ReviewError(
        err instanceof Error ? err.message : 'Unknown error',
        'orchestration',
      );
    }
  }
}
