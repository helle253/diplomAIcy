import { PROVINCES } from '../../engine/map.js';
import {
  BuildOrder,
  Coast,
  GameState,
  Message,
  Order,
  OrderType,
  Phase,
  Power,
  RetreatOrder,
  RetreatSituation,
  Unit,
  UnitType,
} from '../../engine/types.js';

// Build lookup maps for province resolution
const PROVINCE_BY_NAME = new Map<string, string>();
for (const [id, prov] of Object.entries(PROVINCES)) {
  PROVINCE_BY_NAME.set(id.toLowerCase(), id);
  PROVINCE_BY_NAME.set(prov.name.toLowerCase(), id);
}

function resolveProvince(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  return PROVINCE_BY_NAME.get(input.toLowerCase().trim()) ?? null;
}

function resolveCoast(input: unknown): Coast | undefined {
  if (typeof input !== 'string') return undefined;
  const val = input.toLowerCase().trim();
  if (val === 'nc' || val === 'north') return Coast.North;
  if (val === 'sc' || val === 'south') return Coast.South;
  return undefined;
}

function resolveSinglePower(input: string): Power | 'Global' | null {
  const val = input.trim();
  if (val.toLowerCase() === 'global') return 'Global';
  for (const p of Object.values(Power)) {
    if (p.toLowerCase() === val.toLowerCase()) return p;
  }
  return null;
}

function resolveRecipient(input: unknown): Power | Power[] | 'Global' | null {
  if (typeof input === 'string') {
    return resolveSinglePower(input);
  }
  if (Array.isArray(input)) {
    const powers: Power[] = [];
    for (const item of input) {
      if (typeof item !== 'string') continue;
      const resolved = resolveSinglePower(item);
      if (resolved && resolved !== 'Global') powers.push(resolved);
    }
    if (powers.length === 0) return null;
    if (powers.length === 1) return powers[0];
    return powers;
  }
  return null;
}

function resolveOrderType(input: unknown): OrderType | null {
  if (typeof input !== 'string') return null;
  const val = input.toLowerCase().trim();
  switch (val) {
    case 'hold':
      return OrderType.Hold;
    case 'move':
      return OrderType.Move;
    case 'support':
      return OrderType.Support;
    case 'convoy':
      return OrderType.Convoy;
    default:
      return null;
  }
}

/**
 * Extract JSON array from LLM response text.
 * Tries fenced code block first, then raw JSON parse.
 */
export function extractJSON(text: string): unknown[] {
  // Try fenced code block
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }

  // Try finding a JSON array directly
  const bracketStart = text.indexOf('[');
  const bracketEnd = text.lastIndexOf(']');
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    try {
      const parsed = JSON.parse(text.slice(bracketStart, bracketEnd + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }

  return [];
}

export function parseOrders(text: string, state: GameState, power: Power): Order[] {
  const myUnits = state.units.filter((u) => u.power === power);
  const unitMap = new Map<string, Unit>();
  for (const u of myUnits) unitMap.set(u.province, u);

  const raw = extractJSON(text) as Record<string, unknown>[];
  const orders = new Map<string, Order>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;

    const unitProv = resolveProvince(item.unit);
    if (!unitProv || !unitMap.has(unitProv)) continue;

    const orderType = resolveOrderType(item.type);
    if (!orderType) continue;

    const unit = unitMap.get(unitProv)!;

    switch (orderType) {
      case OrderType.Hold:
        orders.set(unitProv, { type: OrderType.Hold, unit: unitProv });
        break;

      case OrderType.Move: {
        const dest = resolveProvince(item.destination);
        if (!dest) break;
        const coast = resolveCoast(item.coast);
        // Pass through to resolver — invalid moves become Hold per Diplomacy rules
        orders.set(unitProv, { type: OrderType.Move, unit: unitProv, destination: dest, coast });
        break;
      }

      case OrderType.Support: {
        const supported = resolveProvince(item.supportedUnit);
        if (!supported) break;
        // Supported unit must exist
        if (!state.units.some((u) => u.province === supported)) break;
        const dest = resolveProvince(item.destination);
        orders.set(unitProv, {
          type: OrderType.Support,
          unit: unitProv,
          supportedUnit: supported,
          destination: dest ?? undefined,
        });
        break;
      }

      case OrderType.Convoy: {
        const convoyed = resolveProvince(item.convoyedUnit);
        const dest = resolveProvince(item.destination);
        if (!convoyed || !dest) break;
        if (unit.type !== UnitType.Fleet) break;
        orders.set(unitProv, {
          type: OrderType.Convoy,
          unit: unitProv,
          convoyedUnit: convoyed,
          destination: dest,
        });
        break;
      }
    }
  }

  // Fill missing units with Hold
  const result: Order[] = [];
  for (const u of myUnits) {
    result.push(orders.get(u.province) ?? { type: OrderType.Hold, unit: u.province });
  }
  return result;
}

