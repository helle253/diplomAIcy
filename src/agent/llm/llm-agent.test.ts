import { describe, expect, it } from 'vitest';

import { STARTING_SUPPLY_CENTERS, STARTING_UNITS } from '../../engine/map.js';
import {
  Coast,
  GameState,
  OrderType,
  Phase,
  PhaseType,
  Power,
  RetreatSituation,
  SupportOrder,
  Season,
  UnitType,
} from '../../engine/types.js';
import { LLMAgent } from './llm-agent.js';
import { ChatMessage, LLMClient } from './llm-client.js';
import {
  extractJSON,
  parseBatchNegotiationResponse,
  parseBuildOrders,
  parseMessages,
  parseOrders,
  parseRetreats,
} from './order-parser.js';
import { buildOrdersPrompt, buildSystemPrompt, serializeGameState } from './prompts.js';

// ============================================================================
// Helpers
// ============================================================================

function makeState(overrides?: Partial<GameState>): GameState {
  return {
    phase: { year: 1901, season: Season.Spring, type: PhaseType.Orders },
    units: STARTING_UNITS.map((u) => ({ ...u })),
    supplyCenters: new Map(STARTING_SUPPLY_CENTERS),
    orderHistory: [],
    retreatSituations: [],
    endYear: 1910,
    ...overrides,
  };
}

class MockLLMClient implements LLMClient {
  responses: string[] = [];
  calls: ChatMessage[][] = [];

  addResponse(response: string): void {
    this.responses.push(response);
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages);
    const response = this.responses.shift();
    if (!response) throw new Error('No mock response available');
    return response;
  }
}

// ============================================================================
// extractJSON
// ============================================================================

describe('extractJSON', () => {
  it('extracts from fenced code block', () => {
    const text = 'Here are the orders:\n```json\n[{"unit": "par", "type": "hold"}]\n```';
    const result = extractJSON(text);
    expect(result).toEqual([{ unit: 'par', type: 'hold' }]);
  });

  it('extracts from fenced block without json label', () => {
    const text = '```\n[{"unit": "par", "type": "hold"}]\n```';
    const result = extractJSON(text);
    expect(result).toEqual([{ unit: 'par', type: 'hold' }]);
  });

  it('extracts raw JSON array', () => {
    const text = 'Sure! [{"unit": "par", "type": "hold"}]';
    const result = extractJSON(text);
    expect(result).toEqual([{ unit: 'par', type: 'hold' }]);
  });

  it('returns empty array for unparseable text', () => {
    const result = extractJSON('I have no idea what to do');
    expect(result).toEqual([]);
  });

  it('handles empty array', () => {
    const result = extractJSON('```json\n[]\n```');
    expect(result).toEqual([]);
  });
});

// ============================================================================
// parseOrders
// ============================================================================

