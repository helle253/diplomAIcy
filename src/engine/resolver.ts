import {
  Coast,
  ConvoyOrder,
  MoveOrder,
  Order,
  OrderResolution,
  OrderStatus,
  OrderType,
  Province,
  ProvinceType,
  RetreatSituation,
  SupportOrder,
  Unit,
  UnitType,
} from './types';

// === Result type ===

export interface ResolutionResult {
  resolutions: OrderResolution[];
  dislodgedUnits: RetreatSituation[];
  newPositions: Unit[];
}

// === Internal state for the iterative resolver ===

interface OrderState {
  order: Order;
  unit: Unit;
  status: OrderStatus;
  reason?: string;
  /** The order as originally submitted, before validation converted it. */
  originalOrder?: Order;
}

// === Helper: find unit at a province ===

function findUnit(units: Unit[], province: string): Unit | undefined {
  return units.find((u) => u.province === province);
}

// === Helper: check adjacency ===

function isAdjacent(
  from: string,
  to: string,
  unitType: UnitType,
  provinces: Record<string, Province>,
  fromCoast?: Coast,
): boolean {
  const prov = provinces[from];
  if (!prov) return false;
  if (unitType === UnitType.Army) {
    return prov.adjacency.army.includes(to);
  }

  // Fleet on a multi-coast province: use coast-specific adjacency
  if (fromCoast && prov.adjacency.fleetByCoast) {
    const coastAdj = prov.adjacency.fleetByCoast[fromCoast];
    return coastAdj ? coastAdj.includes(to) : false;
  }

  // Fleet moving to a multi-coast province: check if reachable via any coast
  const destProv = provinces[to];
  if (destProv?.adjacency.fleetByCoast) {
    return Object.values(destProv.adjacency.fleetByCoast).some((adj) => adj && adj.includes(from));
  }

  return prov.adjacency.fleet.includes(to);
}

// === Helper: check if a convoy route exists ===

function convoyRouteExists(
  from: string,
  to: string,
  convoyOrders: OrderState[],
  provinces: Record<string, Province>,
): boolean {
  // Find all fleets that are convoying this army from `from` to `to` and haven't failed
  const availableConvoys = convoyOrders.filter((os) => {
    const o = os.order as ConvoyOrder;
    return o.convoyedUnit === from && o.destination === to && os.status === OrderStatus.Succeeds;
  });

  const convoyProvinces = new Set(availableConvoys.map((os) => os.order.unit));

  // BFS from `from` to `to` through convoy fleet provinces
  const visited = new Set<string>();
  const queue: string[] = [from];
  visited.add(from);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const prov = provinces[current];
    if (!prov) continue;

    // Check all adjacent provinces (use fleet adjacency for sea connections, army for land)
    const neighbors =
      current === from
        ? // From the army's province, look at all adjacent sea/coastal provinces
          prov.adjacency.fleet.length > 0
          ? prov.adjacency.fleet
          : prov.adjacency.army
        : (provinces[current]?.adjacency.fleet ?? []);

    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);

      if (neighbor === to) return true;

      // Can only pass through convoy fleet provinces
      if (convoyProvinces.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  return false;
}

// === Validate an order and convert invalid ones to Hold ===