/** Resolve and sanitize the recipient, filtering out self */
function sanitizeRecipient(input: unknown, self: Power): Power | Power[] | 'Global' | null {
  const to = resolveRecipient(input);
  if (!to) return null;
  if (to === self) return null;
  if (Array.isArray(to)) {
    const filtered = to.filter((p) => p !== self);
    if (filtered.length === 0) return null;
    if (filtered.length === 1) return filtered[0];
    return filtered;
  }
  return to;
}

export function parseMessages(text: string, power: Power, phase: Phase): Message[] {
  const raw = extractJSON(text) as Record<string, unknown>[];
  const messages: Message[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;

    const to = sanitizeRecipient(item.to, power);
    if (!to) continue;

    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) continue;

    messages.push({
      from: power,
      to,
      content,
      phase,
      timestamp: Date.now(),
    });
  }

  return messages;
}

/**
 * Parse the batch negotiation response which can be either:
 * - A JSON object { replies: [...], defer: [1, 3] }
 * - A plain JSON array [...] (backward compat, treated as all replies)
 */
export function parseBatchNegotiationResponse(
  text: string,
  power: Power,
  phase: Phase,
  incomingCount: number,
): { replies: Message[]; deferredIndices: number[] } {
  // Try to extract a JSON object with replies/defer
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const jsonStr = fenceMatch?.[1] ?? text;

  let repliesRaw: unknown[] = [];
  let deferRaw: unknown[] = [];

  try {
    // Try parsing as object first
    const braceStart = jsonStr.indexOf('{');
    const braceEnd = jsonStr.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      const parsed = JSON.parse(jsonStr.slice(braceStart, braceEnd + 1)) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.replies)) repliesRaw = parsed.replies;
        if (Array.isArray(parsed.defer)) deferRaw = parsed.defer;
      }
    }
  } catch {
    /* fall through to array parsing */
  }

  // Fallback: treat entire response as a replies array
  if (repliesRaw.length === 0 && deferRaw.length === 0) {
    repliesRaw = extractJSON(text);
  }

  const replies = parseMessagesFromArray(repliesRaw, power, phase);

  // Validate deferred indices (1-based from prompt → 0-based)
  const deferredIndices: number[] = [];
  for (const d of deferRaw) {
    const idx = typeof d === 'number' ? d - 1 : -1; // convert 1-based to 0-based
    if (idx >= 0 && idx < incomingCount) {
      deferredIndices.push(idx);
    }
  }

  return { replies, deferredIndices };
}

function parseMessagesFromArray(raw: unknown[], power: Power, phase: Phase): Message[] {
  const messages: Message[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const to = sanitizeRecipient(rec.to, power);
    if (!to) continue;
    const content = typeof rec.content === 'string' ? rec.content.trim() : '';
    if (!content) continue;
    messages.push({ from: power, to, content, phase, timestamp: Date.now() });
  }
  return messages;
}

