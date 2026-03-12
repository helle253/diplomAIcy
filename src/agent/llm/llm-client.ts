export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolExecutor {
  isReady: boolean;
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface LLMClient {
  complete(messages: ChatMessage[]): Promise<string>;
  runToolLoop?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    executor: ToolExecutor,
    maxIterations?: number,
  ): Promise<string>;
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

  private async fetchWithRetry(url: string, body: Record<string, unknown>): Promise<unknown> {
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

        return await response.json();
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

    const data = (await this.fetchWithRetry(url, body)) as {
      choices?: { message?: { content?: string } }[];
    };

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Unexpected LLM response shape: no choices[0].message.content');
    }

    return content;
  }

  async runToolLoop(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    executor: ToolExecutor,
    maxIterations = 30,
  ): Promise<string> {
    const conversation = [...messages];

    for (let i = 0; i < maxIterations; i++) {
      const url = `${this.config.baseUrl}/chat/completions`;
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages: conversation,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      };

      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      if (this.numCtx) {
        body.options = { num_ctx: this.numCtx };
      }

      const response = await this.fetchWithRetry(url, body);
      const data = response as {
        choices?: [
          {
            message?: {
              role?: string;
              content?: string | null;
              tool_calls?: ToolCall[];
            };
          },
        ];
      };

      const assistantMsg = data.choices?.[0]?.message;
      if (!assistantMsg) {
        throw new Error('Unexpected LLM response shape: no choices[0].message');
      }

      const content = assistantMsg.content ?? '';
      const toolCalls = assistantMsg.tool_calls;

      // No tool calls — model is done
      if (!toolCalls || toolCalls.length === 0) {
        return content;
      }

      // Append assistant message with tool calls
      conversation.push({
        role: 'assistant',
        content,
        tool_calls: toolCalls,
      });

      // Execute each tool call
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          // If args can't be parsed, pass empty object
        }

        const result = await executor.execute(tc.function.name, args);
        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        });
      }

      // Check if executor is ready (model called ready() tool)
      if (executor.isReady) {
        return content;
      }
    }

    // Max iterations reached
    return '';
  }
}