function validateOrder(
  order: Order,
  unit: Unit,
  units: Unit[],
  provinces: Record<string, Province>,
): Order {
  switch (order.type) {
    case OrderType.Move: {
      const move = order as MoveOrder;
      if (move.viaConvoy) {
        // Convoy moves: army must exist, destination must be land/coastal
        if (unit.type !== UnitType.Army) {
          return { type: OrderType.Hold, unit: order.unit };
        }
        const destProv = provinces[move.destination];
        if (!destProv || destProv.type === ProvinceType.Sea) {
          return { type: OrderType.Hold, unit: order.unit };
        }
      } else {
        // Direct move: must be adjacent
        if (!isAdjacent(order.unit, move.destination, unit.type, provinces, unit.coast)) {
          return { type: OrderType.Hold, unit: order.unit };
        }
        const destProv = provinces[move.destination];
        if (!destProv) {
          return { type: OrderType.Hold, unit: order.unit };
        }
        // Armies can't move to sea provinces
        if (unit.type === UnitType.Army && destProv.type === ProvinceType.Sea) {
          return { type: OrderType.Hold, unit: order.unit };
        }
        // Fleets can't move to land (non-coastal) provinces
        if (unit.type === UnitType.Fleet && destProv.type === ProvinceType.Land) {
          return { type: OrderType.Hold, unit: order.unit };
        }
        // Fleet moving to multi-coast province must specify a valid, reachable coast
        if (unit.type === UnitType.Fleet && destProv.coasts && destProv.coasts.length > 0) {
          if (!move.coast || !destProv.coasts.includes(move.coast)) {
            return { type: OrderType.Hold, unit: order.unit };
          }
          // The specified coast must be reachable from the source province
          const coastAdj = destProv.adjacency.fleetByCoast?.[move.coast];
          if (!coastAdj || !coastAdj.includes(order.unit)) {
            return { type: OrderType.Hold, unit: order.unit };
          }
        }
      }
      return order;
    }

    case OrderType.Support: {
      const sup = order as SupportOrder;
      // Supported unit must exist
      const supportedUnit = findUnit(units, sup.supportedUnit);
      if (!supportedUnit) {
        return { type: OrderType.Hold, unit: order.unit };
      }
      if (sup.destination) {
        // Support-move: the supporting unit must be able to move to the destination
        // (adjacency check with the supporting unit's type)
        if (!isAdjacent(order.unit, sup.destination, unit.type, provinces, unit.coast)) {
          return { type: OrderType.Hold, unit: order.unit };
        }
      } else {
        // Support-hold: the supporting unit must be adjacent to the supported unit
        if (!isAdjacent(order.unit, sup.supportedUnit, unit.type, provinces, unit.coast)) {
          return { type: OrderType.Hold, unit: order.unit };
        }
      }
      return order;
    }

    case OrderType.Convoy: {
      const convoy = order as ConvoyOrder;
      // Must be a fleet in a sea province
      if (unit.type !== UnitType.Fleet) {
        return { type: OrderType.Hold, unit: order.unit };
      }
      const unitProv = provinces[order.unit];
      if (!unitProv || unitProv.type !== ProvinceType.Sea) {
        return { type: OrderType.Hold, unit: order.unit };
      }
      // Convoyed unit must exist and be an army
      const convoyedUnit = findUnit(units, convoy.convoyedUnit);
      if (!convoyedUnit || convoyedUnit.type !== UnitType.Army) {
        return { type: OrderType.Hold, unit: order.unit };
      }
      return order;
    }

    case OrderType.Hold:
      return order;
  }
}

// === Main resolution function ===