describe('parseOrders', () => {
  it('parses hold orders', () => {
    const state = makeState();
    const text = '```json\n[{"unit": "par", "type": "hold"}]\n```';
    const orders = parseOrders(text, state, Power.France);
    const parOrder = orders.find((o) => o.unit === 'par');
    expect(parOrder).toEqual({ type: OrderType.Hold, unit: 'par' });
  });

  it('parses move orders', () => {
    const state = makeState();
    const text = '```json\n[{"unit": "par", "type": "move", "destination": "bur"}]\n```';
    const orders = parseOrders(text, state, Power.France);
    const parOrder = orders.find((o) => o.unit === 'par');
    expect(parOrder).toEqual({
      type: OrderType.Move,
      unit: 'par',
      destination: 'bur',
      coast: undefined,
    });
  });

  it('parses support orders', () => {
    const state = makeState();
    const text =
      '```json\n[{"unit": "mar", "type": "support", "supportedUnit": "par", "destination": "bur"}]\n```';
    const orders = parseOrders(text, state, Power.France);
    const marOrder = orders.find((o) => o.unit === 'mar');
    expect(marOrder).toEqual({
      type: OrderType.Support,
      unit: 'mar',
      supportedUnit: 'par',
      destination: 'bur',
    });
  });

  it('normalizes support-move-to-self as support-hold', () => {
    const state = makeState();
    // LLMs sometimes emit destination === supportedUnit for support-hold
    const text =
      '```json\n[{"unit": "mar", "type": "support", "supportedUnit": "par", "destination": "par"}]\n```';
    const orders = parseOrders(text, state, Power.France);
    const marOrder = orders.find((o) => o.unit === 'mar');
    expect(marOrder).toEqual({
      type: OrderType.Support,
      unit: 'mar',
      supportedUnit: 'par',
      // destination should be undefined (support-hold), not 'par'
    });
    expect((marOrder as SupportOrder).destination).toBeUndefined();
  });

  it('parses convoy orders', () => {
    const state = makeState({
      units: [
        { type: UnitType.Fleet, power: Power.England, province: 'nth' },
        { type: UnitType.Army, power: Power.England, province: 'lon' },
      ],
    });
    const text =
      '```json\n[{"unit": "nth", "type": "convoy", "convoyedUnit": "lon", "destination": "nor"}]\n```';
    const orders = parseOrders(text, state, Power.England);
    const nthOrder = orders.find((o) => o.unit === 'nth');
    expect(nthOrder).toEqual({
      type: OrderType.Convoy,
      unit: 'nth',
      convoyedUnit: 'lon',
      destination: 'nor',
    });
  });

  it('fills missing units with Hold', () => {
    const state = makeState();
    // France has 3 units at start (par, mar, bre)
    const text = '```json\n[{"unit": "par", "type": "move", "destination": "bur"}]\n```';
    const orders = parseOrders(text, state, Power.France);
    expect(orders).toHaveLength(3);
    // par gets the move, mar and bre get hold
    expect(orders.find((o) => o.unit === 'mar')?.type).toBe(OrderType.Hold);
    expect(orders.find((o) => o.unit === 'bre')?.type).toBe(OrderType.Hold);
  });

  it('allows invalid moves (resolver handles them)', () => {
    const state = makeState();
    // par -> lon is not adjacent, but parser should pass it through
    const text = '```json\n[{"unit": "par", "type": "move", "destination": "lon"}]\n```';
    const orders = parseOrders(text, state, Power.France);
    const parOrder = orders.find((o) => o.unit === 'par');
    expect(parOrder).toEqual({
      type: OrderType.Move,
      unit: 'par',
      destination: 'lon',
      coast: undefined,
    });
  });

  it('handles case-insensitive province names', () => {
    const state = makeState();
    const text = '```json\n[{"unit": "PAR", "type": "move", "destination": "BUR"}]\n```';
    const orders = parseOrders(text, state, Power.France);
    const parOrder = orders.find((o) => o.unit === 'par');
    expect(parOrder?.type).toBe(OrderType.Move);
  });

  it('resolves full province names', () => {
    const state = makeState();
    const text = '```json\n[{"unit": "Paris", "type": "move", "destination": "Burgundy"}]\n```';
    const orders = parseOrders(text, state, Power.France);
    const parOrder = orders.find((o) => o.unit === 'par');
    expect(parOrder).toEqual({
      type: OrderType.Move,
      unit: 'par',
      destination: 'bur',
      coast: undefined,
    });
  });

  it('handles move with coast', () => {
    const state = makeState({
      units: [{ type: UnitType.Fleet, power: Power.France, province: 'mao' }],
    });
    const text =
      '```json\n[{"unit": "mao", "type": "move", "destination": "spa", "coast": "sc"}]\n```';
    const orders = parseOrders(text, state, Power.France);
    expect(orders[0]).toEqual({
      type: OrderType.Move,
      unit: 'mao',
      destination: 'spa',
      coast: Coast.South,
    });
  });

  it('returns all Hold on empty/garbage input', () => {
    const state = makeState();
    const orders = parseOrders('lol idk', state, Power.France);
    expect(orders).toHaveLength(3);
    expect(orders.every((o) => o.type === OrderType.Hold)).toBe(true);
  });
});

// ============================================================================
// parseMessages
// ============================================================================

