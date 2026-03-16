import { PROVINCES } from '../../engine/map';
import { GameState, Message, OrderResolution, Power, Unit, UnitType } from '../../engine/types';

const PLAN_BLOCK_RE = /```plan\s*\n([\s\S]*?)```/;

export function extractPlanBlock(response: string): { plan: string | null; cleaned: string } {
  const match = response.match(PLAN_BLOCK_RE);
  if (!match) return { plan: null, cleaned: response };
  const plan = match[1].trim();
  const cleaned = response.replace(PLAN_BLOCK_RE, '').trim();
  return { plan: plan || null, cleaned };
}

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
  const phaseLabel = m.phase ? `[${m.phase.season} ${m.phase.year} ${m.phase.type}] ` : '';
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
  return `${phaseLabel}${m.from} -> ${to}: ${m.content}${tag}`;
}

export function buildStrategicSummary(state: GameState, power: Power): string {
  const lines: string[] = ['--- Strategic Situation ---'];

  // Power rankings from current SC ownership
  const currentSCs = new Map<Power, number>();
  for (const [, p] of state.supplyCenters) {
    currentSCs.set(p, (currentSCs.get(p) ?? 0) + 1);
  }

  // Starting SC counts derived from map data (not hardcoded)
  const startingSCs = new Map<Power, number>();
  for (const prov of Object.values(PROVINCES)) {
    if (prov.homeCenter) {
      const p = prov.homeCenter as Power;
      startingSCs.set(p, (startingSCs.get(p) ?? 0) + 1);
    }
  }

  const allPowers = Object.values(Power);
  const ranked = allPowers
    .map((p) => ({ power: p, scs: currentSCs.get(p) ?? 0, start: startingSCs.get(p) ?? 0 }))
    .sort((a, b) => b.scs - a.scs);

  lines.push('POWER RANKINGS (by supply centers):');
  for (const { power: p, scs, start } of ranked) {
    const delta = scs - start;
    const trend = delta > 0 ? ` (+${delta})` : delta < 0 ? ` (${delta})` : '';
    const arrow = delta > 0 ? ' ▲' : delta < 0 ? ' ▼' : '';
    const you = p === power ? ' ← YOU' : '';
    lines.push(`  ${p}: ${scs} SCs${trend}${arrow}${you}`);
  }

  // Neutral supply centers
  const neutralSCs: string[] = [];
  for (const [id, prov] of Object.entries(PROVINCES)) {
    if (prov.supplyCenter && !state.supplyCenters.has(id)) {
      neutralSCs.push(id);
    }
  }
  if (neutralSCs.length > 0) {
    lines.push(`\nNEUTRAL SUPPLY CENTERS (unclaimed — capture these!): ${neutralSCs.join(', ')}`);
  }

  // Neighbor detection
  const myUnits = state.units.filter((u) => u.power === power);
  const unitsByProvince = new Map<string, Unit>();
  for (const u of state.units) {
    unitsByProvince.set(u.province, u);
  }

  const neighborUnits = new Map<Power, string[]>();
  for (const u of myUnits) {
    const prov = PROVINCES[u.province];
    const adj =
      u.type === UnitType.Army
        ? (prov?.adjacency.army ?? [])
        : u.coast && prov?.adjacency.fleetByCoast?.[u.coast]
          ? prov.adjacency.fleetByCoast[u.coast]!
          : (prov?.adjacency.fleet ?? []);
    for (const a of adj) {
      const enemy = unitsByProvince.get(a);
      if (enemy && enemy.power !== power) {
        const list = neighborUnits.get(enemy.power) ?? [];
        list.push(`${unitStr(enemy)} near ${u.province}`);
        neighborUnits.set(enemy.power, list);
      }
    }
  }

  if (neighborUnits.size > 0) {
    lines.push('\nYOUR NEIGHBORS (enemy units adjacent to yours):');
    for (const [p, adjUnits] of neighborUnits) {
      lines.push(`  ${p}: ${adjUnits.join(', ')}`);
    }
  }

  // My position
  const mySCCount = currentSCs.get(power) ?? 0;
  const myHomeCenters = Object.entries(PROVINCES)
    .filter(([, prov]) => prov.homeCenter === power)
    .map(([id]) => id);
  const lostHomes = myHomeCenters.filter((id) => state.supplyCenters.get(id) !== power);

  lines.push(`\nYOUR POSITION: ${myUnits.length} units, ${mySCCount} supply centers`);
  if (lostHomes.length > 0) {
    lines.push(`  Lost home centers: ${lostHomes.join(', ')} — recapture these!`);
  }

  return lines.join('\n');
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

STRATEGY:
- Your goal is to GROW — capture supply centers to build more units
- In early years, grab neutral supply centers (unowned SCs adjacent to your units)
- NEVER hold all your units. A unit that holds when it could move toward a supply center is WASTED
- Use Support orders to help your moves succeed against defended provinces
- Coordinate with allies via sendMessage — but be ready to betray when it benefits you
- Every turn, ask yourself: "Which supply center am I trying to capture next?"
- MOMENTUM: If you moved toward a target last turn, CONTINUE in that direction. Do not retreat home unless directly threatened. Sustained campaigns win games — oscillating back and forth wastes turns.

HOW TO PLAY:
- Your units and reachable provinces are shown in the turn prompt
- Use getProvinceInfo to scout enemy positions if needed
- Use sendMessage to negotiate with other powers
- During Orders/Retreats/Builds phases: you MUST call submitOrders/submitRetreats/submitBuilds before calling ready()
- During the Diplomacy phase: only use sendMessage and ready() — no submission tools are available

PLANNING:
- You MUST include a \`\`\`plan block in EVERY response — this is your memory between turns
- Your old plan is shown in the turn prompt. It may be OUTDATED — always rewrite it based on current state
- Use this format:
  GOAL: What supply center am I targeting next and why?
  ALLIES: Who am I working with? What did we agree to?
  THREATS: Who is threatening me? What are they likely to do next turn?
  ORDERS: What EXACTLY will I submit next turn? (e.g. A vie -> bud, F tri -> alb)
  REFLECTION: What worked last turn? What failed? What should I change?
- The ORDERS field is critical — pre-commit to specific moves so you follow through next turn`;
}

