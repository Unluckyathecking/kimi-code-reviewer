import { z } from 'zod';
import type { ReviewResult, Severity, AnnotationCategory } from '../types/review.js';
import { logger } from '../utils/logger.js';

// Accept both camelCase and snake_case field names
const annotationSchema = z
  .object({
    path: z.string(),
    startLine: z.number().int().positive().optional(),
    start_line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    line: z.number().int().positive().optional(),
    severity: z.enum(['critical', 'warning', 'suggestion', 'nitpick']),
    category: z
      .enum([
        'bug', 'security', 'performance', 'style',
        'best-practice', 'documentation', 'testing', 'other',
      ])
      .catch('other'),
    title: z.string(),
    body: z.string().optional().default(''),
    message: z.string().optional(),
    description: z.string().optional(),
    suggestedFix: z.string().nullable().optional(),
    suggested_fix: z.string().nullable().optional(),
  })
  .transform((a) => {
    const startLine = a.startLine ?? a.start_line ?? a.line ?? 1;
    const endLine = a.endLine ?? a.end_line ?? startLine;
    const body = a.body || a.message || a.description || '';
    const suggestedFix = a.suggestedFix ?? a.suggested_fix ?? undefined;
    return {
      path: a.path,
      startLine,
      endLine,
      severity: a.severity,
      category: a.category as AnnotationCategory,
      title: a.title,
      body,
      suggestedFix: suggestedFix ?? undefined,
    };
  });

const reviewResponseSchema = z.object({
  summary: z.string(),
  score: z.number().min(0).max(100),
  annotations: z.array(annotationSchema).default([]),
});

/**
 * Repair common LLM-output JSON defects:
 *   - smart quotes substituted for ASCII quotes
 *   - trailing commas before } or ]
 *   - literal newlines / carriage returns / tabs inside string values
 *     (Kimi occasionally emits these when restating multi-line evidence)
 */
function repairJson(text: string): string {
  const normalised = text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,(\s*[}\]])/g, '$1');

  let result = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < normalised.length; i++) {
    const ch = normalised[i];
    if (escape) {
      result += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

function tryParse(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(repairJson(candidate));
    } catch {
      return null;
    }
  }
}

function stripOuterFence(raw: string): string {
  const openMatch = raw.match(/^[\s\S]*?```(?:json)?[ \t]*\r?\n/);
  let body = openMatch ? raw.slice(openMatch[0].length) : raw;
  const closeIdx = body.lastIndexOf('```');
  if (closeIdx >= 0) body = body.slice(0, closeIdx);
  return body.trim();
}

/**
 * Try multiple strategies to extract a JSON object from Kimi's response.
 */
function extractJson(raw: string): unknown | null {
  // Strategy 1: Direct parse (with repair fallback)
  const direct = tryParse(raw);
  if (direct !== null) return direct;

  // Strategy 1.5: Strip leading/trailing markdown fences (handles fences with
  // internal triple-backticks in suggestedFix values that confuse the regex).
  const stripped = stripOuterFence(raw);
  if (stripped && stripped !== raw) {
    const fromStripped = tryParse(stripped);
    if (fromStripped !== null) return fromStripped;
  }

  // Strategy 2: Non-greedy match between opening and closing ``` fences
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    const fromBlock = tryParse(codeBlockMatch[1]);
    if (fromBlock !== null) return fromBlock;
  }

  // Strategy 3: Depth-tracked brace match starting at the first `{`
  const firstBrace = raw.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(firstBrace, i + 1);
          const parsed = tryParse(candidate);
          if (parsed !== null) return parsed;
          break;
        }
      }
    }
  }

  return null;
}

export function parseKimiResponse(
  raw: string,
  tokenUsage: { input: number; output: number; cached: number },
): ReviewResult {
  logger.info({ rawLength: raw.length, rawPreview: raw.slice(0, 300) }, 'Parsing Kimi response');

  const parsed = extractJson(raw);

  if (!parsed || typeof parsed !== 'object') {
    logger.error(
      {
        rawLength: raw.length,
        rawHead: raw.slice(0, 2000),
        rawTail: raw.length > 2000 ? raw.slice(-1000) : null,
      },
      'Could not extract JSON from Kimi response',
    );
    return {
      summary: 'Failed to parse Kimi response as JSON.',
      score: 50,
      annotations: [],
      stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
      tokensUsed: tokenUsage,
    };
  }

  const result = reviewResponseSchema.safeParse(parsed);
  if (result.success) {
    const data = result.data;
    const stats: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0, nitpick: 0 };
    for (const a of data.annotations) {
      stats[a.severity]++;
    }
    return {
      summary: data.summary,
      score: data.score,
      annotations: data.annotations,
      stats,
      tokensUsed: tokenUsage,
    };
  }

  // Schema validation failed — salvage what we can
  logger.warn({ errors: result.error.issues }, 'Kimi response schema validation failed, salvaging');
  const partial = parsed as Record<string, unknown>;
  const summary = typeof partial.summary === 'string' ? partial.summary : 'Review completed (partial parse)';
  const score = typeof partial.score === 'number' ? Math.min(100, Math.max(0, partial.score)) : 50;

  // Try to salvage annotations even if some are invalid
  let annotations: ReviewResult['annotations'] = [];
  if (Array.isArray(partial.annotations)) {
    for (const item of partial.annotations) {
      const parsed = annotationSchema.safeParse(item);
      if (parsed.success) {
        annotations.push(parsed.data);
      }
    }
  }

  const stats: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0, nitpick: 0 };
  for (const a of annotations) {
    stats[a.severity]++;
  }

  return { summary, score, annotations, stats, tokensUsed: tokenUsage };
}
