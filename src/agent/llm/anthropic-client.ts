import { ChatMessage, LLMClient, LLMClientConfig } from './llm-client.js';

/**
 * LLM client for the Anthropic Messages API.
 * Uses the same LLMClientConfig but hits /v1/messages instead of /chat/completions.
 */
export class AnthropicClient implements LLMClient {
  private config: Required<LLMClientConfig>;

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

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
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
