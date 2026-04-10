import { PROVINCES } from '../../engine/map';
import { GameState, OrderType, Power } from '../../engine/types';

interface ParsedOrder {
  unit: string;
  type: string;
  destination?: string;
  supportedUnit?: string;
  convoyedUnit?: string;
  coast?: string;
}

export interface TextParseResult {
  orders: ParsedOrder[];
  unmatched: string[];
}

const PROVINCE_IDS = new Set(Object.keys(PROVINCES));

function isProvince(s: string): boolean {
  return PROVINCE_IDS.has(s.toLowerCase());
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Parse natural-language Diplomacy orders from text.
 * Handles formats like:
 *   "MOVE lon -> nth", "lon -> nth", "lon to nth"
 *   "HOLD lon", "lon HOLD"
 *   "SUPPORT yor supports lon -> nth", "yor S lon -> nth"
 *   "CONVOY nth convoys lon -> bre"
 */
export function parseTextOrders(
  text: string,
  gameState: GameState,
  power: Power,
): TextParseResult | null {
  const myUnitProvinces = new Set(
    gameState.units.filter((u) => u.power === power).map((u) => u.province),
  );

  if (myUnitProvinces.size === 0) return null;

  const orders: ParsedOrder[] = [];
  const unmatched: string[] = [];
  const assignedUnits = new Set<string>();

  const lines = text.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('```')) continue;

    let parsed = false;

    // Pattern 1: Support — "yor S lon -> nth" or "SUPPORT yor supports lon -> nth"
    const supportMoveRe =
      /(?:SUPPORT\s+)?(\w{2,3})\s+(?:S|supports?)\s+(\w{2,3})\s*(?:->|→|to|[-]>)\s*(\w{2,3})/i;
    const supportHoldRe =
      /(?:SUPPORT\s+)?(\w{2,3})\s+(?:S|supports?)\s+(\w{2,3})(?:\s+(?:hold|H))?$/i;
    let m = line.match(supportMoveRe);
    if (m) {
      const unit = norm(m[1]);
      const supported = norm(m[2]);
      const dest = norm(m[3]);
      if (
        isProvince(unit) &&
        isProvince(supported) &&
        isProvince(dest) &&
        myUnitProvinces.has(unit) &&
        !assignedUnits.has(unit)
      ) {
        orders.push({
          unit,
          type: OrderType.Support,
          supportedUnit: supported,
          destination: dest,
        });
        assignedUnits.add(unit);
        parsed = true;
      }
    }
    if (!parsed) {
      m = line.match(supportHoldRe);
      if (m) {
        const unit = norm(m[1]);
        const supported = norm(m[2]);
        if (
          isProvince(unit) &&
          isProvince(supported) &&
          myUnitProvinces.has(unit) &&
          !assignedUnits.has(unit)
        ) {
          orders.push({ unit, type: OrderType.Support, supportedUnit: supported });
          assignedUnits.add(unit);
          parsed = true;
        }
      }
    }

    // Pattern 2: Convoy — "nth C lon -> bre" or "CONVOY nth convoys lon -> bre"
    if (!parsed) {
      const convoyRe =
        /(?:CONVOY\s+)?(\w{2,3})\s+(?:C|convoys?)\s+(\w{2,3})\s*(?:->|→|to|[-]>)\s*(\w{2,3})/i;
      m = line.match(convoyRe);
      if (m) {
        const unit = norm(m[1]);
        const convoyed = norm(m[2]);
        const dest = norm(m[3]);
        if (
          isProvince(unit) &&
          isProvince(convoyed) &&
          isProvince(dest) &&
          myUnitProvinces.has(unit) &&
          !assignedUnits.has(unit)
        ) {
          orders.push({ unit, type: OrderType.Convoy, convoyedUnit: convoyed, destination: dest });
          assignedUnits.add(unit);
          parsed = true;
        }
      }
    }

    // Pattern 3: Hold — "HOLD lon" or "lon HOLD" or "lon holds"
    if (!parsed) {
      const holdRe = /(?:HOLD\s+)(\w{2,3})|(\w{2,3})\s+(?:HOLD|holds?|H)\b/i;
      m = line.match(holdRe);
      if (m) {
        const unit = norm(m[1] || m[2]);
        if (isProvince(unit) && myUnitProvinces.has(unit) && !assignedUnits.has(unit)) {
          orders.push({ unit, type: OrderType.Hold });
          assignedUnits.add(unit);
          parsed = true;
        }
      }
    }

    // Pattern 4: Move — "lon -> nth", "MOVE lon to nth", "A lon -> nth", "lon → nth"
    if (!parsed) {
      const moveRe =
        /(?:MOVE\s+)?(?:A|F|Army|Fleet)?\s*(\w{2,3})\s*(?:->|→|to|[-]>)\s*(\w{2,3})(?:\s*[/]?\s*(nc|sc))?/i;
      m = line.match(moveRe);
      if (m) {
        const unit = norm(m[1]);
        const dest = norm(m[2]);
        const coast = m[3] ? norm(m[3]) : undefined;
        if (
          isProvince(unit) &&
          isProvince(dest) &&
          myUnitProvinces.has(unit) &&
          !assignedUnits.has(unit)
        ) {
          orders.push({
            unit,
            type: OrderType.Move,
            destination: dest,
            ...(coast ? { coast } : {}),
          });
          assignedUnits.add(unit);
          parsed = true;
        }
      }
    }

    if (!parsed && line.length > 3) {
      // Only track meaningful unmatched lines
      const hasProvinceRef = [...PROVINCE_IDS].some(
        (id) => line.toLowerCase().includes(id) && id.length >= 3,
      );
      if (hasProvinceRef) unmatched.push(line);
    }
  }

  if (orders.length === 0) return null;
  return { orders, unmatched };
}

