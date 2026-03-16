import { PROVINCES } from '../../engine/map';
import { GameState, Message, OrderResolution, Power, Unit, UnitType } from '../../engine/types';

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

HOW TO PLAY:
- Your units and reachable provinces are shown in the turn prompt
- Use getProvinceInfo to scout enemy positions if needed
- Use sendMessage to negotiate with other powers
- During Orders/Retreats/Builds phases: you MUST call submitOrders/submitRetreats/submitBuilds before calling ready()
- During the Diplomacy phase: only use sendMessage and ready() — no submission tools are available`;
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
        const example =
          homeCenters.length > 0
            ? `\nExample: submitBuilds({ builds: [{ type: "Build", unitType: "Army", province: "${homeCenters[0]}" }] })`
            : '\nExample: submitBuilds({ builds: [{ type: "Waive" }] })';
        lines.push(
          `\n⚠️ ACTION REQUIRED: You have ${mySCs} supply centers and ${myUnits.length} units — you MUST build ${buildCount} unit(s).` +
            homeList +
            example +
            '\nDo NOT submit an empty array — you must build units to grow stronger!' +
            '\nFor fleet builds on multi-coast provinces (stp, spa, bul), specify coast: "nc" or "sc".' +
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