describe('parseMessages', () => {
  const phase: Phase = { year: 1901, season: Season.Spring, type: PhaseType.Diplomacy };

  it('parses messages to specific powers', () => {
    const text = '```json\n[{"to": "England", "content": "Let\'s ally!"}]\n```';
    const msgs = parseMessages(text, Power.France, phase);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe(Power.France);
    expect(msgs[0].to).toBe(Power.England);
    expect(msgs[0].content).toBe("Let's ally!");
  });

  it('parses Global messages', () => {
    const text = '```json\n[{"to": "Global", "content": "Peace!"}]\n```';
    const msgs = parseMessages(text, Power.France, phase);
    expect(msgs[0].to).toBe('Global');
  });

  it('filters out self-messages', () => {
    const text = '```json\n[{"to": "France", "content": "talking to myself"}]\n```';
    const msgs = parseMessages(text, Power.France, phase);
    expect(msgs).toHaveLength(0);
  });

  it('filters out empty content', () => {
    const text = '```json\n[{"to": "England", "content": ""}]\n```';
    const msgs = parseMessages(text, Power.France, phase);
    expect(msgs).toHaveLength(0);
  });

  it('returns empty on garbage input', () => {
    const msgs = parseMessages('no messages', Power.France, phase);
    expect(msgs).toHaveLength(0);
  });

  it('parses multi-recipient array', () => {
    const text = '```json\n[{"to": ["England", "Germany"], "content": "Alliance proposal"}]\n```';
    const msgs = parseMessages(text, Power.France, phase);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].to).toEqual([Power.England, Power.Germany]);
    expect(msgs[0].content).toBe('Alliance proposal');
  });

  it('filters self from multi-recipient array', () => {
    const text = '```json\n[{"to": ["France", "England", "Germany"], "content": "Hello"}]\n```';
    const msgs = parseMessages(text, Power.France, phase);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].to).toEqual([Power.England, Power.Germany]);
  });

  it('collapses single-element array after self-filter', () => {
    const text = '```json\n[{"to": ["France", "England"], "content": "Hello"}]\n```';
    const msgs = parseMessages(text, Power.France, phase);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].to).toBe(Power.England);
  });

  it('drops message if array only contains self', () => {
    const text = '```json\n[{"to": ["France"], "content": "Talking to myself"}]\n```';
    const msgs = parseMessages(text, Power.France, phase);
    expect(msgs).toHaveLength(0);
  });

  it('handles mixed single and multi-recipient messages', () => {
    const text = `\`\`\`json
[
  {"to": "England", "content": "Private"},
  {"to": ["Italy", "Austria"], "content": "Shared"},
  {"to": "Global", "content": "Public"}
]
\`\`\``;
    const msgs = parseMessages(text, Power.France, phase);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].to).toBe(Power.England);
    expect(msgs[1].to).toEqual([Power.Italy, Power.Austria]);
    expect(msgs[2].to).toBe('Global');
  });
});

// ============================================================================
// parseBatchNegotiationResponse
// ============================================================================

describe('parseBatchNegotiationResponse', () => {
  const phase: Phase = { year: 1901, season: Season.Spring, type: PhaseType.Diplomacy };

  it('parses object with replies and defer', () => {
    const text = `\`\`\`json
{
  "replies": [
    { "to": "England", "content": "Agreed" }
  ],
  "defer": [2, 3]
}
\`\`\``;
    const result = parseBatchNegotiationResponse(text, Power.France, phase, 3);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0].to).toBe(Power.England);
    expect(result.deferredIndices).toEqual([1, 2]); // 1-based → 0-based
  });

  it('parses object with only replies', () => {
    const text = '```json\n{"replies": [{"to": "Germany", "content": "Hello"}]}\n```';
    const result = parseBatchNegotiationResponse(text, Power.France, phase, 2);
    expect(result.replies).toHaveLength(1);
    expect(result.deferredIndices).toEqual([]);
  });

  it('parses object with only defer', () => {
    const text = '```json\n{"defer": [1]}\n```';
    const result = parseBatchNegotiationResponse(text, Power.France, phase, 2);
    expect(result.replies).toHaveLength(0);
    expect(result.deferredIndices).toEqual([0]);
  });

  it('falls back to array format (backward compat)', () => {
    const text = '```json\n[{"to": "England", "content": "Hello"}]\n```';
    const result = parseBatchNegotiationResponse(text, Power.France, phase, 1);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0].to).toBe(Power.England);
    expect(result.deferredIndices).toEqual([]);
  });

  it('ignores out-of-range defer indices', () => {
    const text = '```json\n{"replies": [], "defer": [0, 5, -1]}\n```';
    const result = parseBatchNegotiationResponse(text, Power.France, phase, 3);
    expect(result.deferredIndices).toEqual([]); // 0 is invalid (1-based), 5 > count, -1 invalid
  });

  it('handles multi-recipient replies in batch response', () => {
    const text = `\`\`\`json
{
  "replies": [
    { "to": ["England", "Germany"], "content": "Joint proposal" }
  ]
}
\`\`\``;
    const result = parseBatchNegotiationResponse(text, Power.France, phase, 1);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0].to).toEqual([Power.England, Power.Germany]);
  });

  it('returns empty on garbage input', () => {
    const result = parseBatchNegotiationResponse('no json here', Power.France, phase, 2);
    expect(result.replies).toHaveLength(0);
    expect(result.deferredIndices).toEqual([]);
  });
});

