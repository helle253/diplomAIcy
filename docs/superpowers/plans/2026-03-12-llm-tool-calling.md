# LLM Tool-Calling Agent Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace prompt-based LLM agents with tool-calling agents that interact with the game via tRPC, and remove the `DiplomacyAgent` interface entirely — all agents become self-contained tRPC clients.

**Architecture:** LLM agents run a multi-turn tool-calling loop where the model queries the map via local tools and submits actions via tRPC mutations directly. RandomAgent becomes a standalone tRPC client. The `DiplomacyAgent` interface, `adapter.ts`, and `remote-adapter.ts` are deleted.

**Tech Stack:** TypeScript, OpenAI-compatible tool calling API (`/v1/chat/completions` with `tools`), tRPC client, vitest

**Spec:** `docs/superpowers/specs/2026-03-12-llm-tool-calling-design.md`

---

## Chunk 1: Tool-Calling LLM Client

### Task 1: Extend ChatMessage types and add tool interfaces

**Files:**
- Modify: `src/agent/llm/llm-client.ts`

- [ ] **Step 1: Write the failing test**

Create `src/agent/llm/llm-client.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleClient } from './llm-client';
import type { ToolDefinition, ToolExecutor } from './llm-client';

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
      isReady: false,
      execute: vi.fn(),
    };

    const tools: ToolDefinition[] = [];
    const result = await client.runToolLoop(
      [{ role: 'user', content: 'Hello' }],
      tools,
      executor,
    );

    expect(result).toBe('Final answer');
    expect(executor.execute).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('executes tool calls and continues the loop', async () => {
    const mockFetch = vi.fn()
      // First response: tool call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'getMyUnits', arguments: '{}' },
              }],
            },
          }],
        }),
      })
      // Second response: final text
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
      isReady: false,
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

  it('terminates when executor signals ready', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'ready', arguments: '{}' },
            }],
          },
        }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new OpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'test',
      model: 'test-model',
    });

    const executor: ToolExecutor = {
      isReady: false,
      execute: vi.fn().mockImplementation(async () => {
        executor.isReady = true;
        return '{"ok":true}';
      }),
    };

    const result = await client.runToolLoop(
      [{ role: 'user', content: 'Go' }],
      [],
      executor,
    );

    expect(result).toBe('');
    expect(executor.isReady).toBe(true);
    vi.unstubAllGlobals();
  });

  it('stops after max iterations', async () => {
    // Model always returns tool calls, never stops
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'getMyUnits', arguments: '{}' },
            }],
          },
        }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new OpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'test',
      model: 'test-model',
    });

    const executor: ToolExecutor = {
      isReady: false,
      execute: vi.fn().mockResolvedValue('[]'),
    };

    // Pass maxIterations=3 to keep test fast
    const result = await client.runToolLoop(
      [{ role: 'user', content: 'Go' }],
      [],
      executor,
      3,
    );

    expect(result).toBe('');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test -- src/agent/llm/llm-client.test.ts`
Expected: FAIL — `runToolLoop` does not exist, `ToolDefinition`/`ToolExecutor` not exported

- [ ] **Step 3: Extend types and implement `runToolLoop`**

In `src/agent/llm/llm-client.ts`, add the following types and extend the class:

```typescript
// Add these type definitions after the existing ChatMessage interface:

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
```

Replace the existing `ChatMessage` interface with the union type above. Add `runToolLoop` to `OpenAICompatibleClient`:

```typescript
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
      choices?: [{
        message?: {
          role?: string;
          content?: string | null;
          tool_calls?: ToolCall[];
        };
      }];
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
        args = JSON.parse(tc.function.arguments);
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
```

Extract the existing fetch+retry logic into a private `fetchWithRetry` method that returns **parsed JSON** (the `response.json()` result). Contract:

```typescript
private async fetchWithRetry(url: string, body: Record<string, unknown>): Promise<unknown>
```

