# LLM Agent Tool-Calling Design

Replace the current prompt-based LLM agent with a tool-calling agent that connects directly to the game server as a first-class remote tRPC client. The model queries the game world through tools and takes actions (orders, messages) via tool calls that hit the tRPC API directly.

## Motivation

The current approach requires the model to:
1. Hold the full game state in context (province list, adjacencies, unit positions)
2. Produce valid JSON arrays matching specific schemas
3. Know map topology from training data alone (adjacencies are never provided)

This fails badly with smaller models (e.g., qwen2.5:7b) — they produce illegal moves (Edinburgh to Wales), malformed JSON, and waste context window on static map data. Tool calling fixes all three: the model queries only what it needs, takes actions through structured tool calls, and never has to produce free-form JSON.

## Key Design Decision: Remote Agents Are First-Class

The `DiplomacyAgent` interface and its adapters (`adapter.ts`, `remote-adapter.ts`) exist for in-process agents like `RandomAgent`. LLM agents don't use them. Instead, an LLM agent is a self-contained tRPC client that:

- Subscribes to phase changes and messages via SSE
- Queries game state via tRPC queries
- Submits orders, retreats, builds, and messages via tRPC mutations
- Runs a tool-calling loop as its "brain"

This means Claude subagents, Ollama agents, and future human players all use the exact same tRPC API. No special interfaces, no adapter gymnastics.

## Architecture

### Tool-Calling LLM Client

Extend `LLMClient` with a tool-calling agent loop:

```typescript
interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

interface ToolExecutor {
  execute(name: string, args: Record<string, unknown>): Promise<string>;
  isReady: boolean;
}

interface LLMClient {
  complete(messages: ChatMessage[]): Promise<string>;
  runToolLoop(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    executor: ToolExecutor,
  ): Promise<string>;
}
```

The loop:
1. Send messages + tool definitions to `/v1/chat/completions` with `tool_choice: "auto"`
2. If response contains `tool_calls`, execute each via the executor
3. Append assistant message (with tool_calls) and tool result messages to conversation
4. Repeat from step 1
5. When the executor signals `isReady` (model called `ready()` tool), or max iterations (30) reached, return the model's final text
6. If the model returns a plain text response with no tool calls and no actions have been taken, treat as a no-op turn (server defaults unsubmitted orders to Hold)

### ChatMessage Type Extension

```typescript
interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
```

### Game Tools

**Map Query Tools** (read from `PROVINCES` locally — no server round-trip):

| Tool | Parameters | Returns |
|------|-----------|---------|
| `getAdjacentProvinces` | `province: string`, `unitType?: "Army" \| "Fleet"` | Array of reachable province IDs. If unitType omitted, returns union. For multi-coast provinces with a fleet, includes coast-specific adjacencies. |
| `getProvinceInfo` | `province: string` | `{ name, type, supplyCenter, homeCenter, owner, unit, coasts }` |
| `getMyUnits` | _(none)_ | Array of `{ province, type, coast? }` — unit positions only |
| `getSupplyCenterCounts` | _(none)_ | Per-power SC count, plus neutral count |
| `getPhaseInfo` | _(none)_ | `{ season, year, type, endYear }` |
| `getRetreatOptions` | _(none)_ | Array of `{ unit, attackedFrom, validDestinations }` for this power's dislodged units. Only available during Retreats phase. |

**Action Tools** (call tRPC mutations directly):

| Tool | Parameters | Returns | tRPC call |
|------|-----------|---------|-----------|
| `submitOrders` | `orders: Array<{ unit, type, destination?, supportedUnit?, convoyedUnit?, coast?, viaConvoy? }>` | `{ ok: true }` or `{ error: "..." }`. Can be called multiple times; server accepts the latest. | `client.game.submitOrders.mutate()` |
| `submitRetreats` | `retreats: Array<{ unit, destination?, coast? }>` | `{ ok: true }` or `{ error: "..." }`. Units without destination are disbanded. | `client.game.submitRetreats.mutate()` |
| `submitBuilds` | `builds: Array<{ type: "Build" \| "Remove" \| "Waive", unitType?, province?, coast? }>` | `{ ok: true }` or `{ error: "..." }` | `client.game.submitBuilds.mutate()` |
| `sendMessage` | `to: string \| string[]`, `content: string` | `{ ok: true }`. `to` can be a power name, array of powers, or "Global". | `client.game.sendMessage.mutate()` |
| `ready` | _(none)_ | Signals the agent is done thinking. Ends the tool loop. | `client.game.submitReady.mutate()` |

Order type values match the `OrderType` enum: `"Hold"`, `"Move"`, `"Support"`, `"Convoy"`.

The executor validates tool call arguments before calling tRPC (e.g., province exists, order type is valid for the fields provided) and returns clear error messages so the model can self-correct. The executor converts the flat tool schema into the correct discriminated union types (`HoldOrder | MoveOrder | ...`, `RetreatMove | Disband`, etc.) before passing to tRPC.

### Tool Executor

