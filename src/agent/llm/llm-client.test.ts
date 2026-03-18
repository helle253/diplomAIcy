import { describe, expect, it, vi } from 'vitest';

import type { ToolDefinition, ToolExecutor } from './llm-client';
import { OpenAICompatibleClient } from './llm-client';

describe('OpenAICompatibleClient.runToolLoop', () => {
  it('returns final text when model responds without tool calls', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'Final answer' } }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new OpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'test',
      model: 'test-model',
    });

    const executor: ToolExecutor = {
      execute: vi.fn(),
    };

    const tools: ToolDefinition[] = [];
    const result = await client.runToolLoop([{ role: 'user', content: 'Hello' }], tools, executor);

    expect(result).toBe('Final answer');
    expect(executor.execute).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('executes tool calls and continues the loop', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'getMyUnits', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Done planning' } }],
        }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const client = new OpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'test',
      model: 'test-model',
    });

    const executor: ToolExecutor = {
      execute: vi.fn().mockResolvedValue('[{"province":"lon","type":"Fleet"}]'),
    };

    const result = await client.runToolLoop(
      [{ role: 'user', content: 'Submit orders' }],
      [],
      executor,
    );

    expect(result).toBe('Done planning');
    expect(executor.execute).toHaveBeenCalledWith('getMyUnits', {});
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('terminates when executor signals hasSubmitted', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'submitOrders', arguments: '{"orders":[]}' },
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new OpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'test',
      model: 'test-model',
    });

    const executor: ToolExecutor & { hasSubmitted: boolean } = {
      hasSubmitted: false,
      execute: vi.fn().mockImplementation(async () => {
        executor.hasSubmitted = true;
        return '{"ok":true}';
      }),
    };

    const result = await client.runToolLoop([{ role: 'user', content: 'Go' }], [], executor);

    expect(result).toBe('');
    expect(executor.hasSubmitted).toBe(true);
    vi.unstubAllGlobals();
  });

  it('stops after max iterations', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'getMyUnits', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new OpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'test',
      model: 'test-model',
    });

    const executor: ToolExecutor = {
      execute: vi.fn().mockResolvedValue('[]'),
    };

    // Pass maxIterations=3 to keep test fast
    const result = await client.runToolLoop([{ role: 'user', content: 'Go' }], [], executor, 3);

    expect(result).toBe('');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});