export function resolveOrders(
  units: Unit[],
  orders: Map<string, Order>,
  provinces: Record<string, Province>,
): ResolutionResult {
  // Build order states, assigning Hold to units without orders
  const orderStates = new Map<string, OrderState>();

  for (const unit of units) {
    const submittedOrder = orders.get(unit.province) ?? {
      type: OrderType.Hold as const,
      unit: unit.province,
    };
    const validatedOrder = validateOrder(submittedOrder, unit, units, provinces);
    const wasInvalid = validatedOrder !== submittedOrder && submittedOrder.type !== OrderType.Hold;
    orderStates.set(unit.province, {
      order: validatedOrder,
      unit,
      status: OrderStatus.Succeeds, // optimistic start
      ...(wasInvalid ? { originalOrder: submittedOrder } : {}),
    });
  }

  // Iterative fixed-point resolution
  let changed = true;
  let iterations = 0;
  const MAX_ITERATIONS = 100;

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;

    // Phase 0: Re-evaluate — restore statuses that may have been set based on
    // stale information (e.g. support cut by a convoyed attack whose convoy was
    // later disrupted). This allows the subsequent phases to re-derive the
    // correct result. Only combat-related failures are reset; permanent failures
    // (self-dislodgement, invalid orders) are kept.
    for (const [, state] of orderStates) {
      if (state.status !== OrderStatus.Fails) continue;
      if (state.order.type === OrderType.Support && state.reason?.startsWith('Support cut by')) {
        state.status = OrderStatus.Succeeds;
        state.reason = undefined;
      } else if (
        state.order.type === OrderType.Move &&
        (state.reason?.includes('Bounced') || state.reason?.includes('Failed to dislodge'))
      ) {
        state.status = OrderStatus.Succeeds;
        state.reason = undefined;
      }
    }

    // Phase 1: Check convoy routes for convoy moves
    for (const [prov, state] of orderStates) {
      if (state.order.type === OrderType.Move && (state.order as MoveOrder).viaConvoy) {
        const move = state.order as MoveOrder;
        const convoyStates = Array.from(orderStates.values()).filter(
          (os) => os.order.type === OrderType.Convoy,
        );
        const routeExists = convoyRouteExists(prov, move.destination, convoyStates, provinces);
        if (!routeExists && state.status === OrderStatus.Succeeds) {
          state.status = OrderStatus.Fails;
          state.reason = 'No valid convoy route';
          changed = true;
        }
      }
    }

    for (const [prov, state] of orderStates) {
      if (state.order.type !== OrderType.Support) continue;
      if (state.status !== OrderStatus.Succeeds) continue;

      const sup = state.order as SupportOrder;
      const targetProvince = sup.destination ?? sup.supportedUnit;

      // Check if any unit is attacking the supporting unit
      for (const [attackProv, attackState] of orderStates) {
        if (attackState.order.type !== OrderType.Move) continue;
        const attackMove = attackState.order as MoveOrder;
        if (attackMove.destination !== prov) continue;

        // Support is NOT cut if the attack comes from the province the support targets
        if (attackProv === targetProvince) continue;

        // A convoyed move with no valid route does NOT cut support — the army
        // never moved. (A convoyed move that bounces at the destination still
        // cuts support, like any other bounced move.)
        if (attackMove.viaConvoy) {
          const convoyStates = Array.from(orderStates.values()).filter(
            (os) => os.order.type === OrderType.Convoy,
          );
          const routeExists = convoyRouteExists(
            attackProv,
            attackMove.destination,
            convoyStates,
            provinces,
          );
          if (!routeExists) continue;
        }

        // Support IS cut by any valid attack from a non-target province.
        state.status = OrderStatus.Fails;
        state.reason = `Support cut by attack from ${attackProv}`;
        changed = true;
        break;
      }
    }

    // Phase 3: Resolve move conflicts
    for (const [prov, state] of orderStates) {
      if (state.order.type !== OrderType.Move) continue;
      if (state.status !== OrderStatus.Succeeds) continue;

      const move = state.order as MoveOrder;
      const destination = move.destination;
      const attackStrength = calculateAttackStrength(prov, orderStates, units);

      // Check for head-to-head battle
      const headToHead = findHeadToHead(prov, move, orderStates);

      if (headToHead) {
        const opposingStrength = calculateAttackStrength(headToHead, orderStates, units);

        if (attackStrength <= opposingStrength) {
          state.status = OrderStatus.Fails;
          state.reason = `Bounced in head-to-head with ${headToHead} (${attackStrength} vs ${opposingStrength})`;
          changed = true;
          continue;
        }
        // If we win the head-to-head, the opposing move will fail on its iteration
      }

      // Check competing moves to the same destination
      const competitors = getCompetingMoves(prov, destination, orderStates);
      if (competitors.length > 0) {
        const maxCompetitorStrength = Math.max(
          ...competitors.map((c) => calculateAttackStrength(c, orderStates, units)),
        );
        if (attackStrength <= maxCompetitorStrength) {
          // Bounce: we're not strictly stronger
          state.status = OrderStatus.Fails;
          state.reason = `Bounced with competing move(s) to ${destination}`;
          changed = true;

          // Also fail all competitors with equal or lesser strength
          for (const comp of competitors) {
            const compState = orderStates.get(comp)!;
            const compStrength = calculateAttackStrength(comp, orderStates, units);
            if (compStrength <= attackStrength && compState.status === OrderStatus.Succeeds) {
              compState.status = OrderStatus.Fails;
              compState.reason = `Bounced with competing move(s) to ${destination}`;
              changed = true;
            }
          }
          continue;
        }
      }

      // Check if destination is occupied by a unit not moving away (or failing to move)
      const occupier = findUnit(units, destination);
      if (occupier) {
        const occupierState = orderStates.get(destination);
        const occupierIsMovingAway =
          occupierState &&
          occupierState.order.type === OrderType.Move &&
          (occupierState.order as MoveOrder).destination !== prov &&
          occupierState.status === OrderStatus.Succeeds;

        const occupierIsInHeadToHead =
          occupierState &&
          occupierState.order.type === OrderType.Move &&
          (occupierState.order as MoveOrder).destination === prov;

        if (!occupierIsMovingAway && !occupierIsInHeadToHead) {
          // Must overcome the hold strength
          const holdStrength = calculateHoldStrength(destination, orderStates, units);

          // Self-dislodgement prevention
          if (state.unit.power === occupier.power) {
            state.status = OrderStatus.Fails;
            state.reason = 'Cannot dislodge own unit';
            changed = true;
            continue;
          }

          if (attackStrength <= holdStrength) {
            state.status = OrderStatus.Fails;
            state.reason = `Failed to dislodge unit in ${destination} (${attackStrength} vs ${holdStrength})`;
            changed = true;
            continue;
          }
        }
      }
    }

    // Phase 4: Fail convoys whose fleet is dislodged
    for (const [prov, state] of orderStates) {
      if (state.order.type !== OrderType.Convoy) continue;
      if (state.status !== OrderStatus.Succeeds) continue;

      // Check if this convoy fleet is being dislodged
      if (isBeingDislodged(prov, orderStates, units)) {
        state.status = OrderStatus.Fails;
        state.reason = 'Convoy fleet dislodged';
        changed = true;
      }
    }

    // Phase 5: Handle circular movement
    // Detect cycles of moves where each unit moves to the next unit's province
    resolveCircularMovement(orderStates, units);

    // Phase 6: Self-dislodgement prevention for supports
    // If a support would cause a unit of the same power to be dislodged, the support fails
    for (const [, state] of orderStates) {
      if (state.order.type !== OrderType.Support) continue;
      if (state.status !== OrderStatus.Succeeds) continue;

      const sup = state.order as SupportOrder;
      if (!sup.destination) continue; // support-hold doesn't cause dislodgement

      // Check if the supported move would dislodge a unit of the same power
      const targetOccupier = findUnit(units, sup.destination);
      if (targetOccupier && targetOccupier.power === state.unit.power) {
        // Check if the target occupier is not moving away successfully
        const targetState = orderStates.get(sup.destination);
        const isMovingAway =
          targetState &&
          targetState.order.type === OrderType.Move &&
          targetState.status === OrderStatus.Succeeds;

        if (!isMovingAway) {
          state.status = OrderStatus.Fails;
          state.reason = 'Cannot support dislodgement of own unit';
          changed = true;
        }
      }
    }
  }

  // Build results
  const resolutions: OrderResolution[] = [];
  const dislodgedUnits: RetreatSituation[] = [];
  const bouncedProvinces = new Set<string>();
  const successfulMoveDestinations = new Set<string>();

  // Identify bounced provinces (where competing moves all failed)
  for (const [, state] of orderStates) {
    if (state.order.type === OrderType.Move && state.status === OrderStatus.Fails) {
      const move = state.order as MoveOrder;
      if (state.reason?.includes('Bounced')) {
        bouncedProvinces.add(move.destination);
      }
    }
  }

  // Build resolutions and track successful moves
  for (const [, state] of orderStates) {
    resolutions.push({
      order: state.order,
      power: state.unit.power,
      status: state.originalOrder ? OrderStatus.Invalid : state.status,
      reason: state.originalOrder ? 'Invalid order, resolved as Hold' : state.reason,
      originalOrder: state.originalOrder,
    });

    if (state.order.type === OrderType.Move && state.status === OrderStatus.Succeeds) {
      successfulMoveDestinations.add((state.order as MoveOrder).destination);
    }
  }

  // Determine dislodged units
  for (const [prov, state] of orderStates) {
    if (state.order.type === OrderType.Move && state.status === OrderStatus.Succeeds) {
      const move = state.order as MoveOrder;
      const dislodgedUnit = findUnit(units, move.destination);

      if (dislodgedUnit) {
        const dislodgedState = orderStates.get(move.destination);
        // Unit is dislodged if it's not successfully moving away
        const isMovingAway =
          dislodgedState &&
          dislodgedState.order.type === OrderType.Move &&
          dislodgedState.status === OrderStatus.Succeeds;

        if (!isMovingAway) {
          const validDests = getRetreatDestinations(
            dislodgedUnit,
            prov, // attacked from
            units,
            provinces,
            successfulMoveDestinations,
            bouncedProvinces,
          );

          dislodgedUnits.push({
            unit: dislodgedUnit,
            attackedFrom: prov,
            validDestinations: validDests,
          });
        }
      }
    }
  }

  // Build new positions
  const dislodgedProvs = new Set(dislodgedUnits.map((d) => d.unit.province));
  const newPositions: Unit[] = [];

  for (const unit of units) {
    if (dislodgedProvs.has(unit.province)) continue; // dislodged, will be in retreat situations

    const state = orderStates.get(unit.province);
    if (state && state.order.type === OrderType.Move && state.status === OrderStatus.Succeeds) {
      const move = state.order as MoveOrder;
      newPositions.push({
        ...unit,
        province: move.destination,
        coast: move.coast ?? undefined,
      });
    } else {
      newPositions.push({ ...unit });
    }
  }

  return { resolutions, dislodgedUnits, newPositions };
}

