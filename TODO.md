# TODO — Agent Architecture Improvements

## Multi-Step Agent Harness (Observe → Plan → Execute)

**Problem**: Agents get one mega-prompt and must produce structured JSON tool calls in a single LLM response. With qwen3:8b, this fails ~50% of the time — the model generates text instead of tool calls, or the prompt is too complex for reliable structured output.

**Proposal**: Break each agent turn into 3 focused LLM calls:

1. **Observe** — Small prompt with board state. Model responds with text analysis (threats, opportunities, ally positions). No tools needed.
2. **Plan** — Feed the observation back. Model responds with natural language orders ("move army from Vienna to Budapest, support with Trieste"). No tools needed.
3. **Execute** — Tiny prompt: "Convert these orders to JSON and call submitOrders." Nearly guaranteed to produce valid tool calls because it's just format conversion.

**Why it works**: Separates "strategic thinking" (hard, benefits from reasoning) from "JSON formatting" (easy, just needs the right schema). The execute step is so simple even a 3B model could do it.

**Trade-off**: 3x LLM calls per agent per phase. With concurrency=1 and 7 agents: 21 calls × ~2 min = ~42 min/phase (vs current ~25 min). But hold rate should drop dramatically.

**Concern**: `maxIterations=30` in the tool loop limits total tool calls. But this approach would be OUTSIDE the tool loop — it's 3 sequential `llm.complete()` / `llm.runToolLoop()` calls managed by the harness, not 3 iterations within one loop. The tool loop would only be used for step 3 (execute), where 1-2 iterations is plenty.

**Implementation sketch**:
```
async function handlePhase(gameState, power) {
  // Step 1: Observe (no tools, just text completion)
  const observation = await llm.complete([
    { role: 'system', content: observePrompt },
    { role: 'user', content: buildBoardState(gameState, power) }
  ]);

  // Step 2: Plan (no tools, just text completion)
  const plan = await llm.complete([
    { role: 'system', content: planPrompt },
    { role: 'user', content: observation + '\n' + buildConstraints(gameState, power) }
  ]);

  // Step 3: Execute (tool loop, but tiny focused prompt)
  await llm.runToolLoop([
    { role: 'system', content: 'Convert the following orders to JSON and call submitOrders.' },
    { role: 'user', content: plan }
  ], [submitOrdersTool], executor);

  // Auto-submit if execute step fails
  if (!executor.hasSubmitted) { autoSubmitDefaults(); }
}
```

## Structured Memory / Context Retrieval

**Problem**: The prompt grows every phase with full order history, strategic summary, plan blocks, and message history. By year 2, qwen3:8b can't handle the complexity and stops producing tool calls.

**Proposal**: Instead of stuffing everything into the prompt, give agents memory tools they can call on demand:

- `getMyStrategy()` — returns the agent's persisted strategic notes
- `getRelationship(power)` — returns alliance/threat assessment for a specific power
- `getLastTurnResults()` — returns just the most recent order resolutions
- `getSupplyCenterMap()` — returns current SC ownership

The base prompt stays small (current board state + your units + adjacencies). The agent pulls deeper context only when it needs it.

**Concern**: Each memory retrieval is a tool call round-trip, adding latency. But the prompts stay small and focused, so each LLM call is faster and more reliable.

## Order Validation Before Submission

**Problem**: Agents submit orders with invalid destinations (e.g., lon→nor when nor isn't adjacent). The engine silently converts these to holds.

**Proposal**: Add client-side validation in `GameToolExecutor.submitOrders()`:
- Check each order's unit exists and belongs to this power
- Check destination is adjacent for the unit type
- If invalid, return an error message to the LLM instead of submitting
- The tool loop continues, giving the model a chance to fix the order

This is essentially what happens when I (Claude Code) get a tool error — I see the error and adjust. Currently the agents never learn their orders were invalid because the engine accepts them silently.

## Reduce maxTokens for Faster Calls

**Problem**: maxTokens=16384 means each LLM call can generate up to 16k tokens. Most responses are <2k tokens. The large limit just means Ollama allocates more KV cache and each call takes longer.

**Proposal**: Try maxTokens=4096 with the multi-step harness. Each step produces a focused, shorter response. If thinking mode needs more room, the observe/plan steps can have higher limits while the execute step uses maxTokens=1024.