// ============================================================================
// parseRetreats
// ============================================================================

describe('parseRetreats', () => {
  it('parses retreat move', () => {
    const situations: RetreatSituation[] = [
      {
        unit: { type: UnitType.Army, power: Power.France, province: 'bur' },
        attackedFrom: 'mun',
        validDestinations: ['par', 'pic', 'gas'],
      },
    ];
    const text = '```json\n[{"unit": "bur", "destination": "par"}]\n```';
    const orders = parseRetreats(text, situations, Power.France);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toEqual({
      type: 'RetreatMove',
      unit: 'bur',
      destination: 'par',
      coast: undefined,
    });
  });

  it('parses disband', () => {
    const situations: RetreatSituation[] = [
      {
        unit: { type: UnitType.Army, power: Power.France, province: 'bur' },
        attackedFrom: 'mun',
        validDestinations: ['par'],
      },
    ];
    const text = '```json\n[{"unit": "bur", "action": "disband"}]\n```';
    const orders = parseRetreats(text, situations, Power.France);
    expect(orders[0]).toEqual({ type: 'Disband', unit: 'bur' });
  });

  it('defaults to disband for invalid retreat destination', () => {
    const situations: RetreatSituation[] = [
      {
        unit: { type: UnitType.Army, power: Power.France, province: 'bur' },
        attackedFrom: 'mun',
        validDestinations: ['par'],
      },
    ];
    const text = '```json\n[{"unit": "bur", "destination": "lon"}]\n```';
    const orders = parseRetreats(text, situations, Power.France);
    expect(orders[0]).toEqual({ type: 'Disband', unit: 'bur' });
  });

  it('defaults to disband for missing orders', () => {
    const situations: RetreatSituation[] = [
      {
        unit: { type: UnitType.Army, power: Power.France, province: 'bur' },
        attackedFrom: 'mun',
        validDestinations: ['par'],
      },
    ];
    const orders = parseRetreats('[]', situations, Power.France);
    expect(orders[0]).toEqual({ type: 'Disband', unit: 'bur' });
  });
});

// ============================================================================
// parseBuildOrders
// ============================================================================

