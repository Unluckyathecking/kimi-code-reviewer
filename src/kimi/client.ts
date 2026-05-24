import type { ChatMessage } from '../types/review.js';
import { KimiApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface KimiClientConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens?: number;
  };
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicTextBlock[];
  model: string;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const USER_AGENT =
  'kimi-code-reviewer/0.1.0 (github-action; +https://github.com/Unluckyathecking/kimi-code-reviewer)';

export class KimiClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private timeout: number;

  constructor(config: KimiClientConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'kimi-for-coding';
    this.baseUrl = config.baseUrl ?? process.env.KIMI_BASE_URL ?? 'https://api.kimi.com/coding/v1';
    this.maxTokens = config.maxTokens ?? 16384;
    this.temperature = config.temperature ?? 1;
    this.timeout = config.timeout ?? 300_000;
  }

  async chatCompletion(params: {
    messages: ChatMessage[];
    responseFormat?: { type: 'json_object' | 'text' };
  }): Promise<ChatCompletionResponse> {
    const { system, conversation } = splitSystemMessages(params.messages);

    if (conversation.length === 0) {
      throw new KimiApiError('No non-system messages to send', 400);
    }
    if (conversation[0].role !== 'user') {
      throw new KimiApiError(
        `First non-system message must be from 'user' (got '${conversation[0].role}')`,
        400,
      );
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: conversation.map((m) => ({ role: m.role, content: m.content })),
    };
    if (system) {
      body.system = system;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'anthropic-version': '2023-06-01',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        throw new KimiApiError(
          `Kimi API error: ${res.status} ${res.statusText}`,
          res.status,
          errorBody,
        );
      }

      const data = (await res.json()) as AnthropicResponse;
      const text = data.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      const inputTokens = data.usage.input_tokens ?? 0;
      const outputTokens = data.usage.output_tokens ?? 0;
      const cachedTokens = data.usage.cache_read_input_tokens ?? 0;

      logger.info(
        {
          model: this.model,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          cachedTokens,
          stopReason: data.stop_reason,
        },
        'Kimi API call completed',
      );

      return {
        id: data.id,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: data.stop_reason ?? 'stop',
          },
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cached_tokens: cachedTokens,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function splitSystemMessages(messages: ChatMessage[]): {
  system: string;
  conversation: ChatMessage[];
} {
  const systemParts: string[] = [];
  const conversation: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else {
      conversation.push(m);
    }
  }
  return { system: systemParts.join('\n\n'), conversation };
}
