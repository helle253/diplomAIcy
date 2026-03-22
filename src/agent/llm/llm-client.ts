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
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface LLMClient {
  complete(messages: ChatMessage[]): Promise<string>;
  runToolLoop?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    executor: ToolExecutor,
    maxIterations?: number,
    signal?: AbortSignal,
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

import { Agent, setGlobalDispatcher } from 'undici';

import { logger } from '../../util/logger';
import { llmSemaphore } from './semaphore';

// Override undici's default 5-minute headersTimeout which kills long-running
// Ollama requests before our own AbortController timeout fires.
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_REQUEST_TIMEOUT_MS ?? '600000', 10);
setGlobalDispatcher(new Agent({ headersTimeout: LLM_TIMEOUT_MS, bodyTimeout: 0 }));

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

  private async fetchWithRetry(
    url: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const MAX_RETRIES = 2;
    const REQUEST_TIMEOUT_MS = parseInt(process.env.LLM_REQUEST_TIMEOUT_MS ?? '600000', 10);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Bail immediately if externally cancelled (new phase arrived)
      if (signal?.aborted) throw new Error('LLM request cancelled (phase superseded)');

      if (attempt > 0) {
        const baseDelay = Math.min(1000 * Math.pow(2, attempt), 60000);
        const jitter = Math.random() * baseDelay * 0.5;
        await new Promise((r) => setTimeout(r, baseDelay + jitter));
      }

      await llmSemaphore.acquire();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      // Link external signal to internal controller so external abort cancels the fetch
      const onExternalAbort = () => controller.abort();
      signal?.addEventListener('abort', onExternalAbort);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify(body),
          keepalive: true,
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
        // External cancellation — don't retry, propagate immediately
        if (signal?.aborted) throw new Error('LLM request cancelled (phase superseded)');
        // Network errors and timeouts are retryable
        if (err instanceof TypeError) continue;
        if (lastError.name === 'AbortError') continue;
        // Non-retryable errors (4xx except 429) were already thrown above
        if (lastError.message.startsWith('LLM API error')) throw lastError;
        continue;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onExternalAbort);
        llmSemaphore.release();
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
      keep_alive: '60m',
    };

    // Ollama supports num_ctx via options to control context window size
    if (this.numCtx !== undefined) {
      body.options = { num_ctx: this.numCtx };
    }

    const data = (await this.fetchWithRetry(url, body, undefined)) as {
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
    signal?: AbortSignal,
  ): Promise<string> {
    const conversation = [...messages];
    const allText: string[] = [];

    for (let i = 0; i < maxIterations; i++) {
      // Bail if externally cancelled (new phase arrived)
      if (signal?.aborted) {
        logger.info(`[LLM] Tool loop cancelled at iter=${i} (phase superseded)`);
        return allText.join('\n');
      }

      const url = `${this.config.baseUrl}/chat/completions`;
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages: conversation,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        keep_alive: '60m',
      };

      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'required';
      }

      if (this.numCtx !== undefined) {
        body.options = { num_ctx: this.numCtx };
      }

      const response = await this.fetchWithRetry(url, body, signal);
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

      // Log model response
      if (content) {
        const truncated = content.length > 300 ? content.slice(0, 300) + '...' : content;
        logger.debug(`[LLM] iter=${i} text (${content.length} chars): ${truncated}`);
        logger.trace(`[LLM] iter=${i} full response:\n${content}`);
      }

      if (content) allText.push(content);

      // No tool calls — model is done
      if (!toolCalls || toolCalls.length === 0) {
        logger.info(
          `[LLM] iter=${i} no tool calls, ending loop (response: ${content.length} chars)`,
        );
        return allText.join('\n');
      }

      // Log which tools the model chose
      const callSummary = toolCalls
        .map(
          (tc) =>
            `${tc.function.name}(${tc.function.arguments.length > 200 ? tc.function.arguments.slice(0, 200) + '...' : tc.function.arguments})`,
        )
        .join(', ');
      logger.info(`[LLM] iter=${i} tool_calls: ${callSummary}`);

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
          logger.warn(
            `[LLM] Failed to parse tool args for ${tc.function.name}: ${tc.function.arguments}`,
          );
        }

        const result = await executor.execute(tc.function.name, args);
        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        });
      }

      // Check if executor has submitted orders — no need to continue the loop
      if ('hasSubmitted' in executor && (executor as { hasSubmitted: boolean }).hasSubmitted) {
        return allText.join('\n');
      }
    }

    // Max iterations reached — return accumulated content instead of discarding
    logger.warn(`[LLM] Tool loop reached max iterations (${maxIterations})`);
    return allText.join('\n');
  }
}
