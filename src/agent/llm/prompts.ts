import { PROVINCES } from '../../engine/map';
import {
  GameState,
  Message,
  OrderResolution,
  Power,
  RetreatSituation,
  Unit,
  UnitType,
} from '../../engine/types';

function unitStr(u: Unit): string {
  const t = u.type === UnitType.Army ? 'A' : 'F';
  const coast = u.coast ? `/${u.coast}` : '';
  return `${t} ${u.province}${coast}`;
}

/**
 * Formats a message with visibility annotation so the LLM understands
 * who can see each message and avoids leaking private intel.
 */
function formatMessage(m: Message, self: Power): string {
  const to = typeof m.to === 'string' ? m.to : m.to.join(', ');
  let tag = '';
  if (m.to === 'Global') {
    tag = ' [PUBLIC]';
  } else if (
    m.to === self ||
    (typeof m.to === 'string' && m.from === self) ||
    (Array.isArray(m.to) && m.to.length === 1)
  ) {
    // 1-on-1 private message
    const other = m.from === self ? (Array.isArray(m.to) ? m.to[0] : m.to) : m.from;
    tag = ` [PRIVATE - only you and ${other} can see this]`;
  } else if (Array.isArray(m.to)) {
    // Multi-recipient: show who can see it
    const visible = m.from === self ? m.to : [m.from, ...m.to.filter((p) => p !== m.from)];
    tag = ` [SHARED - visible to: ${visible.join(', ')}]`;
  }
  return `${m.from} -> ${to}: ${m.content}${tag}`;
}

export function buildToolSystemPrompt(power: Power, endYear?: number): string {
  const gameLengthNote = endYear
    ? `\nGAME LENGTH: This game ends after ${endYear}. ${
        endYear - 1900 <= 3
          ? 'This is a SHORT game — be aggressive and expand quickly.'
          : endYear - 1900 <= 10
            ? 'This is a medium-length game — balance expansion with alliances.'
            : 'This is a long game — invest in durable alliances.'
      }`
    : '';

  return `You are playing as ${power} in a game of Diplomacy. You are a skilled and strategic player.${gameLengthNote}

RULES SUMMARY:
- 7 powers compete to control 18 of 34 supply centers on the map of Europe
- Each supply center supports one unit (Army or Fleet)
- Spring and Fall: submit movement orders, then resolve simultaneously
- After Fall: supply center ownership updates, then Winter builds/disbands
- Army (A): moves on land and coastal provinces
- Fleet (F): moves on sea and coastal provinces, can convoy armies
- Order types: Hold, Move, Support, Convoy
- Support can be cut by an attack on the supporting unit
- Convoys: fleets in sea provinces chain to transport armies across water
- Multi-coast provinces (spa, stp, bul): fleets must specify coast (nc or sc)

INFORMATION SECURITY:
- Messages are tagged [PRIVATE], [SHARED], or [PUBLIC] to show who can see them
- NEVER reveal information from a PRIVATE message to others
- Use private messages for sensitive coordination

HOW TO PLAY:
- Use getMyUnits to see your units and getAdjacentProvinces to plan moves
- Use getProvinceInfo to check province details and ownership
- Use sendMessage to negotiate with other powers
- Submit your orders/retreats/builds using the appropriate tool
- Call ready() when you are done with your turn`;
}