It handles: retry loop (6 attempts), exponential backoff, 429/5xx retries, `retry-after` header, Authorization header. Returns the parsed JSON body on success. Both `complete()` and `runToolLoop()` call this — `complete()` extracts `choices[0].message.content`, `runToolLoop()` extracts `choices[0].message` (which may include `tool_calls`).

Also update the `LLMClient` interface to include `runToolLoop` as an optional method:

```typescript
export interface LLMClient {
  complete(messages: ChatMessage[]): Promise<string>;
  runToolLoop?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    executor: ToolExecutor,
    maxIterations?: number,
  ): Promise<string>;
}
```

This keeps `AnthropicClient` compatible (it doesn't implement `runToolLoop` yet) while allowing `connectToolAgent` to type-check against the interface.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test -- src/agent/llm/llm-client.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `yarn test`
Expected: All existing tests pass

- [ ] **Step 6: Commit**

```bash
git add src/agent/llm/llm-client.ts src/agent/llm/llm-client.test.ts
git commit -m "feat: add tool-calling agent loop to OpenAICompatibleClient"
```

---

## Chunk 2: Game Tool Executor

### Task 2: Create tool definitions and GameToolExecutor

**Files:**
- Create: `src/agent/llm/tools.ts`
- Create: `src/agent/llm/tools.test.ts`

- [ ] **Step 1: Write the failing test for map query tools**

Create `src/agent/llm/tools.test.ts` with tests for `getMyUnits`, `getAdjacentProvinces`, `getProvinceInfo`, `getSupplyCenterCounts`, `getPhaseInfo`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { Power, UnitType } from '../../engine/types';
import { GameToolExecutor } from './tools';

// Helper: minimal game state for testing
function makeState(overrides = {}) {
  return {
    phase: { season: 'Spring', year: 1901, type: 'Orders' },
    units: [
      { type: UnitType.Fleet, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'edi' },
      { type: UnitType.Army, power: Power.England, province: 'lvp' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
    ],
    supplyCenters: new Map([
      ['lon', Power.England], ['edi', Power.England], ['lvp', Power.England],
      ['par', Power.France], ['bre', Power.France], ['mar', Power.France],
    ]),
    orderHistory: [],
    retreatSituations: [],
    endYear: 1910,
    ...overrides,
  };
}

// Mock tRPC client (action tools test it separately)
const mockClient = {} as any;

describe('GameToolExecutor - map query tools', () => {
  it('getMyUnits returns only this power\'s units', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getMyUnits', {}));
    expect(result).toHaveLength(3);
    expect(result.map((u: any) => u.province).sort()).toEqual(['edi', 'lon', 'lvp']);
  });

  it('getAdjacentProvinces returns army adjacencies', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getAdjacentProvinces', {
      province: 'lon', unitType: 'Army',
    }));
    expect(result).toContain('wal');
    expect(result).toContain('yor');
    expect(result).not.toContain('nth'); // sea — army can't go there
  });

  it('getAdjacentProvinces returns fleet adjacencies', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getAdjacentProvinces', {
      province: 'lon', unitType: 'Fleet',
    }));
    expect(result).toContain('nth');
    expect(result).toContain('eng');
    expect(result).toContain('wal');
    expect(result).toContain('yor');
  });

  it('getAdjacentProvinces returns error for invalid province', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getAdjacentProvinces', {
      province: 'xyz',
    }));
    expect(result.error).toContain('xyz');
  });

  it('getProvinceInfo returns full province data', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getProvinceInfo', { province: 'lon' }));
    expect(result.name).toBe('London');
    expect(result.type).toBe('Coastal');
    expect(result.supplyCenter).toBe(true);
    expect(result.owner).toBe('England');
    expect(result.unit).toMatchObject({ type: 'Fleet', power: 'England' });
  });

  it('getSupplyCenterCounts returns per-power counts', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getSupplyCenterCounts', {}));
    expect(result.England).toBe(3);
    expect(result.France).toBe(3);
    expect(result.neutral).toBeGreaterThan(0);
  });

  it('getPhaseInfo returns phase details', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getPhaseInfo', {}));
    expect(result.season).toBe('Spring');
    expect(result.year).toBe(1901);
    expect(result.type).toBe('Orders');
    expect(result.endYear).toBe(1910);
  });

  it('getRetreatOptions returns dislodged units for this power', async () => {
    const state = makeState({
      retreatSituations: [
        {
          unit: { type: UnitType.Army, power: Power.England, province: 'lon' },
          attackedFrom: 'wal',
          validDestinations: ['yor'],
        },
        {
          unit: { type: UnitType.Army, power: Power.France, province: 'par' },
          attackedFrom: 'bur',
          validDestinations: ['pic', 'gas'],
        },
      ],
    });
    const exec = new GameToolExecutor(mockClient, state, Power.England);
    const result = JSON.parse(await exec.execute('getRetreatOptions', {}));
    expect(result).toHaveLength(1);
    expect(result[0].unit.province).toBe('lon');
    expect(result[0].validDestinations).toEqual(['yor']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test -- src/agent/llm/tools.test.ts`
Expected: FAIL — `GameToolExecutor` does not exist

- [ ] **Step 3: Implement GameToolExecutor with map query tools**

Create `src/agent/llm/tools.ts`. Implement the `GameToolExecutor` class with all map query tools (`getMyUnits`, `getAdjacentProvinces`, `getProvinceInfo`, `getSupplyCenterCounts`, `getPhaseInfo`, `getRetreatOptions`). Each tool reads from `PROVINCES` (imported from `../../engine/map`) and the `GameState` passed to the constructor.

Also export the `TOOL_DEFINITIONS` array — the JSON Schema definitions for each tool, used by `runToolLoop`. Include tool definitions for all tools (map queries + actions + `ready`).

The executor's `execute` method is a switch/dispatch on tool name. Unknown tools return `{"error": "Unknown tool: <name>"}`.

- [ ] **Step 4: Run test to verify map query tools pass**

Run: `yarn test -- src/agent/llm/tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/llm/tools.ts src/agent/llm/tools.test.ts
git commit -m "feat: add GameToolExecutor with map query tools"
```

### Task 3: Add action tools to GameToolExecutor

**Files:**
- Modify: `src/agent/llm/tools.ts`
- Modify: `src/agent/llm/tools.test.ts`

- [ ] **Step 1: Write failing tests for action tools**

Add tests to `tools.test.ts` for `submitOrders`, `submitRetreats`, `submitBuilds`, `sendMessage`, and `ready`. Mock the tRPC client mutations:

```typescript
describe('GameToolExecutor - action tools', () => {
  function makeMockClient() {
    return {
      game: {
        submitOrders: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        submitRetreats: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        submitBuilds: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        sendMessage: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        submitReady: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      },
    } as any;
  }

  it('submitOrders calls tRPC mutation with converted orders', async () => {
    const client = makeMockClient();
    const exec = new GameToolExecutor(client, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('submitOrders', {
      orders: [
        { unit: 'lon', type: 'Hold' },
        { unit: 'edi', type: 'Move', destination: 'nth' },
        { unit: 'lvp', type: 'Support', supportedUnit: 'edi', destination: 'nth' },
      ],
    }));
    expect(result.ok).toBe(true);
    expect(client.game.submitOrders.mutate).toHaveBeenCalledOnce();
  });

  it('submitOrders returns error for invalid order type', async () => {
    const client = makeMockClient();
    const exec = new GameToolExecutor(client, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('submitOrders', {
      orders: [{ unit: 'lon', type: 'InvalidType' }],
    }));
    expect(result.error).toBeDefined();
  });

  it('sendMessage calls tRPC mutation', async () => {
    const client = makeMockClient();
    const exec = new GameToolExecutor(client, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('sendMessage', {
      to: 'France',
      content: 'Shall we ally?',
    }));
    expect(result.ok).toBe(true);
    expect(client.game.sendMessage.mutate).toHaveBeenCalledWith({
      to: 'France',
      content: 'Shall we ally?',
    });
  });

  it('ready calls submitReady and sets isReady', async () => {
    const client = makeMockClient();
    const exec = new GameToolExecutor(client, makeState(), Power.England);
    expect(exec.isReady).toBe(false);
    await exec.execute('ready', {});
    expect(exec.isReady).toBe(true);
    expect(client.game.submitReady.mutate).toHaveBeenCalledOnce();
  });

  it('submitRetreats converts to proper discriminated union', async () => {
    const client = makeMockClient();
    const state = makeState({
      retreatSituations: [{
        unit: { type: UnitType.Army, power: Power.England, province: 'lon' },
        attackedFrom: 'wal',
        validDestinations: ['yor'],
      }],
    });
    const exec = new GameToolExecutor(client, state, Power.England);
    const result = JSON.parse(await exec.execute('submitRetreats', {
      retreats: [{ unit: 'lon', destination: 'yor' }],
    }));
    expect(result.ok).toBe(true);
    expect(client.game.submitRetreats.mutate).toHaveBeenCalledOnce();
  });

  it('submitRetreats converts missing destination to Disband', async () => {
    const client = makeMockClient();
    const exec = new GameToolExecutor(client, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('submitRetreats', {
      retreats: [{ unit: 'lon' }],
    }));
    expect(result.ok).toBe(true);
    const args = client.game.submitRetreats.mutate.mock.calls[0][0];
    expect(args.retreats[0].type).toBe('Disband');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test -- src/agent/llm/tools.test.ts`
Expected: FAIL — action tool methods not implemented

- [ ] **Step 3: Implement action tools**

Add `submitOrders`, `submitRetreats`, `submitBuilds`, `sendMessage`, and `ready` to the executor's `execute` dispatch. Each:
1. Validates arguments (province exists, order type is valid for fields provided)
2. Converts flat tool schema to discriminated union types expected by tRPC
3. Calls the tRPC mutation
4. Returns `{"ok": true}` or `{"error": "..."}` with a clear message

For `submitOrders`, convert from flat `{unit, type, destination?, ...}` to the discriminated union:
- `type: "Hold"` → `{ type: "Hold", unit }`
- `type: "Move"` → `{ type: "Move", unit, destination, coast?, viaConvoy? }`
- `type: "Support"` → `{ type: "Support", unit, supportedUnit, destination? }`
- `type: "Convoy"` → `{ type: "Convoy", unit, convoyedUnit, destination }`

For `submitRetreats`, convert:
- `destination` present → `{ type: "RetreatMove", unit, destination, coast? }`
- `destination` absent → `{ type: "Disband", unit }`

For `submitBuilds`, pass through (already matches the tRPC schema).

Wrap all tRPC calls in try/catch — if the mutation throws (e.g., phase ended), return the error message.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test -- src/agent/llm/tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/llm/tools.ts src/agent/llm/tools.test.ts
git commit -m "feat: add action tools (submitOrders, sendMessage, ready) to GameToolExecutor"
```

---

## Chunk 3: Tool Agent Entry Point

### Task 4: Create `connectToolAgent`

**Files:**
- Create: `src/agent/llm/tool-agent.ts`

This is the self-contained tRPC client for LLM agents. It subscribes to phase changes and messages, manages the work queue, and runs tool-calling loops.

- [ ] **Step 1: Implement `connectToolAgent`**

Create `src/agent/llm/tool-agent.ts`. Extract the work queue pattern from `src/agent/remote/remote-adapter.ts` (phase prioritization, message batching, stagger). Key differences from the remote adapter:

- No `DiplomacyAgent` — the tool loop IS the agent
- Phase handler creates a `GameToolExecutor` with the tRPC client, runs `llm.runToolLoop()`, and is done — orders/messages/ready are submitted inside the loop
- Message handler starts a new tool loop with pending messages in the opening prompt
- The `deserializeGameState` function is reused from `remote/deserialize.ts`

```typescript
export async function connectToolAgent(
  client: GameClient,
  llm: LLMClient,
  power: Power,
  lobbyId: string,
): Promise<{ unsubscribe: () => void }>;
```

Internal structure:
1. Fetch initial state, build system prompt
2. Subscribe to `onPhaseChange` — enqueue phase work items
3. Subscribe to `onMessage` — batch and enqueue message work items
4. `drainWorkQueue` processes items sequentially:
   - Phase item: build user message with phase context + last turn results, create `GameToolExecutor`, filter tools by phase type, run `llm.runToolLoop()`
   - Message item: build user message with pending messages, create `GameToolExecutor`, run tool loop (model can send replies, revise orders)
5. Phase stagger and catch-up logic (same as remote-adapter)

The system prompt is built once at init (from `buildSystemPrompt` in `prompts.ts`). The user message is built per-loop from a new `buildTurnPrompt` function in `prompts.ts`.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/agent/llm/tool-agent.ts
git commit -m "feat: add connectToolAgent — self-contained tRPC tool-calling agent"
```

### Task 5: Simplify prompts for tool-calling flow

**Files:**
- Modify: `src/agent/llm/prompts.ts`

- [ ] **Step 1: Add `buildTurnPrompt` function**

Add a new `buildTurnPrompt(state, power, pendingMessages, phaseContext)` function that builds the opening user message for each tool loop. This replaces the phase-specific prompt builders (`buildOrdersPrompt`, `buildRetreatsPrompt`, `buildBuildsPrompt`). It includes:

- Phase/year/season
- Situational context ("You have N units and M supply centers")
- Last turn results (if any)
- Pending diplomatic messages (if any)
- Phase-specific instructions ("Use getMyUnits to see your units and getAdjacentProvinces to plan. Submit orders with submitOrders, then call ready().")

Keep `buildSystemPrompt` but simplify: remove province abbreviation list, remove JSON schema examples, add tool usage guidance.

Keep `serializeGameState` (used for context in the turn prompt) but remove the adjacency additions from the earlier fix (tools handle that now).

Do NOT delete the old prompt builders yet — they're still imported by `llm-agent.ts` which hasn't been deleted yet.

- [ ] **Step 2: Run type check and tests**

Run: `npx tsc --noEmit && yarn test`
Expected: All pass — old code still compiles, new function is additive

- [ ] **Step 3: Commit**

```bash
git add src/agent/llm/prompts.ts
git commit -m "feat: add buildTurnPrompt for tool-calling agent loops"
```

### Task 6: Wire `connectToolAgent` into the CLI entry point

**Files:**
- Modify: `src/agent/remote/run.ts`

- [ ] **Step 1: Update `run.ts` to use `connectToolAgent` for LLM agents**

In the `main()` function, replace the LLM path:

```typescript
// Before:
const client = createLLMClient(cfg);
agent = new LLMAgent(power, client);
// ...
await connectRemoteAgent(agent, trpcClient, lobbyId);

// After:
if (cfg.type === 'llm') {
  const llmClient = createLLMClient(cfg);
  await connectToolAgent(trpcClient, llmClient, power, lobbyId);
} else {
  const agent = new RandomAgent(power);
  await connectRemoteAgent(agent, trpcClient, lobbyId);
}
```

The lobby join + wait-for-ready logic stays the same.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/agent/remote/run.ts
git commit -m "feat: wire connectToolAgent into CLI for LLM agents"
```

---

## Chunk 4: Convert RandomAgent to tRPC Client

### Task 7: Create `connectRandomAgent`

**Files:**
- Create: `src/agent/random-agent.ts`
- Create: `src/agent/random-agent.test.ts`

- [ ] **Step 1: Write failing test**

Test that `connectRandomAgent` submits valid random orders when a phase fires. Use a mock tRPC client that records mutations.

- [ ] **Step 2: Implement `connectRandomAgent`**

Create `src/agent/random-agent.ts` as a self-contained tRPC client. Extract the random order generation logic from the existing `src/agent/random.ts` into pure functions (they don't depend on the `DiplomacyAgent` interface — they just need `GameState` and `Power`).

Structure:
```typescript
export async function connectRandomAgent(
  client: GameClient,
  power: Power,
  lobbyId: string,
): Promise<{ unsubscribe: () => void }>;
```

Same work queue pattern as `connectToolAgent` but simpler — no LLM loop, just:
1. Subscribe to phase changes
2. On Orders: generate random valid orders, call `client.game.submitOrders.mutate()`
3. On Retreats: pick random valid retreats, call `client.game.submitRetreats.mutate()`
4. On Builds: pick random builds, call `client.game.submitBuilds.mutate()`
5. Call `client.game.submitReady.mutate()` after actions
6. On messages: ignore (random agent doesn't negotiate)

Reuse the order generation helpers from `random.ts` — extract them as standalone functions that take `GameState` + `Power` and return orders.

- [ ] **Step 3: Run test to verify it passes**

Run: `yarn test -- src/agent/random-agent.test.ts`
Expected: PASS

- [ ] **Step 4: Update `run.ts` to use `connectRandomAgent`**

Replace the `RandomAgent` + `connectRemoteAgent` path:

```typescript
if (cfg.type === 'llm') {
  const llmClient = createLLMClient(cfg);
  await connectToolAgent(trpcClient, llmClient, power, lobbyId);
} else {
  await connectRandomAgent(trpcClient, power, lobbyId);
}
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/random-agent.ts src/agent/random-agent.test.ts src/agent/remote/run.ts
git commit -m "feat: convert RandomAgent to self-contained tRPC client"
```

---

## Chunk 5: Update Server and Delete Legacy Code

### Task 8: Update `server.ts` to use tRPC agents

**Files:**
- Modify: `src/ui/server.ts`

- [ ] **Step 1: Update in-process agent wiring**

Replace the `connectAgent(agent, manager)` pattern in `server.ts` with tRPC client connections to localhost. For each non-remote power:

```typescript
// Create a tRPC client to self (localhost)
const internalClient = createGameClient(`http://localhost:${port}/trpc`);
// Join lobby to get seat token
const { seatToken } = await internalClient.lobby.join.mutate({ lobbyId: id, power });
const authedClient = createGameClient(`http://localhost:${port}/trpc`, seatToken);

if (agentCfg.type === 'llm') {
  if (agentCfg.provider === 'anthropic') {
    throw new Error('Anthropic provider does not support tool calling yet. Use openai provider with Ollama or another OpenAI-compatible API.');
  }
  const llmClient = new OpenAICompatibleClient(toLLMClientConfig(agentCfg));
  await connectToolAgent(authedClient, llmClient, power, id);
} else {
  await connectRandomAgent(authedClient, power, id);
}
```

**Timing note:** `lobbyManager.onStart()` fires after the server is already listening (the lobby is created via an HTTP request, so the server must be up). The tRPC self-connect is safe. Verify this during testing — if there's a race, defer agent connection to `setImmediate(() => ...)`.

Remove imports of `connectAgent`, `DiplomacyAgent`, `LLMAgent`, `RandomAgent`, `AnthropicClient`.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run `yarn play:random` to verify random agents work in-process**

Run: `MAX_YEARS=1 yarn play:random`
Expected: Game completes 1 year with random agents

- [ ] **Step 4: Commit**

```bash
git add src/ui/server.ts
git commit -m "feat: update server to use tRPC-based agents"
```

### Task 9: Update `manager.test.ts`

**Files:**
- Modify: `src/game/manager.test.ts`

- [ ] **Step 1: Update test agents**

The test file defines inline `HoldAgent` implementing `DiplomacyAgent`, and uses `connectAgent` to wire them to the GameManager. These tests verify GameManager behavior (phase progression, order resolution), not agent behavior.

Replace `connectAgent` with a simple inline helper that wires `manager.onPhaseChange` directly:

```typescript
function wireHoldAgent(manager: GameManager, power: Power) {
  manager.onPhaseChange(async (phase, state) => {
    if (phase.type === PhaseType.Orders) {
      const orders = state.units
        .filter(u => u.power === power)
        .map(u => ({ type: OrderType.Hold, unit: u.province }));
      manager.submitOrders(power, orders);
    } else if (phase.type === PhaseType.Retreats) {
      const retreats = state.retreatSituations
        .filter(s => s.unit.power === power)
        .map(s => ({ type: 'Disband' as const, unit: s.unit.province }));
      manager.submitRetreats(power, retreats);
    } else if (phase.type === PhaseType.Builds) {
      const buildCount = manager.getBuildCount(power);
      if (buildCount > 0) {
        manager.submitBuilds(power, Array.from({ length: buildCount }, () => ({ type: 'Waive' as const })));
      } else if (buildCount < 0) {
        const myUnits = state.units.filter(u => u.power === power);
        manager.submitBuilds(power, myUnits.slice(-Math.abs(buildCount)).map(u => ({ type: 'Remove' as const, unit: u.province })));
      }
    }
  });
}
```

This uses the GameManager API directly — no `DiplomacyAgent` interface needed. The `onPhaseChange` callback already exists on GameManager and is what `connectAgent` used internally.

- [ ] **Step 2: Run tests**

Run: `yarn test -- src/game/manager.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/game/manager.test.ts
git commit -m "refactor: update manager tests to use direct API instead of DiplomacyAgent"
```

### Task 10: Delete legacy agent code

**Files:**
- Delete: `src/agent/interface.ts`
- Delete: `src/agent/adapter.ts`
- Delete: `src/agent/remote/remote-adapter.ts`
- Delete: `src/agent/llm/llm-agent.ts`
- Delete: `src/agent/llm/order-parser.ts`
- Delete: `src/agent/random.ts`
- Delete: `src/agent/random.test.ts`
- Delete: `src/agent/llm/llm-agent.test.ts`
- Modify: `src/agent/llm/prompts.ts` — remove old prompt builders that are no longer imported

- [ ] **Step 1: Delete the files**

```bash
rm src/agent/interface.ts
rm src/agent/adapter.ts
rm src/agent/remote/remote-adapter.ts
rm src/agent/llm/llm-agent.ts
rm src/agent/llm/order-parser.ts
rm src/agent/random.ts
rm src/agent/random.test.ts
rm src/agent/llm/llm-agent.test.ts
```

- [ ] **Step 2: Clean up remaining imports**

Remove any dangling imports of deleted modules from remaining files. Run `npx tsc --noEmit` and fix any errors.

Remove the old prompt builders from `prompts.ts` (`buildOrdersPrompt`, `buildRetreatsPrompt`, `buildBuildsPrompt`, `buildNegotiationPrompt`, `buildBatchNegotiationPrompt`) and the adjacency code added earlier. Keep `buildSystemPrompt`, `buildTurnPrompt`, `serializeGameState`, and message formatting helpers.

- [ ] **Step 3: Run full test suite**

Run: `yarn test`
Expected: All tests pass. Test count will be lower (deleted old agent tests, replaced with new ones).

- [ ] **Step 4: Run type check and lint**

Run: `npx tsc --noEmit && yarn lint`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove DiplomacyAgent interface and legacy agent code

All agents are now self-contained tRPC clients. Deleted:
- DiplomacyAgent interface
- adapter.ts (in-process bridge)
- remote-adapter.ts (remote bridge)
- LLMAgent class (replaced by connectToolAgent)
- RandomAgent class (replaced by connectRandomAgent)
- order-parser.ts (tools provide structured input)"
```

---

## Chunk 6: Integration Test

### Task 11: Run Ollama integration test

- [ ] **Step 1: Build**

Run: `yarn build`
Expected: Clean build

- [ ] **Step 2: Run a short integration game**

Use the integration-test skill to run a 2-year game with Ollama agents. Verify:
- Agents connect and submit orders via tool calling
- Orders are valid (units move to adjacent provinces)
- Messages are sent between agents
- Game progresses through phases
- No crashes or unhandled errors

- [ ] **Step 3: Compare with pre-refactor behavior**

Check agent notes in `game-notes/` for:
- Fewer invalid/Hold orders (map queries prevent illegal moves)
- Agents demonstrating strategic reasoning via tool call sequences
- Successful diplomatic message exchange

- [ ] **Step 4: Commit any fixes**

If issues are found during integration testing, fix and commit incrementally.