A `GameToolExecutor` class that holds the tRPC client, current game state snapshot, and the agent's power:

```typescript
class GameToolExecutor implements ToolExecutor {
  isReady = false;

  constructor(
    private client: GameClient,
    private gameState: GameState,
    private power: Power,
  ) {}

  async execute(name: string, args: Record<string, unknown>): Promise<string>;
}
```

- Map query tools read from `PROVINCES` (static) and `this.gameState` (snapshot from phase start)
- Action tools call `this.client.game.*.mutate()` directly — orders are submitted to the server immediately
- `ready` calls `this.client.game.submitReady.mutate()` and sets `isReady = true`
- The executor is created fresh for each tool loop with the latest game state

Since action tools hit the server directly:
- `submitOrders` can be called multiple times — the server accepts the latest submission
- No need to collect and batch results — actions take effect immediately
- If the phase ends mid-loop, tRPC mutations will fail and the executor returns an error to the model

### Agent Entry Point

A new `connectToolAgent` function replaces the `DiplomacyAgent` + `connectRemoteAgent` path for LLM agents:

```typescript
// src/agent/llm/tool-agent.ts
export async function connectToolAgent(
  client: GameClient,
  llm: LLMClient,
  power: Power,
  lobbyId: string,
): Promise<{ unsubscribe: () => void }>;
```

This function:
1. Fetches initial game state via `client.game.getState.query()`
2. Subscribes to `onPhaseChange` and `onMessage` SSE streams
3. Manages a serialized work queue (same pattern as `remote-adapter.ts`)
4. For each work item, runs a tool-calling loop with the LLM

The work queue and message batching logic from `remote-adapter.ts` is reused or extracted into shared utilities.

### Agent Loop Lifecycle

**Phase start (Orders/Retreats/Builds):**
1. Phase change event arrives, queued as work item
2. `connectToolAgent` creates a `GameToolExecutor` with fresh game state and tRPC client
3. Starts `llm.runToolLoop()` with:
   - System prompt (role, rules, tool usage guidance)
   - User message (phase context, pending messages if any, last turn results)
   - Tool definitions filtered by phase type
4. Model calls tools: queries map, sends messages, submits orders — all hitting the server directly
5. Model calls `ready()` → executor calls `submitReady` on server, sets `isReady = true` → loop ends

**Diplomacy phase:**
1. Same as above, but only `sendMessage`, map query tools, and `ready` are available
2. No order submission tools exposed

**Message arrival while idle (loop ended):**
1. Messages queue up (existing batching: debounce timer, configurable via `MESSAGE_BATCH_DELAY`)
2. After batch interval, a new tool loop starts with pending messages in the opening user message
3. Model can query map, send replies, revise orders (calls `submitOrders` again on server)
4. `ready()` ends loop, re-readies on server

**Message arrival during active loop:**
1. Messages queue — they do NOT interrupt the active loop
2. When the current loop ends, if there are queued messages, a new loop starts immediately
3. Matches the existing serialized work queue pattern

**Phase ends server-side:**
1. Phase change subscription fires, stale work items cleared
2. If a loop is in-flight, its tRPC action calls will fail (server rejects out-of-phase submissions) — the model sees error responses and the loop terminates naturally

### Phase-Specific Tool Filtering

| Phase | Available Tools |
|-------|----------------|
| Diplomacy | Map queries + `sendMessage` + `ready` |
| Orders | Map queries + `submitOrders` + `sendMessage` + `ready` |
| Retreats | Map queries + `getRetreatOptions` + `submitRetreats` + `sendMessage` + `ready` |
| Builds | Map queries + `submitBuilds` + `sendMessage` + `ready` |

### System Prompt

Simplified from the current prompt:

**Kept:**
- Role and strategic personality
- Game rules summary
- Game length guidance (short/medium/long)
- Information security rules for messages

**Removed:**
- Province abbreviation list (model discovers via tools)
- JSON schema examples (tools handle structured I/O)
- Order format documentation (tool parameters are self-documenting)

**Added:**
- Tool usage guidance: "Use getMyUnits and getAdjacentProvinces to plan moves. Use sendMessage to negotiate. Call submitOrders when you've decided, then ready() to end your turn."

Each tool loop's opening user message includes:
- Current phase/year/season
- Situational context ("You have N units and M supply centers. Submit movement orders.")
- Pending diplomatic messages (if any)
- Last turn results (if any, summarized from order history)

### CLI Entry Point

The existing `src/agent/remote/run.ts` CLI creates a `DiplomacyAgent` and calls `connectRemoteAgent`. For tool-calling agents, it should instead call `connectToolAgent`:

```typescript
// In run.ts, after creating the tRPC client:
if (agentType === 'llm') {
  const llmClient = new OpenAICompatibleClient(config);
  await connectToolAgent(client, llmClient, power, lobbyId);
} else {
  // RandomAgent or other DiplomacyAgent implementations
  const agent = createAgent(agentType, power, config);
  await connectRemoteAgent(agent, client, lobbyId);
}
```

## Files Changed