describe('parseBuildOrders', () => {
  it('parses build army', () => {
    const state = makeState({ units: [] }); // no units so home centers are free
    const text = '```json\n[{"type": "build", "unitType": "Army", "province": "par"}]\n```';
    const orders = parseBuildOrders(text, state, Power.France, 1);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toEqual({
      type: 'Build',
      unitType: UnitType.Army,
      province: 'par',
      coast: undefined,
    });
  });

  it('parses build fleet with coast', () => {
    const state = makeState({ units: [] });
    // stp is a Russian home center with coasts
    const text =
      '```json\n[{"type": "build", "unitType": "Fleet", "province": "stp", "coast": "nc"}]\n```';
    const orders = parseBuildOrders(text, state, Power.Russia, 1);
    expect(orders[0]).toEqual({
      type: 'Build',
      unitType: UnitType.Fleet,
      province: 'stp',
      coast: Coast.North,
    });
  });

  it('waives remaining builds', () => {
    const state = makeState({ units: [] });
    const text = '```json\n[{"type": "build", "unitType": "Army", "province": "par"}]\n```';
    const orders = parseBuildOrders(text, state, Power.France, 3);
    expect(orders).toHaveLength(3);
    expect(orders[0].type).toBe('Build');
    expect(orders[1].type).toBe('Waive');
    expect(orders[2].type).toBe('Waive');
  });

  it('parses remove orders', () => {
    const state = makeState();
    const text = '```json\n[{"type": "remove", "unit": "par"}]\n```';
    const orders = parseBuildOrders(text, state, Power.France, -1);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toEqual({ type: 'Remove', unit: 'par' });
  });

  it('force-removes when LLM provides insufficient removals', () => {
    const state = makeState();
    const text = '```json\n[]\n```';
    const orders = parseBuildOrders(text, state, Power.France, -2);
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => o.type === 'Remove')).toBe(true);
  });

  it('prevents building on occupied centers', () => {
    const state = makeState(); // par is occupied by starting army
    const text = '```json\n[{"type": "build", "unitType": "Army", "province": "par"}]\n```';
    const orders = parseBuildOrders(text, state, Power.France, 1);
    // Should waive since par is occupied
    expect(orders[0].type).toBe('Waive');
  });
});

// ============================================================================
// prompts
// ============================================================================

describe('prompts', () => {
  it('buildSystemPrompt includes power name', () => {
    const prompt = buildSystemPrompt(Power.France);
    expect(prompt).toContain('France');
    expect(prompt).toContain('Diplomacy');
  });

  it('serializeGameState includes all sections', () => {
    const state = makeState();
    const result = serializeGameState(state, Power.France);
    expect(result).toContain('YOUR POWER: France');
    expect(result).toContain('Your Units');
    expect(result).toContain('All Units');
    expect(result).toContain('Supply Centers');
    expect(result).toContain('A par');
  });

  it('buildOrdersPrompt includes unit list', () => {
    const state = makeState();
    const prompt = buildOrdersPrompt(state, Power.France, []);
    expect(prompt).toContain('par');
    expect(prompt).toContain('mar');
    expect(prompt).toContain('bre');
  });
});

// ============================================================================
// LLMAgent integration
// ============================================================================

