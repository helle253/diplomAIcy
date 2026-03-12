import { ChatMessage, LLMClient, LLMClientConfig } from './llm-client';

/**
 * LLM client for the Anthropic Messages API.
 * Uses the same LLMClientConfig but hits /v1/messages instead of /chat/completions.
 */
export class AnthropicClient implements LLMClient {
  private config: Required<Omit<LLMClientConfig, 'numCtx'>>;

  constructor(config: LLMClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 2048,
    };
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const url = `${this.config.baseUrl}/v1/messages`;

    // Separate system message from the rest
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }

    const MAX_RETRIES = 6;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const baseDelay = Math.min(1000 * Math.pow(2, attempt), 60000);
        const jitter = Math.random() * baseDelay * 0.5;
        await new Promise((r) => setTimeout(r, baseDelay + jitter));
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const err = new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
          if (response.status === 429 || response.status >= 500) {
            // Respect retry-after header if present
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter && attempt < MAX_RETRIES - 1) {
              const waitMs = parseInt(retryAfter, 10) * 1000;
              if (waitMs > 0 && waitMs <= 120000) {
                await new Promise((r) => setTimeout(r, waitMs));
              }
            }
            lastError = err;
            continue;
          }
          throw err;
        }

        const data = (await response.json()) as {
          content?: { type: string; text?: string }[];
        };

        const textBlock = data.content?.find((b) => b.type === 'text');
        if (!textBlock?.text) {
          throw new Error('Unexpected Anthropic response: no text content block');
        }

        return textBlock.text;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof TypeError) continue;
        if (lastError.message.startsWith('Anthropic API error')) throw lastError;
        continue;
      }
    }

    throw lastError ?? new Error('Anthropic request failed after retries');
  }
}