// === Strength calculations ===

function calculateAttackStrength(
  attackerProv: string,
  orderStates: Map<string, OrderState>,
  units: Unit[],
): number {
  const state = orderStates.get(attackerProv);
  if (!state || state.order.type !== OrderType.Move) return 0;

  const move = state.order as MoveOrder;
  let strength = 1;

  // Count successful supports for this move
  for (const [, supState] of orderStates) {
    if (supState.order.type !== OrderType.Support) continue;
    if (supState.status !== OrderStatus.Succeeds) continue;

    const sup = supState.order as SupportOrder;
    if (sup.supportedUnit === attackerProv && sup.destination === move.destination) {
      // Self-dislodgement check: don't count support if it would dislodge own unit
      const targetOccupier = findUnit(units, move.destination);
      if (targetOccupier && targetOccupier.power === supState.unit.power) {
        const targetState = orderStates.get(move.destination);
        const isMovingAway =
          targetState &&
          targetState.order.type === OrderType.Move &&
          targetState.status === OrderStatus.Succeeds;
        if (!isMovingAway) {
          continue; // Don't count this support
        }
      }
      strength++;
    }
  }

  return strength;
}

function calculateHoldStrength(
  province: string,
  orderStates: Map<string, OrderState>,
  units: Unit[],
): number {
  const unit = findUnit(units, province);
  if (!unit) return 0;

  const state = orderStates.get(province);
  if (!state) return 0;

  // If the unit is successfully moving away, hold strength is 0
  if (state.order.type === OrderType.Move && state.status === OrderStatus.Succeeds) {
    return 0;
  }

  let strength = 1;

  // Count successful support-holds
  for (const [, supState] of orderStates) {
    if (supState.order.type !== OrderType.Support) continue;
    if (supState.status !== OrderStatus.Succeeds) continue;

    const sup = supState.order as SupportOrder;
    // Support-hold: supportedUnit is the province, no destination
    if (sup.supportedUnit === province && !sup.destination) {
      strength++;
    }
  }

  return strength;
}