describe('LLMAgent', () => {
  it('submits parsed orders from LLM response', async () => {
    const client = new MockLLMClient();
    const agent = new LLMAgent(Power.France, client);
    const state = makeState();

    await agent.initialize(state);

    client.addResponse(
      '```json\n[\n  {"unit": "par", "type": "move", "destination": "bur"},\n  {"unit": "mar", "type": "support", "supportedUnit": "par", "destination": "bur"},\n  {"unit": "bre", "type": "hold"}\n]\n```',
    );

    const orders = await agent.submitOrders(state);
    expect(orders).toHaveLength(3);
    expect(orders.find((o) => o.unit === 'par')).toEqual({
      type: OrderType.Move,
      unit: 'par',
      destination: 'bur',
      coast: undefined,
    });
    expect(orders.find((o) => o.unit === 'mar')?.type).toBe(OrderType.Support);
    expect(orders.find((o) => o.unit === 'bre')?.type).toBe(OrderType.Hold);
  });

  it('falls back to Hold on LLM error', async () => {
    const client = new MockLLMClient();
    const agent = new LLMAgent(Power.France, client);
    const state = makeState();

    await agent.initialize(state);
    // No response queued — will throw

    const orders = await agent.submitOrders(state);
    expect(orders).toHaveLength(3);
    expect(orders.every((o) => o.type === OrderType.Hold)).toBe(true);
  });

  it('sends negotiation messages', async () => {
    const client = new MockLLMClient();
    const agent = new LLMAgent(Power.France, client);
    const state = makeState({
      phase: { year: 1901, season: Season.Spring, type: PhaseType.Diplomacy },
    });

    await agent.initialize(state);
    client.addResponse('```json\n[{"to": "England", "content": "Alliance?"}]\n```');

    const messages = await agent.onPhaseStart(state);
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe(Power.England);
    expect(messages[0].content).toBe('Alliance?');
  });

  it('returns empty messages on LLM error', async () => {
    const client = new MockLLMClient();
    const agent = new LLMAgent(Power.France, client);
    const state = makeState({
      phase: { year: 1901, season: Season.Spring, type: PhaseType.Diplomacy },
    });

    await agent.initialize(state);
    // No response queued

    const messages = await agent.onPhaseStart(state);
    expect(messages).toHaveLength(0);
  });

  it('responds to all messages when rate limit is disabled', async () => {
    const client = new MockLLMClient();
    const agent = new LLMAgent(Power.France, client);
    const state = makeState({
      phase: { year: 1901, season: Season.Spring, type: PhaseType.Diplomacy },
    });

    await agent.initialize(state);

    client.addResponse('```json\n[]\n```');
    await agent.onPhaseStart(state);

    // Send 5 messages — all should get LLM calls since limit is disabled
    for (let i = 0; i < 5; i++) {
      client.addResponse(`\`\`\`json\n[{"to": "England", "content": "Reply ${i}"}]\n\`\`\``);
      await agent.onMessage(
        {
          from: Power.England,
          to: Power.France,
          content: `msg ${i}`,
          phase: state.phase,
          timestamp: Date.now(),
        },
        state,
      );
    }

    // 1 onPhaseStart + 5 onMessage = 6 LLM calls
    expect(client.calls).toHaveLength(6);
  });

  it('handles retreats', async () => {
    const client = new MockLLMClient();
    const agent = new LLMAgent(Power.France, client);
    const state = makeState();

    await agent.initialize(state);

    const situations: RetreatSituation[] = [
      {
        unit: { type: UnitType.Army, power: Power.France, province: 'bur' },
        attackedFrom: 'mun',
        validDestinations: ['par', 'pic'],
      },
    ];

    client.addResponse('```json\n[{"unit": "bur", "destination": "par"}]\n```');
    const retreats = await agent.submitRetreats(state, situations);
    expect(retreats).toHaveLength(1);
    expect(retreats[0]).toEqual({
      type: 'RetreatMove',
      unit: 'bur',
      destination: 'par',
      coast: undefined,
    });
  });

  it('falls back to disband on retreat error', async () => {
    const client = new MockLLMClient();
    const agent = new LLMAgent(Power.France, client);
    const state = makeState();

    await agent.initialize(state);

    const situations: RetreatSituation[] = [
      {
        unit: { type: UnitType.Army, power: Power.France, province: 'bur' },
        attackedFrom: 'mun',
        validDestinations: ['par'],
      },
    ];

    // No response queued — will error
    const retreats = await agent.submitRetreats(state, situations);
    expect(retreats).toHaveLength(1);
    expect(retreats[0].type).toBe('Disband');
  });

  it('handles builds', async () => {
    const client = new MockLLMClient();
    const agent = new LLMAgent(Power.France, client);
    const state = makeState({ units: [] }); // empty so home centers are free

    await agent.initialize(state);

    client.addResponse('```json\n[{"type": "build", "unitType": "Army", "province": "par"}]\n```');
    const builds = await agent.submitBuilds(state, 1);
    expect(builds).toHaveLength(1);
    expect(builds[0]).toEqual({
      type: 'Build',
      unitType: UnitType.Army,
      province: 'par',
      coast: undefined,
    });
  });

  it('falls back to waive on build error', async () => {
    const client = new MockLLMClient();
    const agent = new LLMAgent(Power.France, client);
    const state = makeState();

    await agent.initialize(state);
    // No response queued

    const builds = await agent.submitBuilds(state, 2);
    expect(builds).toHaveLength(2);
    expect(builds.every((b) => b.type === 'Waive')).toBe(true);
  });

  it('passes system prompt and user prompt to LLM', async () => {
    const client = new MockLLMClient();
    const agent = new LLMAgent(Power.France, client);
    const state = makeState();

    await agent.initialize(state);
    client.addResponse('```json\n[]\n```');
    await agent.onPhaseStart(state);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0][0].role).toBe('system');
    expect(client.calls[0][0].content).toContain('France');
    expect(client.calls[0][1].role).toBe('user');
  });
});