export function buildTurnPrompt(
  state: GameState,
  power: Power,
  pendingMessages: Message[],
): string {
  const lines: string[] = [];
  const { phase } = state;
  lines.push(`=== ${phase.season} ${phase.year} (${phase.type}) ===`);

  // Unit/SC counts
  const myUnits = state.units.filter((u) => u.power === power);
  const mySCs = [...state.supplyCenters.entries()].filter(([, p]) => p === power).length;
  lines.push(`You have ${myUnits.length} units and ${mySCs} supply centers.`);

  if (state.endYear) {
    const remaining = state.endYear - phase.year;
    lines.push(
      `Game ends: ${state.endYear} (${remaining} year${remaining !== 1 ? 's' : ''} remaining)`,
    );
  }

  // Last turn results
  if (state.orderHistory.length > 0) {
    const last = state.orderHistory[state.orderHistory.length - 1];
    lines.push('\n--- Last Turn Results ---');
    for (const r of last) {
      const o = (r as OrderResolution).order;
      let desc = `${o.unit} ???`;
      switch (o.type) {
        case 'Hold':
          desc = `${o.unit} HOLD`;
          break;
        case 'Move':
          desc = `${o.unit} -> ${o.destination}${o.coast ? '/' + o.coast : ''}`;
          break;
        case 'Support':
          desc = o.destination
            ? `${o.unit} S ${o.supportedUnit} -> ${o.destination}`
            : `${o.unit} S ${o.supportedUnit} (hold)`;
          break;
        case 'Convoy':
          desc = `${o.unit} C ${o.convoyedUnit} -> ${o.destination}`;
          break;
      }
      lines.push(
        `  ${(r as OrderResolution).power}: ${desc} [${(r as OrderResolution).status}]${(r as OrderResolution).reason ? ' - ' + (r as OrderResolution).reason : ''}`,
      );
    }
  }

  // Your units with adjacencies
  lines.push('\n--- Your Units ---');
  if (myUnits.length > 0) {
    for (const u of myUnits) {
      const prov = PROVINCES[u.province];
      let adj: string[];
      if (u.type === UnitType.Army) {
        adj = prov?.adjacency.army ?? [];
      } else if (u.coast && prov?.adjacency.fleetByCoast?.[u.coast]) {
        adj = prov.adjacency.fleetByCoast[u.coast]!;
      } else {
        adj = prov?.adjacency.fleet ?? [];
      }
      lines.push(`${unitStr(u)} -> can reach: ${adj.join(', ')}`);
    }
  } else {
    lines.push('(none)');
  }

  // Pending messages
  if (pendingMessages.length > 0) {
    lines.push('\n--- Incoming Messages ---');
    for (const m of pendingMessages) {
      lines.push(formatMessage(m, power));
    }
  }

  // Phase-specific instructions
  switch (phase.type) {
    case 'Diplomacy':
      lines.push(
        '\nThis is the diplomacy phase. Send messages to negotiate. Call ready() when done.',
      );
      break;
    case 'Orders':
      lines.push(
        '\nSubmit movement orders for your units. Use getMyUnits and getAdjacentProvinces to plan. Call submitOrders then ready().',
      );
      break;
    case 'Retreats':
      lines.push(
        '\nYou have dislodged units. Use getRetreatOptions to see options. Call submitRetreats then ready().',
      );
      break;
    case 'Builds':
      lines.push('\nIt is the build/disband phase. Call submitBuilds then ready().');
      break;
  }

  return lines.join('\n');
}

// ── Legacy prompt functions (used by LLMAgent) ──────────────────────────

function groupUnitsByPower(units: Unit[]): Map<Power, Unit[]> {
  const map = new Map<Power, Unit[]>();
  for (const u of units) {
    const list = map.get(u.power) ?? [];
    list.push(u);
    map.set(u.power, list);
  }
  return map;
}

function supplyCenterSummary(state: GameState): string {
  const byPower = new Map<string, string[]>();
  const neutral: string[] = [];
  for (const [prov, power] of state.supplyCenters) {
    const list = byPower.get(power) ?? [];
    list.push(prov);
    byPower.set(power, list);
  }
  for (const [id, prov] of Object.entries(PROVINCES)) {
    if (prov.supplyCenter && !state.supplyCenters.has(id)) {
      neutral.push(id);
    }
  }
  const lines: string[] = [];
  for (const [power, provs] of byPower) {
    lines.push(`${power} (${provs.length}): ${provs.join(', ')}`);
  }
  if (neutral.length > 0) {
    lines.push(`Neutral: ${neutral.join(', ')}`);
  }
  return lines.join('\n');
}

