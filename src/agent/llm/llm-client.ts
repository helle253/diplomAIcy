export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMClient {
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface LLMClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  numCtx?: number;
}

export class OpenAICompatibleClient implements LLMClient {
  private config: Required<Omit<LLMClientConfig, 'numCtx'>>;

  private numCtx?: number;

  constructor(config: LLMClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 2048,
    };
    this.numCtx = config.numCtx;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
    };

    // Ollama supports num_ctx via options to control context window size
    if (this.numCtx) {
      body.options = { num_ctx: this.numCtx };
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
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const err = new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`);
          // Retry on 429 or 5xx
          if (response.status === 429 || response.status >= 500) {
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
          choices?: { message?: { content?: string } }[];
        };

        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error('Unexpected LLM response shape: no choices[0].message.content');
        }

        return content;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Network errors are retryable
        if (err instanceof TypeError) continue;
        // Non-retryable errors (4xx except 429) were already thrown above
        if (lastError.message.startsWith('LLM API error')) throw lastError;
        continue;
      }
    }

    throw lastError ?? new Error('LLM request failed after retries');
  }
}
