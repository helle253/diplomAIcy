import { logger } from '../../util/logger';
import {
  ChatMessage,
  LLMClient,
  LLMClientConfig,
  ToolDefinition,
  ToolExecutor,
} from './llm-client';

/** Anthropic tool_use content block shape. */
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Anthropic text content block shape. */
interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

/** Anthropic tool_result content block shape. */
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

/** A message in the Anthropic conversation format. */
type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | (AnthropicContentBlock | AnthropicToolResultBlock)[];
};

/** Shape of the Anthropic Messages API response. */
interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

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

  private async fetchWithRetry(body: Record<string, unknown>): Promise<AnthropicResponse> {
    const url = `${this.config.baseUrl}/v1/messages`;
    const MAX_RETRIES = 6;
    const REQUEST_TIMEOUT_MS = parseInt(process.env.LLM_REQUEST_TIMEOUT_MS ?? '600000', 10);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const baseDelay = Math.min(1000 * Math.pow(2, attempt), 60000);
        const jitter = Math.random() * baseDelay * 0.5;
        await new Promise((r) => setTimeout(r, baseDelay + jitter));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          signal: controller.signal,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const err = new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
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

        return (await response.json()) as AnthropicResponse;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof TypeError) continue;
        if (lastError.name === 'AbortError') continue;
        if (lastError.message.startsWith('Anthropic API error')) throw lastError;
        continue;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new Error('Anthropic request failed after retries');
  }

  async complete(messages: ChatMessage[]): Promise<string> {
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

    const data = await this.fetchWithRetry(body);

    const textBlock = data.content?.find((b): b is AnthropicTextBlock => b.type === 'text');
    if (!textBlock?.text) {
      throw new Error('Unexpected Anthropic response: no text content block');
    }

    return textBlock.text;
  }

  async runToolLoop(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    executor: ToolExecutor,
    maxIterations = 30,
  ): Promise<string> {
    // Convert ChatMessage[] to Anthropic conversation format
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
    const conversation: AnthropicMessage[] = nonSystemMsgs.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content as string,
    }));

    // Convert OpenAI-format tool definitions to Anthropic format
    const anthropicTools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));

    const allText: string[] = [];

    for (let i = 0; i < maxIterations; i++) {
      const body: Record<string, unknown> = {
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
        messages: conversation,
      };

      if (systemMsg) {
        body.system = systemMsg.content;
      }

      if (anthropicTools.length > 0) {
        body.tools = anthropicTools;
        body.tool_choice = { type: 'any' };
      }

      const data = await this.fetchWithRetry(body);

      if (!data.content || data.content.length === 0) {
        return '';
      }

      // Extract text and tool_use blocks from response
      const textBlocks = data.content.filter((b): b is AnthropicTextBlock => b.type === 'text');
      const toolUseBlocks = data.content.filter(
        (b): b is AnthropicToolUseBlock => b.type === 'tool_use',
      );
      const textContent = textBlocks.map((b) => b.text).join('');

      // Log model response text (truncated)
      if (textContent) {
        const truncated =
          textContent.length > 300 ? textContent.slice(0, 300) + '...' : textContent;
        logger.debug(`[LLM] iter=${i} text: ${truncated}`);
      }

      if (textContent) allText.push(textContent);

      // No tool calls — model is done
      if (toolUseBlocks.length === 0) {
        logger.debug(`[LLM] iter=${i} no tool calls, ending loop`);
        return allText.join('\n');
      }

      // Log which tools the model chose
      const callSummary = toolUseBlocks
        .map((tb) => `${tb.name}(${JSON.stringify(tb.input).slice(0, 100)})`)
        .join(', ');
      logger.debug(`[LLM] iter=${i} tool_calls: ${callSummary}`);

      // Append assistant message with full content blocks
      conversation.push({ role: 'assistant', content: data.content });

      // Execute each tool call and build tool_result blocks
      const toolResults: AnthropicToolResultBlock[] = [];
      for (const toolUse of toolUseBlocks) {
        const result = await executor.execute(toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Append tool results as a user message
      conversation.push({ role: 'user', content: toolResults });

      // Check if executor is ready (model called ready() tool)
      if (executor.isReady) {
        return allText.join('\n');
      }
    }

    // Max iterations reached
    logger.warn(`[LLM] Tool loop reached max iterations (${maxIterations})`);
    return allText.join('\n');
  }
}