function lastTurnSummary(resolutions: OrderResolution[]): string {
  return resolutions
    .map((r) => {
      const o = r.order;
      let desc: string = `${o.unit} ???`;
      switch (o.type) {
        case 'Hold':
          desc = `${o.unit} HOLD`;
          break;
        case 'Move':
          desc = `${o.unit} -> ${o.destination}${o.coast ? '/' + o.coast : ''}`;
          break;
        case 'Support':
          desc = o.destination
            ? `${o.unit} S ${o.supportedUnit} -> ${o.destination}`
            : `${o.unit} S ${o.supportedUnit} (hold)`;
          break;
        case 'Convoy':
          desc = `${o.unit} C ${o.convoyedUnit} -> ${o.destination}`;
          break;
      }
      return `  ${r.power}: ${desc} [${r.status}]${r.reason ? ' - ' + r.reason : ''}`;
    })
    .join('\n');
}

const PROVINCE_LIST = Object.entries(PROVINCES)
  .map(([id, p]) => `${id} = ${p.name}`)
  .join(', ');

export function serializeGameState(state: GameState, power: Power): string {
  const lines: string[] = [];
  const { phase } = state;
  lines.push(`=== ${phase.season} ${phase.year} (${phase.type}) ===`);
  lines.push(`YOUR POWER: ${power}`);
  if (state.endYear) {
    const remaining = state.endYear - phase.year;
    lines.push(
      `GAME ENDS: ${state.endYear} (${remaining} year${remaining !== 1 ? 's' : ''} remaining)`,
    );
  }

  // Your units
  const grouped = groupUnitsByPower(state.units);
  const yours = grouped.get(power) ?? [];
  lines.push(`\n--- Your Units ---`);
  lines.push(yours.length > 0 ? yours.map(unitStr).join(', ') : '(none)');

  // All units
  lines.push(`\n--- All Units ---`);
  for (const [p, units] of grouped) {
    lines.push(`${p}: ${units.map(unitStr).join(', ')}`);
  }

  // Supply centers
  lines.push(`\n--- Supply Centers ---`);
  lines.push(supplyCenterSummary(state));

  // Last turn results
  if (state.orderHistory.length > 0) {
    const last = state.orderHistory[state.orderHistory.length - 1];
    lines.push(`\n--- Last Turn Results ---`);
    lines.push(lastTurnSummary(last));
  }

  return lines.join('\n');
}

export function buildSystemPrompt(power: Power, endYear?: number): string {
  const gameLengthNote = endYear
    ? `\nGAME LENGTH: This game ends after ${endYear}. ${
        endYear - 1900 <= 3
          ? 'This is a SHORT game — be aggressive and expand quickly. There is no time for slow buildups.'
          : endYear - 1900 <= 10
            ? 'This is a medium-length game — balance early expansion with alliance-building.'
            : 'This is a long game — invest in durable alliances and long-term positioning.'
      }`
    : '';
  return `You are playing as ${power} in a game of Diplomacy. You are a skilled and strategic player.${gameLengthNote}

RULES SUMMARY:
- 7 powers compete to control 18 of 34 supply centers on the map of Europe
- Each supply center supports one unit (Army or Fleet)
- Spring and Fall: submit movement orders, then resolve simultaneously
- After Fall: supply center ownership updates, then Winter builds/disbands
- Army (A): moves on land and coastal provinces
- Fleet (F): moves on sea and coastal provinces, can convoy armies
- Order types: Hold, Move, Support, Convoy
- Support can be cut by an attack on the supporting unit (from a province other than the one being supported into)
- Convoys: fleets in sea provinces chain to transport armies across water
- Multi-coast provinces (spa, stp, bul): fleets must specify coast (nc or sc)

INFORMATION SECURITY:
- Messages are tagged [PRIVATE], [SHARED], or [PUBLIC] to show who can see them
- NEVER reveal information from a PRIVATE message when replying to a group or different power
- When sending to multiple recipients, assume ALL recipients can read the full message
- Use private 1-on-1 messages for sensitive coordination; use group messages only for shared plans

PROVINCE ABBREVIATIONS:
${PROVINCE_LIST}

When responding with orders, messages, retreats, or builds, output a JSON array inside a fenced code block. Follow the exact schemas described in each prompt.`;
}