// ── Build order parsing ───────────────────────────────────────────────

interface ParsedBuild {
  type: string;
  unitType?: string;
  province?: string;
  coast?: string;
}

export interface TextBuildParseResult {
  builds: ParsedBuild[];
  unmatched: string[];
}

/**
 * Parse natural-language build/remove/waive orders from text.
 * Handles formats like:
 *   "Build Army in vie", "Build Fleet bre", "Build A vie"
 *   "Remove unit in bud", "Remove bud", "Disband bud"
 *   "Waive", "Waive build"
 */
export function parseTextBuilds(text: string): TextBuildParseResult | null {
  const builds: ParsedBuild[] = [];
  const unmatched: string[] = [];

  const lines = text.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('```')) continue;

    let parsed = false;

    // Pattern 1: Build — "Build Army in vie", "Build Fleet bre/sc", "Build A vie"
    const buildRe =
      /build\s+(?:an?\s+)?(army|fleet|A|F)\s+(?:in\s+|at\s+)?(\w{2,3})(?:\s*[/]?\s*(nc|sc))?/i;
    let m = line.match(buildRe);
    if (m) {
      const unitType = m[1].toLowerCase().startsWith('a') ? 'Army' : 'Fleet';
      const province = m[2].toLowerCase();
      const coast = m[3]?.toLowerCase();
      if (isProvince(province)) {
        builds.push({
          type: 'Build',
          unitType,
          province,
          ...(coast ? { coast } : {}),
        });
        parsed = true;
      }
    }

    // Pattern 2: Remove — "Remove bud", "Remove unit in bud", "Disband bud"
    if (!parsed) {
      const removeRe = /(?:remove|disband)\s+(?:(?:unit|army|fleet)\s+)?(?:in\s+|at\s+)?(\w{2,3})/i;
      m = line.match(removeRe);
      if (m) {
        const province = m[1].toLowerCase();
        if (isProvince(province)) {
          builds.push({ type: 'Remove', province });
          parsed = true;
        }
      }
    }

    // Pattern 3: Waive — "Waive", "Waive build"
    if (!parsed) {
      if (/\bwaive\b/i.test(line)) {
        builds.push({ type: 'Waive' });
        parsed = true;
      }
    }

    if (!parsed && line.length > 3) {
      const hasBuildRef = /build|remove|disband|waive|army|fleet/i.test(line);
      if (hasBuildRef) unmatched.push(line);
    }
  }

  if (builds.length === 0) return null;
  return { builds, unmatched };
}
