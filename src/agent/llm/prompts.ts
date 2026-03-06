import { PROVINCES } from '../../engine/map.js';
import {
  GameState,
  Message,
  OrderResolution,
  Power,
  RetreatSituation,
  Unit,
  UnitType,
} from '../../engine/types.js';

function unitStr(u: Unit): string {
  const t = u.type === UnitType.Army ? 'A' : 'F';
  const coast = u.coast ? `/${u.coast}` : '';
  return `${t} ${u.province}${coast}`;
}

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

export function serializeGameState(state: GameState, power: Power): string {
  const lines: string[] = [];
  const { phase } = state;
  lines.push(`=== ${phase.season} ${phase.year} (${phase.type}) ===`);
  lines.push(`YOUR POWER: ${power}`);

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

const PROVINCE_LIST = Object.entries(PROVINCES)
  .map(([id, p]) => `${id} = ${p.name}`)
  .join(', ');

export function buildSystemPrompt(power: Power): string {
  return `You are playing as ${power} in a game of Diplomacy. You are a skilled and strategic player.

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
      recentMessages
        .map(
          (m) => `${m.from} -> ${typeof m.to === 'string' ? m.to : m.to.join(', ')}: ${m.content}`,
        )
        .join('\n');
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
      '\n--- Recent Messages ---\n' +
      recentMessages
        .map(
          (m) => `${m.from} -> ${typeof m.to === 'string' ? m.to : m.to.join(', ')}: ${m.content}`,
        )
        .join('\n');
  }

  let prompt: string;
  if (incomingMessage) {
    prompt = `${stateStr}${msgSection}

You received this message:
${incomingMessage.from}: "${incomingMessage.content}"

Decide whether and how to respond. You may send messages to any power or to "Global".
If you choose not to respond, return an empty array.`;
  } else {
    prompt = `${stateStr}${msgSection}

It is the start of the diplomacy phase. You may send opening messages to other powers to propose alliances, share intelligence, or make threats. You can message individual powers or send a "Global" message.
If you prefer to stay silent, return an empty array.`;
  }

  return `${prompt}

Respond with a JSON array inside a fenced code block:
\`\`\`json
[
  { "to": "England", "content": "Your message here" },
  { "to": "Global", "content": "Public announcement" }
]
\`\`\`

Be strategic. Consider who to ally with, who to deceive, and what information to share or withhold.`;
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