export function buildOrdersPrompt(
  state: GameState,
  power: Power,
  messageHistory: Message[],
): string {
  const stateStr = serializeGameState(state, power);
  const yours = state.units.filter((u) => u.power === power);

  const recentMessages = messageHistory.slice(-15);
  let msgSection = '';
  if (recentMessages.length > 0) {
    msgSection =
      '\n--- Recent Diplomatic Messages ---\n' +
      recentMessages.map((m) => formatMessage(m, power)).join('\n');
  }

  const unitList = yours.map(unitStr).join(', ');

  return `${stateStr}${msgSection}

You must submit one order for each of your units: ${unitList}

Respond with a JSON array inside a fenced code block. Each element must have:
- "unit": province id where your unit is (e.g. "par")
- "type": "hold" | "move" | "support" | "convoy"
- "destination": target province (for move, support-move, convoy)
- "supportedUnit": province of the unit being supported (for support)
- "convoyedUnit": province of the army being convoyed (for convoy)
- "coast": "nc" or "sc" (only when moving a fleet to spa, stp, or bul)

Example:
\`\`\`json
[
  { "unit": "par", "type": "move", "destination": "bur" },
  { "unit": "mar", "type": "support", "supportedUnit": "par", "destination": "bur" },
  { "unit": "bre", "type": "hold" }
]
\`\`\`

Think strategically about alliances, threats, and long-term position. Submit your orders now.`;
}

export function buildNegotiationPrompt(
  state: GameState,
  power: Power,
  messageHistory: Message[],
  incomingMessage?: Message,
): string {
  const stateStr = serializeGameState(state, power);

  const recentMessages = messageHistory.slice(-10);
  let msgSection = '';
  if (recentMessages.length > 0) {
    msgSection =
      '\n--- Recent Messages ---\n' + recentMessages.map((m) => formatMessage(m, power)).join('\n');
  }

  let prompt: string;
  if (incomingMessage) {
    prompt = `${stateStr}${msgSection}

You received this message:
${incomingMessage.from}: "${incomingMessage.content}"

Decide whether and how to respond. You may send messages to any power, to multiple powers at once, or to "Global".
If you choose not to respond, return an empty array.`;
  } else {
    prompt = `${stateStr}${msgSection}

It is the start of the diplomacy phase. You may send opening messages to other powers to propose alliances, share intelligence, or make threats. You can message individual powers, multiple powers at once, or send a "Global" message.
If you prefer to stay silent, return an empty array.`;
  }

  return `${prompt}

Respond with a JSON array inside a fenced code block. "to" can be a single power, an array of powers, or "Global":
\`\`\`json
[
  { "to": "England", "content": "Private message to one power" },
  { "to": ["England", "France"], "content": "Shared message to select powers" },
  { "to": "Global", "content": "Public announcement to everyone" }
]
\`\`\`

Be strategic. Consider who to ally with, who to deceive, and what information to share or withhold. Multi-recipient messages let you coordinate between specific allies without broadcasting publicly.`;
}

