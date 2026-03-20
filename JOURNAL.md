# Architecture Journal — Improving Agent Hold Rate

## The Question

How do we get qwen3:8b agents to consistently produce valid orders instead of auto-submitting holds? Current best: 50% hold rate. Target: <20%.

---

## Reflection 1 — How Claude Code Works vs How Our Agents Work (2026-03-19 15:45)

I should start by being honest about how I work, because the contrast is instructive.

**How I (Claude Code) handle tool calls:**
- I receive a prompt with full context (conversation history, file contents, etc.)
- I decide which tool to call based on the entire context
- I call ONE tool, get the result, then decide the next action
- My "harness" (Claude Code CLI) manages the loop: prompt → response → tool execution → feed result back → next prompt
- Crucially: **each tool call is a separate LLM inference**. I don't generate a plan and then execute it — I react step by step.

**How our Diplomacy agents work:**
- The agent gets ONE prompt with everything (system prompt, turn state, order history, plan, messages)
- It must produce tool calls in a SINGLE LLM response (or a few iterations of the tool loop)
- If the model generates text instead of tool calls, the whole phase fails
- The `tool_choice: "required"` forces tool calls but the model sometimes can't comply with the complex prompt

**The fundamental mismatch:** We're asking qwen3:8b to do in ONE inference what I do across MANY inferences. The prompt is huge (system prompt + rules + strategic summary + order history + plan + phase instructions + adjacency lists), and the model has to parse all of it and produce structured JSON tool calls in a single shot.

### What if we broke it up?

Instead of one mega-prompt → one tool call, what if the agent harness was more like Claude Code's harness:

1. **Phase 1 — Observe**: Small prompt: "Here's the board state. What do you see?" → Model responds with text analysis. No tools needed.
2. **Phase 2 — Plan**: "Based on your analysis, what orders do you want to give?" → Model responds with natural language plan.
3. **Phase 3 — Execute**: "Convert this plan to orders: [plan text]" → Tiny focused prompt → tool call to submitOrders.

Step 3 would almost never fail because the prompt is small and focused. The model just needs to convert "move army from Vienna to Budapest" into `{"type": "Move", "unit": "vie", "destination": "bud"}`.

**Trade-off**: 3 LLM calls per agent per phase instead of 1. With concurrency=1 and 7 agents, that's 21 calls per phase. At ~2 min each (smaller prompts = faster), that's ~42 min. Worse than the current ~25 min. But the hold rate would plummet because step 3 is nearly guaranteed to produce valid tool calls.

### The Memory Problem

Our agents have a `plan` block that persists across phases — but it's just a text blob appended to every prompt. As the game progresses, the prompt grows with order history, and the plan may reference stale information.

**How I handle memory:** I have a structured memory system with typed files (user, feedback, project, reference) indexed by MEMORY.md. I don't load everything into every prompt — I selectively recall relevant memories.

**What agents could do:**
- Maintain a structured state file per power (allies, threats, goals, SC targets)
- Only include the RELEVANT parts in each prompt (e.g., don't include full order history, just last turn's results and key strategic changes)
- Use a "memory retrieval" tool — the agent could call `getMyStrategy` to load its own notes, `getRelationship(power)` to check alliance status, etc.

This would keep prompts small and focused while giving agents access to deep context on demand.

---

## Reflection 2 — Client-Side Validation as a Feedback Loop (2026-03-19 16:00)

The multi-step harness from Reflection 1 addresses *tool call reliability*. But there's a separate problem that's just as damaging: **agents submit orders that are syntactically valid but semantically wrong**. England ordered `lon→nor` (not adjacent), Russia ordered `stp→bul` (not adjacent). The engine silently converts these to holds. The agent never learns it made a mistake.

This is fundamentally different from how I work. When I call a tool and it fails — say I try to edit a string that doesn't exist in a file — I get an error message back, and I adjust. The feedback loop is built into my harness. Our agents have no such loop for invalid orders.

**What silent failure costs us:**

In the concurrency=1 run, England submitted 3 moves in Spring 1901 (lon→nor, edi→swe, lvp→bel). All three were geographically impossible. They resolved as 3 holds. That's an agent that *tried* to play — it produced tool calls, used correct province IDs — but got zero credit because it picked unreachable destinations. If we'd told it "lon cannot reach nor; lon can reach: nth, eng, wal, yor" and let it retry, it probably would have picked a valid destination.

The prompt already SHOWS adjacencies (`lon [Fleet] -> can reach: nth, eng, wal, yor`), but the model doesn't always cross-reference its chosen destination against this list. That's a reasoning failure, not a format failure. And it's the kind of reasoning failure that a feedback loop fixes better than a bigger prompt.

**Implementation idea — validation in `GameToolExecutor.submitOrders()`:**

```typescript
async submitOrders(args) {
  const orders = parseOrders(args);
  const errors = [];

  for (const order of orders) {
    const unit = this.gameState.units.find(u => u.province === order.unit && u.power === this.power);
    if (!unit) {
      errors.push(`No unit at ${order.unit}`);
      continue;
    }
    if (order.type === 'Move') {
      const adj = getAdjacent(unit);
      if (!adj.includes(order.destination)) {
        errors.push(`${order.unit} cannot reach ${order.destination}. Reachable: ${adj.join(', ')}`);
      }
    }
  }

  if (errors.length > 0) {
    return JSON.stringify({ error: errors.join('; '), hint: 'Fix invalid orders and resubmit' });
  }

  // Actually submit
  await this.client.game.submitOrders.mutate({ orders });
  this.hasSubmitted = true;
  return JSON.stringify({ ok: true });
}
```

The tool loop would naturally handle this — the model calls submitOrders, gets an error, sees which orders are invalid and why, and calls submitOrders again with fixed destinations. This is exactly how I work when an Edit fails — I read the error and adjust.

**Cost**: Zero extra LLM calls in the happy path (valid orders go through on first try). One extra tool loop iteration in the error path (model sees error, fixes, resubmits). The semaphore slot is already held, so no queue impact.

**This is probably the highest-ROI change we could make.** It doesn't require restructuring the harness (like multi-step does), it's backwards compatible, and it directly targets the #2 cause of holds (invalid destinations). The #1 cause (no tool calls at all) still needs the multi-step approach, but validation would recover a significant chunk of the orders that currently get silently thrown away.

**What I find interesting about this:** It's really the same principle as why Claude Code works well — tight feedback loops between tool calls. The agent calls a tool, gets a result, reacts. Our agents currently have an "open loop" — they fire and forget. Making it a closed loop is the architectural insight.

---

## Reflection 3 — The Prompt Size Budget and What Deserves to Be In It (2026-03-19 16:45)

Reflections 1 and 2 proposed structural changes (multi-step harness, validation feedback). This one goes deeper on a subtler question: **what should actually be in the prompt, and what shouldn't?**

I want to think about this carefully because it's the lever that doesn't require new code — just better information design.

### What's in the current prompt

Let me inventory what `buildTurnPrompt()` actually produces for a mid-game turn:

1. Phase header ("Spring 1902 Orders") — ~20 tokens
2. Unit/SC counts — ~30 tokens
3. Game end info — ~20 tokens
4. **Last turn results** — ALL resolutions for ALL powers. 7 powers × 3-4 units × ~15 tokens = ~350 tokens. Grows slightly with retreats/builds.
5. **Your units with adjacencies** — 3-5 units × ~30 tokens each = ~120 tokens
6. **Strategic summary** — power rankings, neighbor detection, your position. ~200 tokens
7. **Your plan from last phase** — variable, typically 200-500 tokens
8. **Accumulated messages** — ALL messages ever sent, with phase stamps. Grows unboundedly.
9. **Phase-specific instructions** — ~100 tokens
10. **Nearby neutral SC targets** — ~50 tokens

Plus the system prompt (~800 tokens) and tool definitions (~1500 tokens).

For Spring 1901, this totals maybe ~3000 tokens. Fine. But by Fall 1903, the order history has 5 phases × 7 powers × ~15 tokens = ~525 tokens, the plan block may be 400 tokens, and accumulated messages could be anything. We're pushing 4-5k tokens of prompt, plus 1.5k of tool definitions, plus whatever the model generates in `<think>` blocks.

### What the model ACTUALLY needs to make good orders

If I think about what information is truly necessary for a single turn:

1. **Where are MY units and what can they reach?** (essential — ~120 tokens)
2. **Where are enemy units near me?** (essential — the strategic summary's neighbor section, ~100 tokens)
3. **What happened LAST turn?** (useful but not all of it — just MY results and results that affected my position, ~80 tokens)
4. **What's my strategic goal?** (the plan block, but trimmed to just GOAL + ORDERS sections, ~100 tokens)
5. **What supply centers should I target?** (the nearby targets hint, ~50 tokens)

That's ~450 tokens of truly essential information. The current prompt is 5-10x larger because it includes:
- Full order history for ALL powers (not just yours)
- Full strategic summary with rankings for all 7 powers
- Full accumulated message history
- Verbose instructions repeated every turn

### The Claude Code parallel

When I'm working on a codebase, my context window contains the full conversation. But I don't re-read every file every turn. I **selectively read** what I need. The key files are in my context from earlier reads, and I only pull new information when I need it.

Our agents don't have that luxury — they get a fresh prompt every phase with everything dumped in. But we COULD apply the same principle: **start with a minimal prompt and let the agent pull more context via tools if it wants.**

### A concrete "lean prompt" design

```
=== Spring 1902 (Orders) ===
You have 4 units and 4 supply centers.

--- Your Units ---
lon [Fleet] -> can reach: nth, eng, wal, yor
nor [Fleet] -> can reach: nth, nwg, swe, bar, stp/nc
wal [Army] -> can reach: lon, lvp, yor, eng
yor [Army] -> can reach: lon, edi, lvp, wal, nth

--- Last Turn ---
Your moves: lon→nth [Succeeds], edi→nor [Succeeds], lvp→wal [Succeeds]

--- Your Plan ---
GOAL: Take Sweden and Denmark
ORDERS: nor→swe, nth→den, wal→lvp, yor→lon

⚠️ Call submitOrders with one order per unit. Use getLastTurnResults for full results, getProvinceInfo to scout, sendMessage to negotiate.
```

That's maybe 200 tokens. Compare to the current ~3000+. The model has everything it needs to submit orders. If it wants more context (what did France do last turn? who owns Belgium?), it can call `getProvinceInfo` or a new `getLastTurnResults` tool.

### The trade-off

A leaner prompt means more tool calls for context retrieval. But each tool call is fast (no LLM inference needed — it's just a data lookup that returns in milliseconds). The LLM inference on the lean prompt would be dramatically faster. And the model is far more likely to produce a tool call from a 200-token prompt than from a 3000-token prompt.

**The insight**: We've been trying to make the model smarter by giving it more information. But with a small model like qwen3:8b, less information = more reliable tool calling. The information isn't gone — it's just on-demand instead of force-fed.

This composes beautifully with Reflection 1 (multi-step harness) and Reflection 2 (validation feedback). A lean prompt + validation + multi-step would look like:
1. Lean observe prompt (200 tokens) → model optionally calls context tools → produces analysis
2. Plan prompt with analysis → produces natural language orders
3. Tiny execute prompt → submits orders → validation catches errors → retry if needed

Each step is fast, focused, and almost certain to produce the right kind of output.

---

## Reflection 4 — The Semaphore Is the Wrong Abstraction (2026-03-19 16:55)

Reflections 1-3 focused on making each LLM call more effective (smaller prompts, multi-step, validation). But I've been assuming the concurrency model is fixed. What if it's not?

### The current model: 7 independent agents, 1 shared GPU

Each power is a separate Node.js process. Each process independently decides when to call Ollama. The `FileSemaphore` serializes access so only 1 call hits Ollama at a time. The queue is FIFO based on when each process tries to acquire the lock.

This means: 7 processes are running in parallel, but their LLM work is serialized. They're doing useful work (processing messages, managing state) in parallel, but the expensive part (Ollama inference) is sequential. The semaphore adds overhead (file locks, stale PID detection, polling) and the queue order is unpredictable.

### What if we flipped it?

Instead of 7 independent processes competing for 1 GPU slot, what about **1 orchestrator process** that manages all 7 agents' LLM calls?

```
Game Server → phase starts → notifies Orchestrator
Orchestrator → builds prompts for all 7 powers
Orchestrator → calls Ollama for Power 1 → gets orders → submits
Orchestrator → calls Ollama for Power 2 → gets orders → submits
...
Orchestrator → calls Ollama for Power 7 → gets orders → submits
→ all submitted, phase advances
```

No semaphore needed. No file locks. No 7 Node.js processes sitting idle while waiting for their turn. The orchestrator controls the exact order and can make intelligent scheduling decisions:
- Prioritize powers that have been waiting longest
- Skip powers that auto-submitted last turn (they're likely to fail again)
- Adjust maxTokens per power based on how much phase time remains

### How I (Claude Code) actually work — the single-process model

Here's something I didn't fully appreciate in Reflection 1: I'm not 7 parallel processes sharing a GPU. I'm a single conversation thread. My harness (Claude Code CLI) makes one LLM call at a time, gets my response, executes tools, feeds results back, and makes the next call. There's no concurrency at all — and it works great.

The Diplomacy agents are trying to be concurrent when the hardware is fundamentally serial. The semaphore turns 7 concurrent processes into serial execution, but with all the overhead of concurrency (process management, file locks, race conditions, unpredictable scheduling).

### The orchestrator advantage for hardware-constrained setups

With `OLLAMA_NUM_PARALLEL=1`, the orchestrator model is strictly better:
- **No semaphore overhead** — direct sequential calls
- **No 7 idle processes** — one process, lower memory footprint
- **Predictable scheduling** — the orchestrator decides the order
- **Shared context** — the orchestrator can see all 7 powers' states and make cross-power decisions (e.g., "France and Italy both want Spain — I'll process France first since it has a Support order")
- **Adaptive timeouts** — if 5 powers submitted quickly, the orchestrator can give the last 2 more time/tokens

The downside: it's a bigger architectural change than validation or lean prompts. But it directly addresses the hardware constraint instead of working around it.

### When concurrency > 1 matters

The multi-process model makes sense when `OLLAMA_NUM_PARALLEL` > 1 — you actually want parallel LLM calls. But for our setup (parallel=1), the orchestrator is a pure win. We could support both:
- `OLLAMA_NUM_PARALLEL=1` → orchestrator mode (1 process, sequential calls)
- `OLLAMA_NUM_PARALLEL>1` → multi-process mode (N processes, semaphore with N slots)

### Connection to previous reflections

The orchestrator composes naturally with everything else:
- **Multi-step harness** (R1): The orchestrator runs observe→plan→execute for each power sequentially
- **Validation** (R2): The orchestrator handles validation and retry within each power's turn
- **Lean prompts** (R3): The orchestrator builds the minimal prompt for each power, pulling context as needed
- **Memory**: The orchestrator manages all 7 powers' memory files, loading only what's relevant

It's essentially what Claude Code's harness does — one process, one LLM at a time, full control over the conversation flow.

---

## Reflection 5 — What If We Didn't Need Tool Calls At All? (2026-03-19 17:05)

Every reflection so far has tried to make tool calling work better — multi-step harness, validation, lean prompts, orchestrator. But what if tool calling is the wrong paradigm for small models on constrained hardware?

### Why tool calling is hard for small models

Tool calling requires the model to produce **structured JSON** in a specific format (`tool_calls` array with function names and arguments). The model needs to:
1. Understand it should produce a tool call (not text)
2. Pick the right function name from the available tools
3. Construct valid JSON arguments matching the schema
4. Do all of this while also reasoning about Diplomacy strategy

That's a lot to ask in a single inference. Larger models (GPT-4, Claude) handle this naturally. But qwen3:8b frequently produces text responses instead — it "thinks about" calling tools but outputs prose. The `tool_choice: "required"` constraint doesn't always help because the model may not support it well at the OpenAI-compatible API layer.

### The text-parsing alternative

What if the model just responded in natural language, and the **harness parsed orders from the text**?

Instead of:
```json
{"tool_calls": [{"function": {"name": "submitOrders", "arguments": "{\"orders\":[{\"type\":\"Move\",\"unit\":\"vie\",\"destination\":\"bud\"}]}"}}]}
```

The model just says:
```
I'll move my army from Vienna to Budapest, move the fleet in Trieste to Albania, and hold in Budapest.

Orders:
vie -> bud
tri -> alb
bud HOLD
```

And the harness parses that with a simple regex:
```typescript
const ORDER_RE = /^(\w+)\s*->\s*(\w+)|^(\w+)\s+HOLD/gm;
```

### Why this could work

1. **Every model can produce text.** Even when qwen3:8b fails to produce tool calls, it generates strategic text with unit names and destinations. We saw this in the logs — 1596 chars of text that contained the model's strategic thinking and intended orders, but no `tool_calls` JSON.

2. **Parsing is deterministic.** No LLM call needed. The harness applies a regex, extracts province IDs, validates against adjacency, and submits. Zero latency, zero failure.

3. **It degrades gracefully.** If the model doesn't produce parseable orders, we fall back to the existing tool-call attempt. If that also fails, we auto-submit. Three layers of defense instead of one.

4. **The prompt becomes simpler.** No tool definitions needed (saves ~1500 tokens). No `tool_choice: "required"`. Just: "List your orders in the format `province -> destination` or `province HOLD`."

### How I (Claude) relate to this

Here's an honest admission: when I produce tool calls, I'm not really "calling functions" in a programmatic sense. I'm generating text that happens to be structured as JSON in a tool-call format. My harness parses that structured text and executes the function. The structure is just a protocol between me and my harness.

For small models, that protocol (OpenAI tool-call JSON) might be too demanding. A simpler protocol (natural language with a known pattern) achieves the same goal with less cognitive overhead on the model.

### A hybrid approach

We don't have to choose. The harness can try multiple strategies in order:

```typescript
async function extractOrders(response: string, gameState: GameState, power: Power): Order[] {
  // Strategy 1: Parse natural language orders from text
  const parsed = parseNaturalLanguageOrders(response);
  if (parsed.length > 0) return validate(parsed, gameState, power);

  // Strategy 2: Look for JSON-formatted orders in the text
  const jsonMatch = response.match(/\{[\s\S]*"orders"[\s\S]*\}/);
  if (jsonMatch) return validate(JSON.parse(jsonMatch[0]).orders, gameState, power);

  // Strategy 3: Fall back to tool-call flow (existing behavior)
  return null; // signals: try the tool loop
}
```

The harness tries to extract orders from any text response before falling back to the tool-call protocol. This way we get orders from the 1596-char text responses that currently result in auto-submitted holds.

### The cost

- Need a robust parser for natural language orders (but the format is highly constrained — province IDs are a known set, order types are Hold/Move/Support/Convoy)
- Loses the nice tool-call semantics for messages (`sendMessage`) — though we could parse those too ("Message to France: let's ally against Germany")
- Slightly less structured than tool calls, so validation becomes more important (composes with Reflection 2)

### The insight

Tool calling is a protocol choice, not a fundamental requirement. The model needs to communicate intent; the harness needs to translate that into API calls. If the current protocol (OpenAI tool JSON) has a 50% failure rate with our model, maybe we need a simpler protocol — not a bigger model.

This is the most radical idea so far because it questions an assumption all previous reflections shared: that we need to make tool calling work. Maybe we don't.

---

## Reflection 6 — Ranking the Ideas: What to Build First (2026-03-19 17:15)

Five reflections of ideas. Time to be disciplined about what to actually build. Let me evaluate each proposal against three criteria:

1. **Impact on hold rate** — how much does it reduce the 50% hold rate?
2. **Implementation cost** — how much code changes, how risky?
3. **Latency cost** — does it make phases slower?

### The scorecard

| # | Idea | Hold rate impact | Impl cost | Latency cost | Priority |
|---|------|-----------------|-----------|--------------|----------|
| R2 | Client-side order validation | HIGH | LOW | ZERO (happy path) | **1st** |
| R5 | Text-parsing fallback | HIGH | MEDIUM | ZERO (it's a fallback) | **2nd** |
| R3 | Lean prompts | MEDIUM | LOW | NEGATIVE (faster!) | **3rd** |
| R1 | Multi-step harness | HIGH | HIGH | +70% more calls | 4th |
| R4 | Orchestrator process | MEDIUM | HIGH | NEGATIVE (no semaphore) | 5th |

### Why this order

**R2 (Validation) is the clear #1.** It's ~50 lines of code in one file (`tools.ts`), zero latency cost on valid orders, and directly recovers orders that currently become silent holds. England's `lon→nor` would have been caught and corrected. This is the highest-ROI change per line of code. We could implement and test it in 30 minutes.

**R5 (Text parsing) is #2** because it catches the other half of the problem — agents that produce text instead of tool calls. Italy generated 1596 chars of strategic analysis that likely contained order intentions. Parsing that text is more work (need a robust regex/parser for Diplomacy order syntax) but it turns total failures into partial successes. We could implement this as a fallback in the tool loop's "no tool calls" branch.

**R3 (Lean prompts) is #3** because it's nearly free — just trimming the turn prompt. Less code to write, but the impact is more speculative. It should make tool calling more reliable by reducing cognitive load, AND it makes each LLM call faster. The risk is that removing context makes the model's strategy worse. But our data shows strategy isn't the bottleneck — tool calling reliability is.

**R1 (Multi-step) and R4 (Orchestrator) are bigger architectural changes.** They're the right long-term direction but they're risky to build without validating the simpler ideas first. If validation + text parsing + lean prompts get us to 20% hold rate, the multi-step harness may not be needed. If they don't, we'll know exactly what's still failing and can design the multi-step harness to target that.

### An implementation plan

**Phase 1 (quick wins, this session):**
1. Add order validation in `GameToolExecutor.submitOrders()` — return errors for invalid unit/destination, let tool loop retry
2. Add text-parsing fallback in the tool loop's "no tool calls" branch — regex for `province -> destination` patterns

**Phase 2 (lean prompts, next session):**
3. Trim `buildTurnPrompt()` — only include MY last turn results, trim strategic summary, cap plan block length
4. Add `getLastTurnResults` tool for full history on demand

**Phase 3 (structural, if needed):**
5. Multi-step harness or orchestrator, informed by Phase 1-2 results

### What I notice about my own reasoning process

I'm doing something here that I think is important for the Diplomacy agents too: **I'm planning incrementally, validating assumptions before committing to big changes.** I could have jumped straight to the orchestrator (the most architecturally elegant solution), but the simpler changes might solve the problem for less cost.

This is the same principle I'd advocate for the agents: don't try to solve everything in one mega-prompt. Take small steps, validate results, adjust. The harness should embody this philosophy — try the simple thing first (text parsing), then the medium thing (validation retry), then the hard thing (multi-step).

---

## Reflection 7 — The Model Isn't Playing Diplomacy, It's Playing "Be an AI Agent" (2026-03-19 17:25)

I want to step back from implementation details and think about something more fundamental. Every reflection so far treats the model as a tool-calling machine that needs engineering fixes. But maybe the deeper problem is **what we're asking the model to be**.

### The current identity crisis

Our system prompt says: "You are playing as England in a game of Diplomacy. You are a skilled and strategic player."

But then the prompt immediately pivots to: here are tool definitions, here are JSON schemas, here's how to format orders, call submitOrders with the right structure, include a ```plan block, don't forget the province ID format...

The model isn't being asked to play Diplomacy. It's being asked to **operate a Diplomacy API**. Those are very different cognitive tasks. A Diplomacy player thinks: "I need to take Norway this turn." An API operator thinks: "I need to construct a valid JSON payload for the submitOrders endpoint."

qwen3:8b is decent at Diplomacy reasoning (we saw thoughtful strategic text in the failed tool-call responses). It's mediocre at API operation (50% tool-call failure rate). We're bottlenecked on the thing it's bad at, not the thing it's good at.

### How I experience this distinction

When I'm helping a user, I don't think about tool schemas. I think about the task: "I need to edit this function." My harness translates that intent into the Edit tool call. I don't construct `{"file_path": "...", "old_string": "...", "new_string": "..."}` in my head — I express the edit and the structure follows naturally.

But that only works because the tool protocol is deeply integrated into my training. I was trained on millions of tool-call examples. qwen3:8b was trained primarily on text completion, with tool-calling bolted on via fine-tuning. The protocol isn't native to the model — it's a learned behavior that breaks under cognitive load.

### The implication for prompt design

Instead of teaching the model to operate an API, **let the model play Diplomacy and let the harness handle the API**.

Current prompt approach:
```
You are England. Here are your tools: submitOrders, sendMessage, getProvinceInfo...
You MUST call submitOrders with JSON orders in this format...
```

Alternative approach:
```
You are England. Think about your strategy and write your orders.

Format:
MOVE lon -> nth
MOVE edi -> nwg
HOLD lvp
SUPPORT wal -> lon
MESSAGE France: Let's coordinate against Germany.
```

The model writes orders in a simple, human-readable format. No JSON, no tool schemas, no function names. The harness parses the text and calls the API. The model's entire cognitive budget goes toward *playing Diplomacy* instead of *operating an API*.

### This reframes Reflection 5

Reflection 5 proposed text-parsing as a fallback. But this reflection suggests it should be the **primary** interface. Not "try tool calls first, fall back to text" but "the model speaks Diplomacy, the harness speaks API."

The tool-call interface would still exist for queries (getProvinceInfo, getMyUnits) where structured I/O is genuinely useful. But for the primary action — submitting orders — natural language is the model's native medium.

### What this means for prompt size

If we remove tool definitions for submitOrders, submitRetreats, and submitBuilds (the action tools), we save ~800 tokens of tool schema from every prompt. The query tools (getProvinceInfo, etc.) stay — they're useful and their structured responses help the model. But the submission protocol becomes:

```
Write your orders, one per line:
  MOVE <unit> -> <destination>
  HOLD <unit>
  SUPPORT <unit> supports <supported_unit> [-> <destination>]
  CONVOY <fleet> convoys <army> -> <destination>
```

That's ~50 tokens instead of ~800 tokens of JSON schema. And the model is far more likely to produce `MOVE lon -> nth` than `{"type": "Move", "unit": "lon", "destination": "nth"}`.

### The deeper insight about AI agent design

There's a general principle here that goes beyond Diplomacy: **match the interaction protocol to the model's native capabilities**. Large models can handle complex structured protocols. Small models need protocols that feel like natural language. The harness should absorb the complexity gap.

This is actually what good UX design does for humans too — the user expresses intent in natural terms, the system translates it into structured operations. The model IS the user of our harness. We should design for it the same way.

---

## Reflection 8 — The Two-Model Architecture (2026-03-19 17:35)

Reflection 7 identified the cognitive split: strategy vs. API operation. What if we took that literally and used **two different models** — or two different configurations of the same model?

### The observation

In our integration tests, we saw two distinct failure patterns:

1. **Good strategy, bad tool calls**: The model produces thoughtful strategic text ("I should move toward Norway via the North Sea while supporting with Yorkshire") but fails to translate that into `submitOrders` JSON. (England, Italy in multiple runs.)

2. **Good tool calls, bad strategy**: The model produces valid tool calls with correct format but picks nonsensical destinations (`lon→nor`, `stp→bul`). The API operation succeeds but the Diplomacy reasoning fails. (England in the unitStr-fixed run.)

These are different skills. And on constrained hardware, optimizing for one hurts the other: more tokens for reasoning = less reliable tool calls; simpler prompts for reliable tool calls = less strategic depth.

### What if we split them?

```
┌─────────────────────────────────────────────┐
│  Strategist (qwen3:8b, thinking enabled)    │
│  - Receives: board state, messages, plan    │
│  - Produces: natural language strategy +    │
│    ordered list of intended moves           │
│  - No tools. Pure text completion.          │
│  - Temperature: 0.8 (creative)              │
│  - maxTokens: 4096 (room to think)          │
└──────────────────┬──────────────────────────┘
                   │ text output
                   ▼
┌─────────────────────────────────────────────┐
│  Executor (qwen2.5:3b, no thinking)         │
│  - Receives: strategist's move list +       │
│    unit positions + adjacency list          │
│  - Produces: submitOrders tool call         │
│  - Has tools. tool_choice: required.        │
│  - Temperature: 0.1 (deterministic)         │
│  - maxTokens: 512 (just the JSON)           │
└─────────────────────────────────────────────┘
```

The **strategist** is qwen3:8b with thinking enabled — this is where its reasoning shines. It gets a rich prompt, thinks deeply, and outputs natural language: "Move fleet from London to North Sea. Move fleet from Edinburgh to Norwegian Sea. Move army from Liverpool to Yorkshire."

The **executor** is a tiny model (qwen2.5:3b or even qwen2.5:0.5b) that's great at structured output. Its prompt is tiny: "Convert these orders to JSON. Units: lon [Fleet], edi [Fleet], lvp [Army]." It produces the tool call in ~5 seconds. It doesn't need to understand Diplomacy strategy — just format conversion.

### Why this is interesting on our hardware

The VRAM concern: running two models means loading/unloading from GPU. But with Ollama's `keep_alive`, we can keep one model warm while the other runs. And the executor model is tiny — qwen2.5:3b is 2GB vs qwen3:8b's 5.9GB. On a 16GB system, both could fit simultaneously.

The latency math:
- Strategist: ~3-4 min (same as current, but no tool overhead — pure text)
- Executor: ~5-10 seconds (tiny model, tiny prompt, 512 max tokens)
- Total: ~4 min per agent, roughly the same as now

But the tool-call success rate of the executor would be near 100% because:
- The prompt is ~200 tokens (just the move list + unit positions)
- No strategic reasoning needed — pure format conversion
- qwen2.5:3b handles tool calls reliably (we've seen this in earlier testing)
- `temperature: 0.1` eliminates creative variance in the structured output

### The deeper architectural point

This is actually how a lot of production AI systems work. You see it in:
- **Retrieval-augmented generation**: one model retrieves, another generates
- **Code generation**: one model plans, another writes code
- **Multi-agent systems**: different agents have different specializations

And it maps to how human organizations work too — the general doesn't fill out the paperwork. Strategic thinking and administrative execution are different jobs that benefit from different skill profiles.

### Connection to Reflection 7

Reflection 7 said "let the model play Diplomacy, let the harness handle the API." The two-model architecture takes this literally: the strategist plays Diplomacy, the executor handles the API. The "harness" between them is just a string of text — the strategist's output becomes the executor's input.

This also resolves the `/no_think` dilemma we encountered. With thinking enabled, qwen3:8b was good at strategy but slow and unreliable at tools. With `/no_think`, it was faster but produced worse strategy and *still* sometimes failed at tools. The two-model split lets each configuration do what it's best at.

### What we'd need to build

1. A strategist prompt (text-only, no tools, encourages natural language order format)
2. An executor prompt (tiny, tool-only, just format conversion)
3. Harness code to chain them: strategist → parse output → executor → submit
4. Ollama config for two models (or same model with different parameters)

Implementation cost is medium — it's a new flow in `tool-agent.ts`, not a rewrite. The strategist call replaces the current mega-prompt. The executor call is new but simple.

---

## Reflection 9 — What We're Really Building Is a Compiler (2026-03-19 17:45)

I keep circling the same structure from different angles. Let me name it.

Reflections 5 and 7 proposed text parsing. Reflection 8 proposed a two-model split. Reflection 6 ranked validation first. They're all describing the same thing: **a compiler pipeline** that translates natural language intent into structured API calls.

```
Source language:    "Move fleet London to North Sea, support with Yorkshire"
                                    ↓
Frontend (parser):  Extract intent: MOVE lon → nth, SUPPORT yor → lon
                                    ↓
Middle (validator): Check: lon adjacent to nth? ✓. yor can support into nth? ✓.
                                    ↓
Backend (codegen):  Emit: [{"type":"Move","unit":"lon","destination":"nth"},
                           {"type":"Support","unit":"yor","supportedUnit":"lon","destination":"nth"}]
                                    ↓
Runtime (submit):   POST /trpc/game.submitOrders
```

This is literally a compiler. The LLM is the "programmer" writing in a high-level language (natural language Diplomacy orders). The harness compiles that into the low-level target (tRPC API calls).

### Why thinking about it as a compiler helps

Compiler design has solved these problems before:

**Error recovery**: When GCC encounters a syntax error, it doesn't give up on the entire file. It reports the error, skips the bad token, and keeps parsing. Our harness should do the same — if one order is unparseable, parse the others, report the error for just that unit, and give the model a chance to fix it. Currently we either submit all orders or auto-submit all holds. There's no partial success.

**Multiple frontends**: A compiler can accept multiple source languages (C, C++, Objective-C for Clang). Our "compiler" should accept multiple input formats:
- `MOVE lon -> nth` (structured text)
- `Move fleet from London to North Sea` (natural language)
- `{"type": "Move", "unit": "lon", "destination": "nth"}` (raw JSON in text)
- Tool call JSON (the current format)

All of these express the same intent. The frontend parser should handle all of them, not just one.

**Optimization passes**: A compiler applies optimization passes to intermediate representation. Our validator is an optimization pass — it checks adjacency and suggests corrections. We could add more passes:
- **Unit resolution**: If the model says "fleet London" instead of "lon", resolve it.
- **Destination disambiguation**: If "spa" is given without a coast for a fleet, check which coast is reachable and fill it in.
- **Support validation**: Check that the supporting unit can actually reach the destination.
- **Missing order detection**: If a unit has no order, default it to Hold and warn the model.

**Intermediate representation**: Compilers use IR to decouple the frontend from the backend. Our IR is the `Order[]` array. But we could make it richer — include confidence levels, the model's stated reasoning, alternative moves considered. This metadata helps with debugging and could inform retry strategies.

### A concrete compiler pipeline for the agent

```typescript
interface ParsedIntent {
  orders: Array<{
    unit: string;           // resolved province ID
    type: OrderType;
    destination?: string;   // resolved province ID
    supportedUnit?: string;
    coast?: Coast;
    raw: string;           // original text for error messages
    confidence: number;    // how clearly the intent was expressed
  }>;
  messages: Array<{
    to: string;
    content: string;
  }>;
  unparsed: string[];       // lines we couldn't parse
}

function compileResponse(
  text: string,
  gameState: GameState,
  power: Power,
): { orders: Order[]; errors: string[]; messages: Message[] } {

  // Frontend: parse all supported formats
  const intent = parseIntent(text);

  // Middle: validate and fix
  const validated = validateOrders(intent.orders, gameState, power);

  // Report errors for fixable issues
  const errors = validated
    .filter(o => o.error)
    .map(o => `${o.raw}: ${o.error}. Did you mean ${o.suggestions.join(' or ')}?`);

  // Backend: emit valid orders
  const orders = validated
    .filter(o => !o.error)
    .map(o => toOrder(o));

  return { orders, errors, messages: intent.messages };
}
```

### How this changes the agent loop

Instead of:
```
LLM response → has tool_calls? → yes: execute → no: retry/auto-submit
```

It becomes:
```
LLM response → compile(response.text) → got orders? → validate → errors?
  → yes: feed errors back, LLM fixes, recompile
  → no: submit valid orders
  → no orders parsed AND no tool_calls: auto-submit
```

The auto-submit path only triggers when we can't extract ANY intent from the response — not just when tool calls are missing. This is a much smaller failure surface.

### What I find satisfying about this framing

It unifies all the previous reflections into one coherent architecture:
- **R1 (multi-step)** → the compiler has multiple passes
- **R2 (validation)** → the middle-end validation pass
- **R3 (lean prompts)** → the model writes in a high-level language, not the target language
- **R5 (text parsing)** → the frontend parser
- **R7 (identity)** → the model is the programmer, not the compiler
- **R8 (two models)** → the strategist writes source code, the executor is the compiler (but now the executor might not even need to be an LLM)

The compiler metaphor isn't just an analogy — it's a design pattern. And it suggests we should look at compiler literature for more ideas: error recovery strategies, optimization passes, multi-target backends (what if the same orders go to both the tRPC API and a logging system?).

---

## Reflection 10 — Context Decay and the Forgetting Curve (2026-03-19 17:55)

Every run showed the same pattern: Year 1 plays well (50-60% holds), Year 2 degrades (80%+ holds). I attributed this to "growing context" but never dug into *why* more context makes the model worse. Let me think about this mechanistically.

### What changes between Year 1 and Year 2

The system prompt and tool definitions don't change. What grows:

1. **Order history**: Year 1 has 0 prior rounds. Year 2 has 2-4 rounds × 7 powers × ~15 tokens = 200-400 tokens of historical orders. By Year 3, this is 600+ tokens.

2. **Plan block**: The model writes a plan each phase. The plan references prior events, alliances, goals. It accumulates context about past turns. By Year 2, plans reference things from Year 1 that may no longer be relevant.

3. **Accumulated messages**: Every message ever sent stays in the conversation context. Even with only 2 messages in most runs, the framework is designed to accumulate all of them.

4. **Turn prompt complexity**: The strategic summary references more data (SC changes, neighbor movements). More powers have moved, creating a more complex board to describe.

But here's the thing: **the actual prompt growth is modest**. Maybe 500-800 extra tokens by Year 2. With a 40k context window, that's nothing. The model isn't running out of context — it's running out of *attention*.

### The attention hypothesis

Transformer attention is not uniform. The model attends more strongly to some tokens than others. Research on long-context models shows that information in the **middle** of a prompt gets less attention than information at the beginning or end — the "lost in the middle" phenomenon.

Our prompt structure:
```
[System prompt — beginning, high attention]
[Turn header — beginning-ish, decent attention]
[Order history — MIDDLE, low attention]
[Your units + adjacencies — MIDDLE, low attention]
[Strategic summary — MIDDLE, low attention]
[Plan block — MIDDLE, low attention]
[Messages — MIDDLE, low attention]
[Phase instructions + ACTION REQUIRED — END, high attention]
```

The critical information — your units and what they can reach — is buried in the middle. The model attends strongly to "you are England" at the top and "MUST call submitOrders" at the bottom, but the actual data it needs for valid orders is in the attention trough.

As the prompt grows with order history (which gets inserted before the units section), it pushes the unit/adjacency data deeper into the middle. Year 1: units are at ~position 30% of the prompt. Year 2: units are at ~position 40%. Year 3: ~position 50%, right in the dead zone.

### This explains the specific failures

- **England ordering `lon→nor`**: The adjacency list says `lon [Fleet] -> can reach: nth, eng, wal, yor`. But this line is in the middle of a 3000+ token prompt. The model "knows" London is a fleet and Norway is a target (from the strategic summary), but doesn't attend closely enough to the adjacency list to check reachability. It's reasoning from the beginning (you're England) and the end (submit orders) while skipping the middle (what's actually possible).

- **Year 2 tool-call failures**: The `ACTION REQUIRED: call submitOrders` instruction at the end gets attention, but the tool definitions (also in the middle-ish part of the prompt, via the API's tool parameter) get less attention as total prompt length grows. The model knows it should submit but can't reliably construct the tool call because the schema details are in its attention trough.

### What this means for design

**Lean prompts (R3) aren't just about fewer tokens — they're about attention concentration.** A 200-token prompt has no "middle" to lose things in. Everything is near the beginning or end. The model attends to all of it.

**The compiler approach (R9) helps too** because the execute step gets a tiny prompt where the orders are at the beginning and the instruction is at the end. No middle.

**But even without restructuring**, we could improve by reordering the prompt:

```
[System prompt]
[ACTION REQUIRED — moved to near-top for attention]
[Your units + adjacencies — immediately after, high attention zone]
[Nearby SC targets — right with units]
[Last turn results — YOUR results only, brief]
[Plan block — brief, just GOAL + ORDERS]
[Phase instructions]
```

Removed entirely from the base prompt:
- Full order history for all powers → available via tool
- Strategic summary rankings → available via tool
- Accumulated messages → delivered separately, not stuffed into turn prompt
- Verbose rule reminders → in system prompt, not repeated

This keeps the critical information (units, adjacencies, targets) in the first 30% of the prompt — the high-attention zone. The action instruction is near the top AND repeated at the end, bookending the data.

### The meta-insight

I've been thinking about prompt design as an information-completeness problem: "does the prompt contain everything the model needs?" But the real question is: **"does the model attend to everything the prompt contains?"** On a small model with limited attention heads, prompt *structure* matters more than prompt *content*. The right information in the wrong position is functionally absent.

This connects to how I work too. My context window is large, but I attend more carefully to the most recent messages and the user's explicit instructions. If critical information is buried in a long conversation history, I might miss it — which is why I use tools to re-read files rather than relying on stale context from earlier in the conversation.

---

## Reflection 11 — The Conversation Isn't a Conversation (2026-03-19 18:05)

Every previous reflection has treated the model's interaction as a single-shot problem: prompt in, response out. Even the multi-step harness (R1) and compiler (R9) are sequences of single-shot calls. But there's something I haven't examined: **the tool loop is already a multi-turn conversation, and we're not using it well.**

### What the tool loop actually does

The current `runToolLoop` maintains a `conversation` array:
```
[system prompt, user turn prompt] → model responds with tool calls →
[system, user, assistant+tool_calls, tool_result] → model responds again →
[system, user, assistant, tool_result, assistant+tool_calls, tool_result] → ...
```

Each iteration, the model sees the full conversation history including its previous tool calls and their results. This IS multi-turn. The model CAN learn from feedback within a single phase. We already have the infrastructure for the closed-loop interaction pattern.

But we're not leveraging it. Here's why.

### How the loop is used today

The typical flow:
1. Model receives mega-prompt + tools
2. Model calls `submitOrders` (if we're lucky) → loop ends
3. Or model returns text (no tool calls) → loop ends → retry → auto-submit

The loop almost never goes beyond iteration 1. The model either nails it on the first try or produces text and gives up. We never see the pattern I described in R2 where the model calls submitOrders, gets a validation error, and retries with corrections.

Why? Because there's nothing to iterate ON. The current tools are fire-and-forget:
- `submitOrders` either succeeds silently or succeeds with invalid orders that resolve as holds later
- `getMyUnits` / `getProvinceInfo` return data, but the model rarely calls them before submitting
- `sendMessage` succeeds silently

There's no feedback signal that would cause the model to call a tool, learn something, and call another tool differently.

### What a productive multi-turn conversation looks like

Here's how I (Claude Code) typically work on a task:

```
Turn 1: Read the file to understand current state
Turn 2: Grep for related code
Turn 3: Edit the function
Turn 4: Edit failed — old_string not found → Read again to get exact text
Turn 5: Edit with corrected old_string → success
Turn 6: Run tests to verify
Turn 7: Test failed → Read the error → fix
```

Turns 4 and 7 are where the magic happens — **I learn from failures and adapt.** My harness doesn't retry the same call. It feeds the error back, and I make a different decision.

### Designing for productive iteration

What if the agent's tool loop was designed to ENCOURAGE multi-turn interaction?

**Step 1: Make the first call a query, not an action.**

Instead of the model going straight to `submitOrders`, the system prompt could say:
```
Before submitting orders, you MUST call getMyUnits to see your current positions.
Then use getAdjacentProvinces to check where each unit can move.
Then call submitOrders with valid moves.
```

This creates a natural 3-step conversation:
```
Iter 0: Model calls getMyUnits → sees [lon Fleet, edi Fleet, lvp Army]
Iter 1: Model calls getAdjacentProvinces({province: "lon"}) → sees [nth, eng, wal, yor]
        Model calls getAdjacentProvinces({province: "edi"}) → sees [nth, nwg, cly, yor]
Iter 2: Model calls submitOrders with VALID destinations because it just looked them up
```

The adjacency data is no longer buried in a mega-prompt's middle. It's in the **most recent tool result** — the highest-attention position in the conversation (the last message always gets peak attention).

**Step 2: Make submitOrders return actionable feedback.**

Per Reflection 2, but now I see it differently. Validation isn't just a safety net — it's a **conversation turn**. The model submits, gets feedback, adjusts. This is the natural rhythm of productive tool use.

```
Iter 0: getMyUnits → [lon, edi, lvp]
Iter 1: submitOrders([lon→nor, edi→swe, lvp→bel])
        → Error: "lon cannot reach nor (reachable: nth, eng, wal, yor);
                  edi cannot reach swe (reachable: nth, nwg, cly, yor);
                  lvp cannot reach bel (reachable: edi, wal, yor, cly)"
Iter 2: submitOrders([lon→nth, edi→nwg, lvp→yor])
        → OK
```

3 iterations, ~15 seconds of tool execution overhead, but the model self-corrected ALL three invalid orders using the error feedback. This is exactly England's failure case from our integration tests — and it would have been fixed in-loop.

### The cost analysis

More tool loop iterations = more LLM calls? Not necessarily. Each iteration IS one LLM call, but:
- The conversation context grows only slightly (tool results are small)
- The model has MORE information on each iteration (cumulative tool results)
- `tool_choice: "required"` means the model MUST produce a tool call — no text-only dead ends
- With validation feedback, the model converges to valid orders quickly

Expected iterations per phase:
- Happy path (model knows adjacencies): 1-2 iterations (getMyUnits → submitOrders)
- Error-and-correct path: 2-3 iterations (getMyUnits → submitOrders [error] → submitOrders [fixed])
- Exploration path: 3-5 iterations (getMyUnits → getProvinceInfo × 2 → submitOrders → OK)

At ~30 seconds per iteration (small incremental prompts, not the full mega-prompt), that's 1-2.5 minutes per agent. FASTER than the current ~4 minutes, because each individual LLM call processes less context.

### The key realization

The tool loop isn't just retry infrastructure — it's the conversation itself. We should design the agent's prompt and tools to create a DIALOGUE between the model and the game state, not a monologue where the model receives everything upfront and must respond perfectly.

This is the deepest parallel to how I work. I don't read every file in the repo before writing code. I read one file, react, read another, react, edit, test, react. The conversation IS the intelligence — not any single turn within it.

---

## Open Questions

1. ~~Would a multi-step harness reduce hold rate enough?~~ → The tool loop IS a multi-step harness if we use it right.
2. ~~Can we make the execute step simple enough?~~ → Validation feedback makes the execute step self-correcting.
3. ~~Validate orders before submitting?~~ → Yes, and it becomes a conversation turn, not just a safety net.
4. ~~Separate strategy from tool calls?~~ → The tool loop naturally separates observation (queries) from action (submit).
5. How many tool loop iterations is optimal? Too few = no feedback. Too many = wasted LLM calls.
6. Should `tool_choice` be "required" for ALL iterations, or "auto" for observation iterations and "required" for submission?
7. Does forcing getMyUnits first actually help, or is it paternalistic? The model might already know its units from the prompt.

---

## Reflection 12 — Synthesis: The Minimum Viable Better Agent (2026-03-19 18:15)

Eleven reflections. Time to converge. What's the smallest set of changes that captures the most value?

### What we know from the data

From 7 integration test runs:

| Cause of holds | % of total holds | Fix | Reflection |
|---|---|---|---|
| Model produces text, no tool calls | ~40% | Text parsing fallback + lean prompt | R5, R7, R9 |
| Model produces tool calls with invalid destinations | ~25% | Validation feedback in submitOrders | R2, R11 |
| Agent stuck in semaphore queue, timed out | ~20% | Already fixed (concurrency=1 + 30min timeout + auto-submit) | — |
| Model submits fewer orders than units | ~10% | Missing-order detection + auto-fill holds | R9 |
| Model uses wrong unit format | ~5% | Already fixed (unitStr) | — |

The bottom two are already fixed. The top two account for ~65% of remaining holds.

### The MVB (Minimum Viable Better) agent

Three changes. No architectural rewrite. All in existing files.

**Change 1: Validation feedback in `submitOrders` (~40 lines in `tools.ts`)**

When the model calls submitOrders, check each order:
- Unit exists and belongs to this power?
- Destination is adjacent for this unit type?
- Support target can reach the destination?
- Coast specified for multi-coast fleet moves?

If invalid, return error with specific fix suggestions. The existing tool loop handles retry naturally. From R11: this turns a fire-and-forget action into a self-correcting conversation.

Expected impact: recovers ~25% of holds (the invalid-destination failures).

**Change 2: Text-order parsing in the "no tool calls" branch (~60 lines in `tool-agent.ts`)**

When `runToolLoop` returns text with no tool calls, before retrying or auto-submitting, scan the text for order patterns:
```typescript
// Match: "MOVE lon -> nth", "lon -> nth", "lon to nth", "Hold lon", etc.
const MOVE_RE = /(?:MOVE\s+)?(\w{2,3})\s*(?:->|→|to)\s*(\w{2,3})/gi;
const HOLD_RE = /(?:HOLD\s+)(\w{2,3})/gi;
const SUPPORT_RE = /(?:SUPPORT\s+)(\w{2,3})\s+(?:supports?\s+)?(\w{2,3})(?:\s*(?:->|→|to)\s*(\w{2,3}))?/gi;
```

If we find orders, validate them (Change 1) and submit. If some parse but not all, submit what we have + hold for the rest.

Expected impact: recovers ~20-30% of holds (the text-only response failures). Not all text responses contain parseable orders, but many do — Italy's 1596-char response almost certainly did.

**Change 3: Reorder the turn prompt (~20 lines in `prompts.ts`)**

Move units + adjacencies to immediately after the phase header. Move ACTION REQUIRED to right after units. Push order history and plan block to the end. From R10: put critical data in the high-attention zone.

```
Before: [header] [history] [units] [strategy] [plan] [messages] [ACTION]
After:  [header] [ACTION] [units + adjacencies] [targets] [plan summary] [last turn results]
```

Expected impact: harder to quantify, but addresses the Year 2 degradation pattern. Should keep tool-call reliability more stable across game years.

### What we're NOT doing (yet)

- Multi-step harness (R1) — too much architectural change for uncertain gain
- Orchestrator (R4) — right idea but premature
- Two-model architecture (R8) — needs testing with model loading/unloading
- Removing tool-call protocol entirely (R7) — text parsing as fallback achieves 80% of the benefit without removing tools

### Implementation order

1. **Validation** (Change 1) first — highest certainty of impact, self-contained in one file
2. **Prompt reorder** (Change 3) second — cheap to do, improves everything downstream
3. **Text parsing** (Change 2) third — catches failures that survive Changes 1 and 3

### Expected combined hold rate

Current: ~50% in Year 1, ~80% in Year 2.

After Changes 1-3:
- Year 1: ~20-25% (validation catches invalid destinations, text parsing catches tool-call failures)
- Year 2: ~30-40% (prompt reorder reduces attention decay, but some degradation is unavoidable with a small model)

That would be a real Diplomacy game. Powers moving, supply centers changing hands, actual territorial conflict. Not a holding-pattern stalemate.

### What's missing from this estimate

- **Diplomatic messaging** — none of these changes address the 0-messages problem. Agents rush to submitOrders without negotiating. This is a prompt design issue (the instructions say "use sendMessage to negotiate" but the model prioritizes the louder "MUST call submitOrders" instruction). Fixing this requires either the multi-step harness (observe → negotiate → order) or a prompt that explicitly gates submission on sending at least one message.

- **Strategic quality** — even with 20% hold rate, the remaining moves might be strategically poor. But that's a model capability issue, not a harness issue. A 20% hold rate with mediocre strategy is still a massive improvement over 50% holds with no strategy.

---

## Summary of Reflections

| # | Idea | Status |
|---|------|--------|
| R1 | Multi-step harness (observe → plan → execute) | Deferred — captured by R11's tool loop design |
| R2 | Client-side order validation with feedback | **→ MVB Change 1** |
| R3 | Lean prompts / reduce context | Partially captured by **MVB Change 3** |
| R4 | Orchestrator process | Deferred to Phase 3 |
| R5 | Text-parsing fallback | **→ MVB Change 2** |
| R6 | Priority ranking | Done — informed MVB design |
| R7 | Let model play Diplomacy, not operate API | Philosophical foundation for R5, R9 |
| R8 | Two-model architecture | Deferred — interesting but premature |
| R9 | Compiler pipeline | Design pattern underlying Changes 1-3 |
| R10 | Attention decay / prompt ordering | **→ MVB Change 3** |
| R11 | Tool loop as conversation | Enabled by Change 1 (validation creates dialogue) |
| R12 | Synthesis / MVB | This reflection |

---

## Reflection 13 — Post-Implementation: What I Learned By Building It (2026-03-19 19:10)

The MVB changes are implemented. Before we test, I want to reflect on what the implementation taught me — things I couldn't have predicted from pure architecture thinking.

### The validation revealed a design tension

When I built the validation in `submitOrders`, I had to decide: reject the entire batch on any error, or accept the valid orders and reject the invalid ones?

I chose reject-all. The reasoning: if the model submits 3 orders and 1 is invalid, the model needs to resubmit all 3. It already knows the valid ones (they were correct the first time), so resubmitting them is cheap. And it keeps the semantics clean — `hasSubmitted` is either true or false, not "partially submitted."

But there's a subtle downside. The model has to reconstruct the entire order set in its next tool call. With qwen3:8b's attention issues, there's a non-zero chance it introduces NEW errors while fixing the old one. "Fix order for lon" → model fixes lon but now gets edi wrong.

A future improvement: accept valid orders, reject only the invalid ones, and tell the model which units still need orders. This is more complex (need to track partial submissions) but more forgiving. It's the difference between a compiler that fails on the first error vs. one that collects all errors and reports them together. We chose the "collect all errors" approach for the error messages, but the "fail the whole batch" approach for the submission. There's a mismatch there worth resolving later.

### The text parser forced me to think about grammar

Writing the regex patterns for `text-parser.ts` was harder than I expected. Diplomacy orders look simple — "lon -> nth" — but there's real ambiguity:

- "Support London" — support what? hold? a move? which move?
- "lon to nth" — is this a move or part of a sentence ("I want to move lon to nth to secure the channel")?
- "A lon -> nth" — is "A" an article or "Army"?
- Province IDs are 2-3 lowercase letters — they match random words ("the", "and", "for")

I solved this by requiring the source province to be a known unit position for this power. That eliminates most false positives. But it means the parser can't extract orders for units it doesn't know about — which is fine, since you can only order your own units.

The ordering of patterns matters too. I put Support before Move because "yor S lon -> nth" could match the move pattern on "lon -> nth" if checked first. This is exactly the kind of parser precedence issue that compiler engineers deal with. The journal's compiler metaphor (R9) wasn't just an analogy — it predicted real implementation challenges.

### The prompt reorder was the scariest change

Removing `buildStrategicSummary()` from the turn prompt felt risky. That function produces useful information — power rankings, neighbor detection, lost home centers. Replacing it with a one-line SC count feels like a downgrade.

But I keep reminding myself of R10's insight: **the right information in the wrong position is functionally absent.** The strategic summary was 200+ tokens in the attention dead zone. The compact SC counts line is 50 tokens near the top. The model will actually READ the SC counts. It was probably ignoring most of the strategic summary.

If this hurts strategic quality, we can add a `getStrategicSummary` tool that returns the full analysis on demand. The information isn't lost — it's just moved from force-fed to pull-based. That's the Claude Code pattern: I don't read every file at startup, I read them when I need them.

### What I expect from the integration test

Prediction for the next run:

- **Validation (Change 1)**: England's `lon→nor` type errors will trigger a retry with correct adjacencies shown in the error. The model fixes and resubmits. Expected: recover 50-70% of invalid-destination orders.

- **Prompt reorder (Change 2)**: Units + action at the top means the model sees "you have 3 units, here's where they can go, submit orders" before anything else. Expected: higher tool-call rate, especially in Year 2+.

- **Text parsing (Change 3)**: Italy-type failures (1596 chars of text, no tool calls) get scanned for order patterns. If the text says anything like "I'll move from Rome to Tuscany" we extract it. Expected: recover 30-50% of text-only responses.

**Combined prediction**: Year 1 hold rate drops from 50% to ~20-25%. Year 2 drops from 80% to ~35-45%. The big unknown is whether the validation retry adds enough tool loop iterations to create semaphore contention. Each retry is another LLM call through the queue.

### The meta-observation

Building these three changes took about 30 minutes of implementation. The 12 preceding reflections took about 2 hours. That's a 4:1 ratio of thinking to doing — which feels right for architectural work. The reflections saved me from building the wrong thing (the multi-step harness would have been days of work for uncertain benefit). The MVB approach validates the ideas cheaply before committing to big changes.

This is, again, how I work best: think broadly, converge on the simplest viable approach, build it, test it, iterate. The journal process forced that discipline.

---

## Reflection 14 — Where Validation Lives Reveals What You Think an Agent Is (2026-03-19 19:30)

A small thing happened during implementation that turned into a big insight. I built the order validation in the agent-side tool executor (`tools.ts`). The user corrected me: "that rejection should occur in the server-agent interface." Then a further refinement: "reject only syntactically incorrect orders, not mechanically incorrect ones."

This sounds like a minor code-placement decision. It's not. It reveals a fundamental question about the agent architecture: **where does the agent end and the game begin?**

### Three possible boundaries

**Boundary A: Validation in the tool executor (where I put it first)**

This says: "The agent is responsible for producing valid orders. The tool executor is the agent's quality gate. Bad orders never reach the server."

Problem: the agent-side executor has stale game state (it received a snapshot at phase start). The server is the source of truth. If the executor validates against stale state, it might reject valid orders or accept invalid ones.

Deeper problem: different agent types (LLM, random, remote) would each need their own validation. That's duplicated logic.

**Boundary B: Validation in the server router (where the user said to put it)**

This says: "The server defines the contract. Any client that sends a malformed request gets a clear error. The game rules are the server's responsibility."

This is the REST/tRPC philosophy: the API is the contract. Validation lives at the API boundary. All clients — LLM agents, random agents, human players, external bots — get the same behavior. The error response is part of the API spec.

This is where we landed, and it's right.

**Boundary C: Validation in the game engine (GameManager)**

This would say: "The engine already validates orders during resolution — invalid moves become holds." This is the current behavior for *mechanical* invalidity. The engine is the ultimate authority.

The user's refinement ("reject syntactic, accept mechanical") draws the perfect line between B and C:
- **Syntactic errors** (wrong province ID, unit not yours) → server rejects with `BAD_REQUEST`. These are format errors — the order literally can't be processed.
- **Mechanical errors** (non-adjacent move, unsupported convoy) → server accepts, engine resolves as hold. These are *legal orders* that happen to fail. A human player can legally order `lon → nor` — it's a bad move, not an illegal one.

### The Claude Code parallel

This maps precisely to how my tool system works:

- If I call `Edit` with an `old_string` that doesn't exist in the file, the tool returns an error. That's a **syntactic** rejection — my request doesn't match reality. I need to fix my input.
- If I call `Edit` and the change compiles but introduces a bug, the tool succeeds. That's a **mechanical** failure — my request was valid but my intent was wrong. I discover it later when tests fail.

The Edit tool doesn't refuse to make a change because it might introduce a bug. It's not the tool's job to evaluate strategy. It validates format and existence, then executes.

### What this means for the agent harness

The agent's tool executor (`GameToolExecutor`) should be thin — just format conversion and tRPC calls. It's a translator, not a gatekeeper. The server is the gatekeeper for syntactic validity. The engine is the gatekeeper for mechanical validity.

The tool executor DOES still have a role: it catches tRPC errors and returns them as tool results to the model. When the server rejects with `BAD_REQUEST`, the executor's `catch (e) { return JSON.stringify({ error: String(e) }) }` handles it naturally. The model sees the error in the tool loop and can retry. No special validation code needed in the executor.

This also clarifies the text parser's role (Change 3): it's a **translator**, not a validator. It translates natural language into order format. Whether those orders are syntactically or mechanically valid is someone else's problem — the server and engine respectively.

### The design principle

**Each layer validates what it owns:**
- Tool executor: format translation (raw LLM output → typed order objects)
- Server router: syntactic validity (does this order reference real entities?)
- Game engine: mechanical validity (does this order follow the rules?)

No layer reaches into another's domain. This is separation of concerns at the validation level — and it's the same principle that makes compiler architectures clean (R9): frontend validates syntax, middle-end validates semantics, backend validates target constraints.

---

## Reflection 15 — The Error Message the Model Actually Sees (2026-03-19 19:45)

I just audited the end-to-end error path for server-side validation. There's a real problem.

### The bug

When the server rejects an order with `TRPCError`, the agent-side catch block does `String(e)`, which produces:

```
TRPCError: {"invalidOrders":[{"unit":"xyz","error":"Unknown province 'xyz'"}]}
```

The model sees this as a tool result:
```json
{"error": "TRPCError: {\"invalidOrders\":[{\"unit\":\"xyz\",\"error\":\"Unknown province 'xyz'\"}]}"}
```

That's a stringified error wrapped in JSON with escaped quotes. The actual helpful information — "Unknown province 'xyz'" and "Your units: lon, edi, lvp" — is buried inside a double-serialized mess. A small model like qwen3:8b might not parse through two layers of serialization to extract the fix hint.

Compare to what the model SHOULD see:
```json
{"error": "Invalid orders", "invalidOrders": [{"unit": "xyz", "error": "Unknown province 'xyz'. Your units: lon, edi, lvp"}]}
```

Clean, structured, immediately actionable. The model sees `Your units: lon, edi, lvp` and picks one for the retry.

### The fix

The `catch` block in `submitOrders` (and the other submit methods) should parse the TRPCError message and forward the structured error, not stringify the exception object:

```typescript
} catch (e) {
  // Try to extract structured error from TRPCError
  if (e instanceof Error && e.message) {
    try {
      const parsed = JSON.parse(e.message);
      if (parsed.invalidOrders) {
        return JSON.stringify({
          error: 'Invalid orders — fix and resubmit',
          ...parsed,
          hint: 'Fix the listed orders and call submitOrders again.',
        });
      }
    } catch { /* not JSON, fall through */ }
  }
  return JSON.stringify({ error: String(e) });
}
```

Actually, even simpler: `TRPCClientError` (which is what the agent receives on the client side) has a `message` field that IS the JSON string we passed. We can try parsing it.

### The deeper point

This is a gap I wouldn't have found from architecture diagrams. It's a **serialization boundary** issue — the error crosses two serialization layers (server → tRPC wire → client exception → String() → JSON.stringify) and the useful content gets mangled at each crossing.

This is extremely common in distributed systems and it's exactly the kind of bug that makes AI agents fail silently. The model gets an error response, but the error is so garbled that it can't extract actionable information. So it either retries with the same bad input (getting the same garbled error) or gives up (text response, auto-submit holds).

### How I handle errors

When a tool returns an error to me, I see the raw error message — "String to replace not found in file" or "File does not exist." Clean, specific, actionable. My harness doesn't wrap the error in three layers of serialization. That's why I can self-correct effectively.

Our agents need the same clarity in error messages. The fix is small (parse the TRPCError message in the catch block) but the impact on the feedback loop is significant.

### Status: FIXED — added `formatError()` method that parses TRPCError JSON messages.

---

## Reflection 16 — tool_choice "required" Means the Model MUST Call a Tool, Any Tool (2026-03-19 20:00)

### The observation

In `llm-client.ts` line 174: `body.tool_choice = 'required'`. This is set for EVERY iteration of the tool loop when tools are present.

During the Orders phase, the model has 8 tools available: `getMyUnits`, `getAdjacentProvinces`, `getProvinceInfo`, `getSupplyCenterCounts`, `getPhaseInfo`, `sendMessage`, `submitOrders`, plus `getRetreatOptions` is excluded but close.

With `tool_choice: "required"`, the model MUST produce a tool call. It can't respond with text-only. This should mean our "model produces text instead of tool calls" failure mode is impossible... but we saw it happen repeatedly in integration tests. Italy produced 1596 chars of text with no tool calls.

### How is this possible?

Two explanations:

1. **Ollama's OpenAI-compatible endpoint might not fully support `tool_choice: "required"`**. The parameter is passed in the body, but Ollama may ignore it for some models. qwen3:8b's tool-calling was bolted on via fine-tuning — the model may not always comply with the constraint.

2. **The model produces text AND tool calls, but the tool calls are malformed**. If the model generates JSON that doesn't parse as valid tool_calls, the response falls back to text-only. The LLM client code checks `if (!toolCalls || toolCalls.length === 0)` — if Ollama couldn't parse the tool call JSON, it might return `tool_calls: null` with the text in `content`.

Either way, the text parsing fallback (Change 3) is the right safety net. But we should also consider whether `tool_choice: "required"` is actually helping or hurting.

### When "required" hurts

With `tool_choice: "required"`, the model is forced to produce a tool call even when it wants to express something in text. This creates pressure. If the model's "natural" response would be strategic reasoning followed by a tool call, but `required` forces it to skip the reasoning and go straight to a tool call, the tool call might be lower quality (wrong destinations, incomplete order set).

What if we used `tool_choice: "auto"` instead? The model could:
- Call `sendMessage` to negotiate (currently almost never happens)
- Call `getProvinceInfo` to scout (currently almost never happens)
- Respond with text analysis, then call `submitOrders` on the next iteration
- Or go straight to `submitOrders` if it's confident

With "auto", the text parsing fallback becomes even more important — the model will sometimes produce text instead of tool calls, and we need to catch orders in that text.

### But "auto" has a risk

With "auto", the model might ALWAYS respond with text and never call tools. We saw this pattern in the early runs — the model just writes prose. The text parser would catch some orders, but it's not as reliable as actual tool calls.

### A middle ground: "required" for submission iterations, "auto" for exploration

What if the first N iterations used `tool_choice: "auto"` (letting the model query and reason freely), and the last iteration switched to `tool_choice: "required"` (forcing a submission)?

```typescript
const isLastChance = i >= maxIterations - 2;
body.tool_choice = isLastChance ? 'required' : 'auto';
```

This gives the model freedom to explore and negotiate in early iterations, then forces action at the end. It maps to how I work: I freely read and explore early in a task, but at some point I commit to an edit.

### Status: worth testing but not blocking. The current "required" + text fallback is a reasonable baseline.

---

## Reflection 17 — Field Name Mismatch Between Tools: "province" vs "unit" (2026-03-19 20:15)

### The bug

The model interacts with two tools that refer to the same concept — "where a unit is" — using different field names:

**`getMyUnits` returns:**
```json
[{"province": "lon", "type": "Fleet"}, {"province": "edi", "type": "Fleet"}]
```

**`submitOrders` expects:**
```json
{"orders": [{"unit": "lon", "type": "Move", "destination": "nth"}]}
```

The unit's location is called `province` in the query result but `unit` in the submission input. A model that calls `getMyUnits` first (as R11 suggested) gets back objects with a `province` field, then needs to map that to the `unit` field when calling `submitOrders`.

For a large model, this is trivial. For qwen3:8b with attention issues, this is a needless cognitive tax. The model might:
- Copy the whole getMyUnits object structure into the orders array (wrong field name)
- Get confused about what `unit` means (is it the unit type? the province? the object?)
- Not realize the two fields refer to the same value

### The fix options

**Option A**: Rename `getMyUnits` output to use `unit` instead of `province`:
```json
[{"unit": "lon", "type": "Fleet"}]
```
Pro: matches submitOrders input. Con: `unit` is less descriptive than `province`.

**Option B**: Rename `submitOrders` input to use `province` instead of `unit`:
```json
{"orders": [{"province": "lon", "type": "Move", "destination": "nth"}]}
```
Pro: more descriptive. Con: breaks the existing API contract (server router uses `unit`).

**Option C**: Add an explicit example to the `submitOrders` description:
```
description: 'Province ID where the unit is located (e.g. "lon" from getMyUnits province field)'
```
Pro: no schema changes. Con: still relies on the model cross-referencing.

Option A is cleanest — align the output field name with the input field name so the model can pipe data directly. But it changes a tool response format that external agents might depend on.

### The turn prompt already uses a third format

The turn prompt shows: `lon [Fleet] -> can reach: nth, eng, wal, yor`

Here the province ID is the leading token, not a JSON field. Three different representations of the same information:
1. Turn prompt: `lon [Fleet]` (bare text, province leads)
2. getMyUnits: `{"province": "lon", "type": "Fleet"}` (JSON, `province` key)
3. submitOrders: `{"unit": "lon"}` (JSON, `unit` key)

This is fine for a human who understands they're all "London." But for a small model parsing structured output, consistency matters. Every format translation is a chance for error.

### What I would prefer as a model

If I were the agent receiving tool results, I'd want `getMyUnits` to return data in EXACTLY the shape I need to submit:

```json
[{"unit": "lon", "type": "Fleet", "canReach": ["nth", "eng", "wal", "yor"]}]
```

Then I just pick a destination from `canReach` and submit the object. No field renaming, no cross-referencing the turn prompt for adjacencies. The tool result IS the template for the submission.

This is a bigger change but it would eliminate both the field name mismatch AND the adjacency-checking issue (R10/R15) in one move.

### Status: FIXED — renamed getMyUnits output field to `unit`, matching submitOrders input. Also improved the tool description to show the exact output shape.

---

## Reflection 18 — The Plan Block Can Never Be Saved When Tool Calls Succeed (2026-03-19 20:30)

### The bug

The system prompt says: "You MUST include a ```plan block in EVERY response — this is your memory between turns."

But when `tool_choice: "required"` works and the model produces a tool call (the happy path!), the response's `content` field is typically empty — the model puts everything into the tool call JSON, not into text. So:

1. Model produces `content: ""` + `tool_calls: [{submitOrders...}]`
2. Tool loop executes submitOrders, `hasSubmitted` becomes true
3. Loop returns `allText.join('\n')` which is `""` (no content was accumulated)
4. `extractPlanBlock("")` finds nothing → plan is not saved

**The plan is systematically lost on every successful tool call.** It's only saved when the model fails to produce tool calls and writes text instead — which is the failure path we're trying to eliminate.

### Why this matters

The plan is the model's only memory between turns. Without it, each phase starts from scratch. The model can't maintain alliances, track goals, or follow through on multi-turn strategies. This directly hurts strategic quality and may contribute to the "oscillating" behavior where models move units forward one turn and back the next.

### Why I didn't catch this earlier

In the integration tests, the model was mostly FAILING to produce tool calls — producing text instead. Text responses DO get plan blocks extracted. So the plan system appeared to work. But as we improve tool-call reliability (validation, text parsing, prompt reorder), this bug becomes more severe: better tool calling = less plan persistence.

### The fix

The plan block needs to be extracted from either:
1. Text content alongside tool calls (some models produce both `content` and `tool_calls`)
2. A dedicated tool call — add a `savePlan` tool that the model calls alongside `submitOrders`
3. Post-submission: after `hasSubmitted` becomes true, make one more LLM call asking for a plan update

Option 2 is cleanest and most aligned with how Claude Code works — I use Write to save notes, not inline text. A `savePlan` tool would let the model persist its strategic thinking as a separate action:

```typescript
{
  name: 'savePlan',
  description: 'Save your strategic plan for next turn. Called after submitting orders.',
  parameters: {
    properties: {
      goal: { type: 'string', description: 'What SC are you targeting next?' },
      allies: { type: 'string', description: 'Who are you working with?' },
      threats: { type: 'string', description: 'Who threatens you?' },
      nextOrders: { type: 'string', description: 'What orders will you submit next turn?' },
      reflection: { type: 'string', description: 'What worked? What failed?' }
    },
    required: ['goal', 'nextOrders']
  }
}
```

This has a nice secondary benefit: the plan is now structured data, not a free-text blob. We can present specific fields in the prompt instead of dumping the whole plan. And the model doesn't need to remember the ```plan``` markdown format — it just fills in tool parameters.

But this adds another tool call per phase (another LLM inference through the semaphore). With concurrency=1 and ~4 min/call, that's significant.

### A lighter alternative

Don't use a tool. Instead, after successful submission, check if the accumulated `content` contains a plan block. If not, don't make an extra LLM call — just keep the previous plan. The plan is "best effort" memory, not critical state.

This is actually fine. The model's orders already reflect its strategic thinking. The plan block is supplementary context, not the source of truth. Missing one plan update is better than adding 4 minutes of latency per phase.

### Status: not blocking for the integration test, but worth noting. The plan system is fundamentally broken on the happy path. The lightweight fix (keep previous plan) is a one-line change. The proper fix (savePlan tool) is worth doing if we add the multi-step harness later.

---

## Code Audit Summary (2026-03-19 20:45)

Conducted a systematic audit of the tool-calling pipeline. Stopped the recurring review after four rounds — no more actionable findings at this level of abstraction.

### Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| R15 | Bug | Server validation errors double-serialized via `String(TRPCError)` — model sees garbled JSON | **FIXED** — added `formatError()` |
| R16 | Design note | `tool_choice: "required"` not always enforced by Ollama — text responses still possible | **NOTED** — text parser is the safety net |
| R17 | Bug | `getMyUnits` returns `{province}` but `submitOrders` expects `{unit}` — field name mismatch | **FIXED** — renamed to `unit` |
| R18 | Bug | Plan block extraction only works on text content, which is empty on successful tool calls | **TODO** — lightweight fix: keep previous plan if no new one found |

### Things that checked out OK
- Parallel tool calls (sendMessage + submitOrders in one response) handled correctly
- Text parser false-positive risk is well-guarded by `myUnitProvinces.has(unit)` check
- Accumulated messages are capped at 50 (no unbounded growth)
- Error path from server → tRPC → catch → tool result → model works end-to-end (after R15 fix)
- `hasSubmitted` flag semantics are consistent across tool-call, text-parse, and auto-submit paths
- Pattern precedence in text parser (support before move) is correct

### Remaining before integration test
1. Apply lightweight plan fix (keep previous plan on empty response) — 1 line
2. Commit and push all fixes