// === Head-to-head detection ===

function findHeadToHead(
  prov: string,
  move: MoveOrder,
  orderStates: Map<string, OrderState>,
): string | null {
  const targetState = orderStates.get(move.destination);
  if (!targetState) return null;
  if (targetState.order.type !== OrderType.Move) return null;

  const targetMove = targetState.order as MoveOrder;
  if (targetMove.destination === prov) {
    return move.destination;
  }
  return null;
}

// === Competing moves ===

function getCompetingMoves(
  excludeProv: string,
  destination: string,
  orderStates: Map<string, OrderState>,
): string[] {
  const competitors: string[] = [];
  for (const [prov, state] of orderStates) {
    if (prov === excludeProv) continue;
    if (state.order.type !== OrderType.Move) continue;
    if (state.status !== OrderStatus.Succeeds) continue;
    if ((state.order as MoveOrder).destination === destination) {
      competitors.push(prov);
    }
  }
  return competitors;
}

// === Check if a unit is being dislodged ===

function isBeingDislodged(
  province: string,
  orderStates: Map<string, OrderState>,
  units: Unit[],
): boolean {
  for (const [prov, state] of orderStates) {
    if (state.order.type !== OrderType.Move) continue;
    if (state.status !== OrderStatus.Succeeds) continue;
    const move = state.order as MoveOrder;
    if (move.destination === province) {
      // Check self-dislodgement
      const occupier = findUnit(units, province);
      if (occupier && occupier.power === state.unit.power) {
        return false; // Can't be dislodged by own power
      }

      const attackStrength = calculateAttackStrength(prov, orderStates, units);
      const holdStrength = calculateHoldStrength(province, orderStates, units);
      return attackStrength > holdStrength;
    }
  }
  return false;
}

// === Circular movement detection and resolution ===