export function buildBatchNegotiationPrompt(
  state: GameState,
  power: Power,
  messageHistory: Message[],
  incomingMessages: Message[],
): string {
  const stateStr = serializeGameState(state, power);

  const recentMessages = messageHistory.slice(-10);
  let msgSection = '';
  if (recentMessages.length > 0) {
    msgSection =
      '\n--- Recent Messages ---\n' + recentMessages.map((m) => formatMessage(m, power)).join('\n');
  }

  const incomingSection = incomingMessages
    .map((m, i) => `${i + 1}. ${formatMessage(m, power)}`)
    .join('\n');

  return `${stateStr}${msgSection}

You received the following ${incomingMessages.length} message(s):
${incomingSection}

Decide which messages to respond to and craft your replies. You may respond to all, some, or none. You can also send messages to powers who didn't message you. "to" can be a single power, an array of powers, or "Global".

You may also DEFER messages — choosing to wait before responding. Deferred messages will be presented to you again later. This is strategic: a delayed response can signal disinterest, buy time to gather information, or let you see how other negotiations develop before committing. Use "defer" to list the message numbers you want to revisit later.

Respond with a JSON object inside a fenced code block:
\`\`\`json
{
  "replies": [
    { "to": "England", "content": "Private message to one power" },
    { "to": ["England", "France"], "content": "Shared message to select allies" },
    { "to": "Global", "content": "Public announcement" }
  ],
  "defer": [3]
}
\`\`\`

Both "replies" and "defer" are optional. Omit "replies" or set it to [] if you don't want to send anything now. Omit "defer" or set it to [] if you want to handle all messages immediately.

Be strategic. Consider who to ally with, who to deceive, what information to share or withhold, and when the timing of your response matters. Multi-recipient messages let you coordinate between specific allies without broadcasting publicly.`;
}

export function buildRetreatsPrompt(
  state: GameState,
  power: Power,
  situations: RetreatSituation[],
): string {
  const stateStr = serializeGameState(state, power);
  const mySituations = situations.filter((s) => s.unit.power === power);

  const retreatLines = mySituations
    .map((s) => {
      const valid =
        s.validDestinations.length > 0 ? s.validDestinations.join(', ') : '(none — must disband)';
      return `${unitStr(s.unit)} dislodged from ${s.unit.province} (attacked from ${s.attackedFrom}). Valid retreats: ${valid}`;
    })
    .join('\n');

  return `${stateStr}

--- Dislodged Units ---
${retreatLines}

For each dislodged unit, choose a retreat destination or disband.

Respond with a JSON array inside a fenced code block:
\`\`\`json
[
  { "unit": "bur", "destination": "par" },
  { "unit": "pic", "action": "disband" }
]
\`\`\``;
}

export function buildBuildsPrompt(state: GameState, power: Power, buildCount: number): string {
  const stateStr = serializeGameState(state, power);

  if (buildCount > 0) {
    const occupiedProvinces = new Set(state.units.map((u) => u.province));
    const homeCenters = Object.values(PROVINCES).filter(
      (p) => p.homeCenter === power && p.supplyCenter && state.supplyCenters.get(p.id) === power,
    );
    const available = homeCenters.filter((p) => !occupiedProvinces.has(p.id));
    const centerList = available
      .map((p) => {
        const types = p.type === 'Land' ? 'Army only' : 'Army or Fleet';
        const coasts = p.coasts ? ` (coasts: ${p.coasts.join(', ')})` : '';
        return `${p.id} (${p.name}) — ${types}${coasts}`;
      })
      .join('\n');

    return `${stateStr}

You may build ${buildCount} unit(s). Available home supply centers:
${centerList || '(none available — must waive)'}

Respond with a JSON array inside a fenced code block:
\`\`\`json
[
  { "type": "build", "unitType": "Army", "province": "par" },
  { "type": "build", "unitType": "Fleet", "province": "bre" },
  { "type": "waive" }
]
\`\`\`

For fleets on multi-coast provinces, add "coast": "nc" or "sc".`;
  } else {
    const myUnits = state.units.filter((u) => u.power === power);
    const unitList = myUnits.map(unitStr).join('\n');

    return `${stateStr}

You must disband ${Math.abs(buildCount)} unit(s). Your current units:
${unitList}

Respond with a JSON array inside a fenced code block:
\`\`\`json
[
  { "type": "remove", "unit": "mar" }
]
\`\`\``;
  }
}