| File | Change |
|------|--------|
| `src/agent/llm/llm-client.ts` | Extend `ChatMessage` type union, add `ToolDefinition` and `ToolExecutor` interfaces, implement `runToolLoop` on `OpenAICompatibleClient` |
| `src/agent/llm/tools.ts` | **New.** Tool definitions (JSON schemas), `GameToolExecutor` class wrapping tRPC client + PROVINCES |
| `src/agent/llm/tool-agent.ts` | **New.** `connectToolAgent` — subscribes to tRPC events, manages work queue, runs tool loops |
| `src/agent/llm/prompts.ts` | Simplify system prompt. Remove order/retreat/build prompt builders. Keep `serializeGameState` (trimmed) for opening user message context. |
| `src/agent/random.ts` | Rewrite as `connectRandomAgent(client, power, lobbyId)` — self-contained tRPC client |
| `src/agent/remote/run.ts` | Route `llm` → `connectToolAgent`, `random` → `connectRandomAgent` |
| `src/agent/interface.ts` | **Delete.** |
| `src/agent/adapter.ts` | **Delete.** |
| `src/agent/remote/remote-adapter.ts` | **Delete.** |
| `src/agent/llm/llm-agent.ts` | **Delete.** |
| `src/agent/llm/order-parser.ts` | **Delete.** |
| In-process game scripts | Update to use tRPC client to localhost |

## What Stays the Same

| Component | Why |
|-----------|-----|
| `GameManager`, tRPC router | Server-side — not touched |
| `GameState` type | Engine types — not touched |
| `remote/client.ts` | tRPC client factory — reused by all agents |
| `remote/deserialize.ts` | Wire format deserialization — reused |
| Config format | No new fields needed |
| Ollama config | Same `/v1` endpoint |

## Testing Strategy

- Unit test `GameToolExecutor` — mock tRPC client, verify each tool dispatches correct queries/mutations and returns properly formatted results
- Unit test `runToolLoop` — mock LLM responses with tool_calls, verify the loop executes tools, accumulates conversation history, terminates on `ready()` or max iterations
- Unit test tool argument validation — verify the executor rejects invalid provinces, bad order types, etc. with clear error messages
- Integration test with Ollama — run a full game via the existing integration test skill and verify agents produce valid orders
- Compare order validity rates before/after (prompt-based vs tool-based)

## Remove DiplomacyAgent Interface

As part of this changeset, remove the `DiplomacyAgent` abstraction entirely. All agents become self-contained tRPC clients:

1. **Convert `RandomAgent`** to a `connectRandomAgent(client, power, lobbyId)` function — subscribes to phase changes, picks random valid orders, submits via tRPC. Same pattern as `connectToolAgent`.
2. **Delete `src/agent/interface.ts`** — the `DiplomacyAgent` interface
3. **Delete `src/agent/adapter.ts`** — the in-process adapter
4. **Delete `src/agent/remote/remote-adapter.ts`** — the remote adapter (replaced by agents connecting directly)
5. **Delete `src/agent/llm/llm-agent.ts`** — the old prompt-based LLM agent (replaced by `tool-agent.ts`)
6. **Delete `src/agent/llm/order-parser.ts`** — free-text JSON parsing no longer needed
7. **Update `src/agent/remote/run.ts`** — route `llm` to `connectToolAgent`, `random` to `connectRandomAgent`
8. **Update in-process game scripts** (e.g., `play:random`) — use tRPC client to localhost instead of `connectAgent`

### What replaces what

| Before | After |
|--------|-------|
| `DiplomacyAgent` interface | Deleted — no shared interface |
| `adapter.ts` (in-process bridge) | Agents connect via tRPC to localhost |
| `remote-adapter.ts` | Deleted — agents call tRPC directly |
| `LLMAgent` class | `connectToolAgent()` function |
| `RandomAgent` class | `connectRandomAgent()` function |
| `order-parser.ts` | Deleted — tools provide structured input |

## Risks

- **Ollama tool calling quality:** qwen2.5:7b supports tool calling but smaller models may struggle. If the model fails to call tools correctly, orders default to Hold on the server (same as current behavior with invalid JSON).
- **Token usage:** Multi-turn tool loops use more tokens than single-shot prompts. Mitigated by the model only querying what it needs instead of receiving the full game state dump.
- **Loop runaway:** Model calls tools endlessly. Mitigated by max iteration cap (30). A typical turn is ~15 iterations (unit queries + province lookups + messages + submit + ready), so 30 provides headroom. If max iterations hit, the loop ends — any orders already submitted to the server stand, otherwise the server defaults to Hold.
- **Anthropic compatibility:** Deferred. The `AnthropicClient` will need its own `runToolLoop` in a follow-up, as Anthropic uses `tool_use` content blocks rather than OpenAI's `tool_calls` field.
- **Network latency in tool loop:** Each action tool call hits the server. For in-container Ollama→localhost this is negligible. For remote servers, latency adds up over 15+ iterations. Acceptable for now; could batch if needed later.