function resolveCircularMovement(orderStates: Map<string, OrderState>, _units: Unit[]): void {
  // Find cycles of 3+ moves where all units rotate (A->B, B->C, C->A).
  // Only consider move orders that are still marked as succeeding.
  const moveOrders = new Map<string, string>();

  for (const [prov, state] of orderStates) {
    if (state.order.type !== OrderType.Move) continue;
    if (state.status !== OrderStatus.Succeeds) continue;
    moveOrders.set(prov, (state.order as MoveOrder).destination);
  }

  // Find cycles
  const visited = new Set<string>();
  for (const start of moveOrders.keys()) {
    if (visited.has(start)) continue;

    const path: string[] = [];
    let current: string | undefined = start;
    const pathSet = new Set<string>();

    while (current && moveOrders.has(current) && !pathSet.has(current)) {
      path.push(current);
      pathSet.add(current);
      current = moveOrders.get(current);
    }

    if (current && pathSet.has(current)) {
      // Found a cycle starting at `current`
      const cycleStart = path.indexOf(current);
      const cycle = path.slice(cycleStart);

      // 2-unit "cycles" are head-to-head battles, not circular movement
      if (cycle.length < 3) continue;

      // Verify all units in the cycle have strength 1 (no external support)
      // and all move to the next unit in the cycle
      let validCycle = true;
      for (const prov of cycle) {
        const state = orderStates.get(prov)!;
        if (state.order.type !== OrderType.Move) {
          validCycle = false;
          break;
        }
        // Check no external interference: only strength-1 moves, no competing moves
        const dest = (state.order as MoveOrder).destination;
        const competitors = getCompetingMoves(prov, dest, orderStates);
        if (competitors.length > 0) {
          validCycle = false;
          break;
        }
      }

      if (validCycle) {
        // All units in the cycle succeed
        for (const prov of cycle) {
          const state = orderStates.get(prov)!;
          if (state.status === OrderStatus.Fails) {
            state.status = OrderStatus.Succeeds;
            state.reason = undefined;
          }
        }
      }

      for (const p of cycle) visited.add(p);
    }

    for (const p of path) visited.add(p);
  }
}

// === Retreat destinations ===

function getRetreatDestinations(
  unit: Unit,
  attackedFrom: string,
  units: Unit[],
  provinces: Record<string, Province>,
  successfulMoveDestinations: Set<string>,
  bouncedProvinces: Set<string>,
): string[] {
  const prov = provinces[unit.province];
  if (!prov) return [];

  let adjacentProvs: string[];
  if (unit.type === UnitType.Army) {
    adjacentProvs = prov.adjacency.army;
  } else if (unit.coast && prov.adjacency.fleetByCoast) {
    adjacentProvs = prov.adjacency.fleetByCoast[unit.coast] ?? [];
  } else {
    adjacentProvs = prov.adjacency.fleet;
  }

  const occupiedProvinces = new Set<string>();
  // Current unit positions (before moves) minus those that moved away successfully
  for (const u of units) {
    if (successfulMoveDestinations.has(u.province)) {
      // This province might be vacated, but also might have someone moving in
    }
    occupiedProvinces.add(u.province);
  }
  // Add destinations of successful moves as occupied
  for (const dest of successfulMoveDestinations) {
    occupiedProvinces.add(dest);
  }
  // Remove provinces vacated by successful moves (units that moved away)
  // Actually, we need to compute final positions
  // Simplify: a province is occupied after resolution if a unit ends up there
  // We already know successfulMoveDestinations. Units that didn't move stay put.
  // Let's recompute.
  const finalOccupied = new Set<string>();
  for (const u of units) {
    if (u.province === unit.province) continue; // the dislodged unit itself
    // Check if this unit moved successfully
    if (successfulMoveDestinations.has(u.province)) {
      // This unit might have moved away, but we don't have the exact mapping here
      // We need to be conservative
    }
    finalOccupied.add(u.province);
  }
  for (const dest of successfulMoveDestinations) {
    finalOccupied.add(dest);
  }

  return adjacentProvs.filter((adj) => {
    // Cannot retreat to the province the attack came from
    if (adj === attackedFrom) return false;
    // Cannot retreat to an occupied province
    if (finalOccupied.has(adj)) return false;
    // Cannot retreat to a province where a bounce occurred
    if (bouncedProvinces.has(adj)) return false;
    // Province must be valid for the unit type
    const adjProv = provinces[adj];
    if (!adjProv) return false;
    if (unit.type === UnitType.Army && adjProv.type === ProvinceType.Sea) return false;
    if (unit.type === UnitType.Fleet && adjProv.type === ProvinceType.Land) return false;
    return true;
  });
}