export function buildTurnPrompt(
  state: GameState,
  power: Power,
  pendingMessages: Message[],
  plan?: string,
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

  // Strategic situation (auto-computed)
  lines.push('\n' + buildStrategicSummary(state, power));

  // Agent plan (persisted across phases)
  const planContent =
    plan ?? '(No plan yet — write one using the format: GOAL, ALLIES, THREATS, ORDERS, REFLECTION)';
  lines.push(
    '\n--- Your Plan (from last phase) ---\n' +
      planContent +
      '\n\n⚠️ You MUST include an updated ```plan block. Check your ORDERS from last phase — did you follow through? Update based on results.',
  );

  // Pending messages (phase labels included by formatMessage for temporal context)
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
        '\nThis is the diplomacy phase. Use sendMessage to:' +
          '\n- Propose alliances and coordinate attacks on shared enemies' +
          '\n- Agree on which neutral SCs each power will take' +
          '\n- Warn neighbors against attacking you' +
          '\nSend at least one message, then call ready() when done.',
      );
      break;
    case 'Orders': {
      // Identify nearby unowned SCs to suggest targets
      const targets: string[] = [];
      for (const u of myUnits) {
        const prov = PROVINCES[u.province];
        const adj =
          u.type === UnitType.Army
            ? (prov?.adjacency.army ?? [])
            : u.coast && prov?.adjacency.fleetByCoast?.[u.coast]
              ? prov.adjacency.fleetByCoast[u.coast]!
              : (prov?.adjacency.fleet ?? []);
        for (const a of adj) {
          const target = PROVINCES[a];
          if (target?.supplyCenter && !state.supplyCenters.has(a)) {
            targets.push(`${unitStr(u)} can reach neutral SC: ${a}`);
          }
        }
      }
      const targetHint =
        targets.length > 0
          ? `\n\nNEARBY NEUTRAL SUPPLY CENTERS (capture these!):\n${targets.join('\n')}`
          : '';
      lines.push(
        '\n⚠️ ACTION REQUIRED: You MUST call submitOrders with one order per unit, then call ready().' +
          '\nDo NOT hold all units — move toward supply centers! Holding every unit is losing.' +
          '\nUse Move orders to advance, Support orders to help allies or reinforce your own moves.' +
          targetHint,
      );
      break;
    }
    case 'Retreats':
      lines.push(
        '\n⚠️ ACTION REQUIRED: You MUST call the submitRetreats tool.' +
          '\nSteps: 1) getRetreatOptions 2) submitRetreats 3) ready()' +
          '\nDo NOT end your turn without calling submitRetreats.',
      );
      break;
    case 'Builds': {
      const buildCount = mySCs - myUnits.length;
      if (buildCount > 0) {
        // Find open home centers for build suggestions
        const homeCenters = [...state.supplyCenters.entries()]
          .filter(([, p]) => p === power)
          .map(([prov]) => prov)
          .filter((prov) => PROVINCES[prov]?.homeCenter === power)
          .filter((prov) => !state.units.some((u) => u.province === prov));
        const homeList =
          homeCenters.length > 0
            ? `\nYour open home centers: ${homeCenters.join(', ')}`
            : '\nWARNING: All home centers are occupied — you must Waive.';
        const buildInstructions =
          homeCenters.length > 0
            ? '\nCall submitBuilds with a Build order for each unit. Each needs: type "Build", unitType "Army" or "Fleet", province (one of your open home centers above).' +
              '\nFor fleet builds on multi-coast provinces (stp, spa, bul), also specify coast: "nc" or "sc".'
            : '\nAll home centers are occupied. Call submitBuilds with Waive orders: type "Waive" (no unitType or province needed).';
        lines.push(
          `\n⚠️ ACTION REQUIRED: You MUST build ${buildCount} unit(s).` +
            homeList +
            buildInstructions +
            '\nDo NOT submit an empty array — you must build to grow stronger!' +
            '\nThen call ready().',
        );
      } else if (buildCount < 0) {
        lines.push(
          `\n⚠️ ACTION REQUIRED: You have ${myUnits.length} units but only ${mySCs} supply centers — you MUST disband ${-buildCount} unit(s).` +
            '\nCall submitBuilds with an array of Remove orders. Each remove needs: type "Remove" and province (where the unit to disband is).' +
            '\nThen call ready().',
        );
      } else {
        lines.push(
          '\nYou have equal units and supply centers — no builds or disbands needed. Call submitBuilds with an empty array, then ready().',
        );
      }
      break;
    }
  }

  return lines.join('\n');
}