export function parseRetreats(
  text: string,
  situations: RetreatSituation[],
  power: Power,
): RetreatOrder[] {
  const mySituations = situations.filter((s) => s.unit.power === power);
  const raw = extractJSON(text) as Record<string, unknown>[];
  const orders = new Map<string, RetreatOrder>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;

    const unitProv = resolveProvince(item.unit);
    if (!unitProv) continue;

    const situation = mySituations.find((s) => s.unit.province === unitProv);
    if (!situation) continue;

    const action = typeof item.action === 'string' ? item.action.toLowerCase() : '';
    if (action === 'disband') {
      orders.set(unitProv, { type: 'Disband', unit: unitProv });
      continue;
    }

    const dest = resolveProvince(item.destination);
    if (dest && situation.validDestinations.includes(dest)) {
      const destProv = PROVINCES[dest];
      let coast: Coast | undefined;
      if (
        situation.unit.type === UnitType.Fleet &&
        destProv?.coasts &&
        destProv.coasts.length > 0
      ) {
        coast = resolveCoast(item.coast);
        if (!coast) {
          // Try to infer coast from adjacency
          const reachable = destProv.coasts.filter((c) => {
            const adj = destProv.adjacency.fleetByCoast?.[c];
            return adj?.includes(unitProv);
          });
          coast = reachable.length === 1 ? reachable[0] : reachable[0];
        }
      }
      orders.set(unitProv, { type: 'RetreatMove', unit: unitProv, destination: dest, coast });
    } else {
      orders.set(unitProv, { type: 'Disband', unit: unitProv });
    }
  }

  // Any unhandled dislodged units disband
  const result: RetreatOrder[] = [];
  for (const s of mySituations) {
    result.push(orders.get(s.unit.province) ?? { type: 'Disband', unit: s.unit.province });
  }
  return result;
}

export function parseBuildOrders(
  text: string,
  state: GameState,
  power: Power,
  buildCount: number,
): BuildOrder[] {
  const raw = extractJSON(text) as Record<string, unknown>[];
  const orders: BuildOrder[] = [];

  if (buildCount > 0) {
    const occupiedProvinces = new Set(state.units.map((u) => u.province));
    let remaining = buildCount;

    for (const item of raw) {
      if (remaining <= 0) break;
      if (!item || typeof item !== 'object') continue;

      const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';

      if (type === 'waive') {
        orders.push({ type: 'Waive' });
        remaining--;
        continue;
      }

      if (type === 'build') {
        const prov = resolveProvince(item.province);
        if (!prov) continue;

        const province = PROVINCES[prov];
        if (!province?.supplyCenter || province.homeCenter !== power) continue;
        if (state.supplyCenters.get(prov) !== power) continue;
        if (occupiedProvinces.has(prov)) continue;

        const unitTypeStr = typeof item.unitType === 'string' ? item.unitType.toLowerCase() : '';
        let unitType: UnitType;
        if (unitTypeStr === 'fleet' || unitTypeStr === 'f') {
          unitType = UnitType.Fleet;
        } else {
          unitType = UnitType.Army;
        }

        // Fleets can't go inland
        if (unitType === UnitType.Fleet && province.type === 'Land') {
          unitType = UnitType.Army;
        }

        const coast = resolveCoast(item.coast);
        orders.push({ type: 'Build', unitType, province: prov, coast });
        occupiedProvinces.add(prov);
        remaining--;
      }
    }

    // Waive remaining
    while (remaining > 0) {
      orders.push({ type: 'Waive' });
      remaining--;
    }
  } else if (buildCount < 0) {
    const myUnits = state.units.filter((u) => u.power === power);
    const removed = new Set<string>();
    let remaining = Math.abs(buildCount);

    for (const item of raw) {
      if (remaining <= 0) break;
      if (!item || typeof item !== 'object') continue;

      const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
      if (type !== 'remove') continue;

      const unitProv = resolveProvince(item.unit);
      if (!unitProv || removed.has(unitProv)) continue;
      if (!myUnits.some((u) => u.province === unitProv)) continue;

      orders.push({ type: 'Remove', unit: unitProv });
      removed.add(unitProv);
      remaining--;
    }

    // Force-remove remaining from the end
    for (let i = myUnits.length - 1; i >= 0 && remaining > 0; i--) {
      if (!removed.has(myUnits[i].province)) {
        orders.push({ type: 'Remove', unit: myUnits[i].province });
        remaining--;
      }
    }
  }

  return orders;
}
