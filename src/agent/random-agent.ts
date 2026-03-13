import type { Unsubscribable } from '@trpc/server/observable';

import { PROVINCES } from '../engine/map';
import type { Unit } from '../engine/types';
import {
  BuildOrder,
  Coast,
  GameState,
  Message,
  Order,
  OrderType,
  Power,
  ProvinceType,
  RetreatOrder,
  UnitType,
} from '../engine/types';
import { logger } from '../util/logger';
import type { GameClient } from './remote/client';
import { deserializeGameState, type SerializedGameState } from './remote/deserialize';

// ── Utility ───────────────────────────────────────────────────────────────

function pickRandom<T>(arr: T[]): T {
  if (arr.length === 0) throw new Error('pickRandom called with empty array');
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Get valid adjacent provinces for a unit, handling multi-coast fleet movement.
 */
export function getAdjacentProvinces(unit: Unit): string[] {
  const province = PROVINCES[unit.province];
  if (!province) return [];

  if (unit.type === UnitType.Army) {
    return province.adjacency.army;
  }

  // Fleet: check if on a multi-coast province
  if (unit.coast && province.adjacency.fleetByCoast) {
    const coastAdj = province.adjacency.fleetByCoast[unit.coast];
    return coastAdj ?? [];
  }

  return province.adjacency.fleet;
}

// ── Order generation ─────────────────────────────────────────────────────

export function generateRandomOrders(state: GameState, power: Power): Order[] {
  const myUnits = state.units.filter((u) => u.power === power);
  const orders: Order[] = [];

  for (const unit of myUnits) {
    const province = PROVINCES[unit.province];
    if (!province) {
      orders.push({ type: OrderType.Hold, unit: unit.province });
      continue;
    }

    const adjacentProvs = getAdjacentProvinces(unit);
    const possibleOrders: Order[] = [];

    // Hold is always valid
    possibleOrders.push({ type: OrderType.Hold, unit: unit.province });

    // Move to each valid adjacent province
    for (const dest of adjacentProvs) {
      const destProv = PROVINCES[dest];
      if (!destProv) continue;

      // Armies cannot enter sea provinces
      if (unit.type === UnitType.Army && destProv.type === ProvinceType.Sea) continue;
      // Fleets cannot enter inland provinces
      if (unit.type === UnitType.Fleet && destProv.type === ProvinceType.Land) continue;

      // Handle multi-coast destinations for fleets
      if (unit.type === UnitType.Fleet && destProv.coasts && destProv.coasts.length > 0) {
        for (const coast of destProv.coasts) {
          const coastAdj = destProv.adjacency.fleetByCoast?.[coast];
          if (coastAdj && coastAdj.includes(unit.province)) {
            possibleOrders.push({
              type: OrderType.Move,
              unit: unit.province,
              destination: dest,
              coast,
            });
          }
        }
      } else {
        possibleOrders.push({
          type: OrderType.Move,
          unit: unit.province,
          destination: dest,
        });
      }
    }

    // Support-hold for a neighboring friendly unit
    for (const adj of adjacentProvs) {
      const friendlyUnit = myUnits.find((u) => u.province === adj);
      if (friendlyUnit) {
        possibleOrders.push({
          type: OrderType.Support,
          unit: unit.province,
          supportedUnit: adj,
          // No destination = support-hold
        });
      }
    }

    orders.push(pickRandom(possibleOrders));
  }

  return orders;
}

export function generateRandomRetreats(state: GameState, power: Power): RetreatOrder[] {
  const orders: RetreatOrder[] = [];

  for (const situation of state.retreatSituations) {
    if (situation.unit.power !== power) continue;

    if (situation.validDestinations.length > 0) {
      const dest = pickRandom(situation.validDestinations);
      const destProv = PROVINCES[dest];

      let coast: Coast | undefined;
      if (
        situation.unit.type === UnitType.Fleet &&
        destProv?.coasts &&
        destProv.coasts.length > 0
      ) {
        const reachableCoasts = destProv.coasts.filter((c) => {
          const coastAdj = destProv.adjacency.fleetByCoast?.[c];
          return coastAdj && coastAdj.includes(situation.unit.province);
        });
        if (reachableCoasts.length > 0) {
          coast = pickRandom(reachableCoasts);
        }
      }

      orders.push({
        type: 'RetreatMove',
        unit: situation.unit.province,
        destination: dest,
        coast,
      });
    } else {
      orders.push({
        type: 'Disband',
        unit: situation.unit.province,
      });
    }
  }

  return orders;
}

export function generateRandomBuilds(
  state: GameState,
  power: Power,
  buildCount: number,
): BuildOrder[] {
  const orders: BuildOrder[] = [];

  if (buildCount > 0) {
    const occupiedProvinces = new Set(state.units.map((u) => u.province));
    const homeCenters = Object.values(PROVINCES).filter(
      (p) => p.homeCenter === power && p.supplyCenter && state.supplyCenters.get(p.id) === power,
    );
    const availableCenters = homeCenters.filter((p) => !occupiedProvinces.has(p.id));

    let buildsRemaining = buildCount;
    const centersToUse = [...availableCenters];

    while (buildsRemaining > 0 && centersToUse.length > 0) {
      const idx = Math.floor(Math.random() * centersToUse.length);
      const center = centersToUse.splice(idx, 1)[0];

      if (center.type === ProvinceType.Land) {
        orders.push({ type: 'Build', unitType: UnitType.Army, province: center.id });
      } else if (center.type === ProvinceType.Coastal) {
        const unitType = Math.random() < 0.5 ? UnitType.Army : UnitType.Fleet;
        if (unitType === UnitType.Fleet && center.coasts && center.coasts.length > 0) {
          orders.push({
            type: 'Build',
            unitType: UnitType.Fleet,
            province: center.id,
            coast: pickRandom(center.coasts),
          });
        } else {
          orders.push({ type: 'Build', unitType, province: center.id });
        }
      }

      buildsRemaining--;
    }

    while (buildsRemaining > 0) {
      orders.push({ type: 'Waive' });
      buildsRemaining--;
    }
  } else if (buildCount < 0) {
    const myUnits = [...state.units.filter((u) => u.power === power)];
    let removalsRemaining = Math.abs(buildCount);

    while (removalsRemaining > 0 && myUnits.length > 0) {
      const idx = Math.floor(Math.random() * myUnits.length);
      const unit = myUnits.splice(idx, 1)[0];
      orders.push({ type: 'Remove', unit: unit.province });
      removalsRemaining--;
    }
  }

  return orders;
}

// ── Message templates ─────────────────────────────────────────────────────

const DIPLOMACY_TEMPLATES = [
  'I propose we work together this turn.',
  "Let's coordinate our moves against our mutual enemies.",
  'I have no hostile intentions toward you.',
  'Can we agree to a ceasefire?',
  "I'm planning to move east - stay out of my way.",
  "I'll support your position if you support mine.",
  "Watch out - I think you're about to be attacked.",
  "Let's form an alliance against the strongest power.",
  'I need your help. Can we talk?',
  "I'm willing to offer a non-aggression pact.",
  "Don't trust what the others are telling you.",
  "I'll leave your borders alone if you leave mine alone.",
];

const REPLY_TEMPLATES = [
  "Agreed, let's work together.",
  "I'll consider your proposal.",
  'That sounds reasonable.',
  "I'm not sure I can trust you on this.",
  'Interesting. Tell me more.',
  'I have a counter-proposal for you.',
  "Let's see how the board develops first.",
  'You have my support — for now.',
];

const ALL_POWERS = [
  Power.England,
  Power.France,
  Power.Germany,
  Power.Italy,
  Power.Austria,
  Power.Russia,
  Power.Turkey,
];

// ── connectRandomAgent ────────────────────────────────────────────────────

/**
 * Connects a random agent to a remote game server via tRPC.
 * Does not await — runs as a background task handling phases as they arrive.
 */
export async function connectRandomAgent(
  client: GameClient,
  power: Power,
  lobbyId: string,
): Promise<{ unsubscribe: () => void }> {
  // ── Serialized work queue ──────────────────────────────────────────
  const MESSAGE_BATCH_DELAY = parseInt(process.env.MESSAGE_BATCH_DELAY ?? '5000', 10);

  type WorkItem =
    | { kind: 'phase'; gameState: GameState; deadlineMs: number }
    | { kind: 'messageBatch'; messages: Message[] };

  const workQueue: WorkItem[] = [];
  let working = false;

  // ── Message batching ────────────────────────────────────────────────
  let pendingMessages: Message[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPendingMessages() {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    if (pendingMessages.length > 0) {
      const batch = pendingMessages;
      pendingMessages = [];
      logger.info(`[${power}] Flushing ${batch.length} batched messages`);
      workQueue.push({ kind: 'messageBatch', messages: batch });
    }
  }

  function enqueuePhase(gameState: GameState, deadlineMs: number) {
    flushPendingMessages();

    const staleCount = workQueue.filter((w) => w.kind === 'messageBatch').length;
    if (staleCount > 0) {
      logger.info(`[${power}] Clearing ${staleCount} stale message batches from queue`);
    }
    workQueue.length = 0;
    workQueue.push({ kind: 'phase', gameState, deadlineMs });
    drainWorkQueue();
  }

  function enqueueMessage(message: Message) {
    pendingMessages.push(message);
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flushPendingMessages();
      drainWorkQueue();
    }, MESSAGE_BATCH_DELAY);
  }

  async function drainWorkQueue() {
    if (working) return;
    working = true;
    try {
      while (workQueue.length > 0) {
        const phaseIdx = workQueue.findIndex((w) => w.kind === 'phase');
        const idx = phaseIdx >= 0 ? phaseIdx : 0;
        const item = workQueue.splice(idx, 1)[0];

        try {
          if (item.kind === 'phase') {
            await handlePhase(item.gameState, item.deadlineMs);
          } else {
            await handleMessageBatch(item.messages);
          }
        } catch (err) {
          logger.error(`[${power}] work queue error:`, err);
        }
      }
    } finally {
      working = false;
    }
  }

  // ── Phase handler ──────────────────────────────────────────────────

  const PHASE_STAGGER_MAX = parseInt(process.env.PHASE_STAGGER ?? '15000', 10);
  const agentStagger = Math.floor(Math.random() * PHASE_STAGGER_MAX);
  logger.info(`[${power}] Phase stagger: ${(agentStagger / 1000).toFixed(1)}s`);

  async function handlePhase(gameState: GameState, deadlineMs: number) {
    if (deadlineMs > 0) {
      const remaining = Math.max(0, Math.round((deadlineMs - Date.now()) / 1000));
      logger.info(`[${power}] Phase ${gameState.phase.type} -- deadline in ${remaining}s`);
    }

    if (agentStagger > 0) {
      logger.info(`[${power}] Staggering by ${(agentStagger / 1000).toFixed(1)}s`);
      await new Promise((r) => setTimeout(r, agentStagger));
    }

    try {
      if (gameState.phase.type === 'Orders') {
        logger.info(`[${power}] submitOrders`);
        const orders = generateRandomOrders(gameState, power);
        for (const o of orders) {
          logger.info(`[${power}]   order: ${JSON.stringify(o)}`);
        }
        await client.game.submitOrders.mutate({ orders });
        logger.info(`[${power}] orders submitted to server`);
      } else if (gameState.phase.type === 'Retreats') {
        const myRetreats = gameState.retreatSituations.filter((s) => s.unit.power === power);
        if (myRetreats.length > 0) {
          logger.info(`[${power}] submitRetreats (${myRetreats.length} dislodged)`);
          const retreats = generateRandomRetreats(gameState, power);
          for (const r of retreats) {
            logger.info(`[${power}]   retreat: ${JSON.stringify(r)}`);
          }
          await client.game.submitRetreats.mutate({ retreats });
          logger.info(`[${power}] retreats submitted to server`);
        }
      } else if (gameState.phase.type === 'Builds') {
        const { buildCount } = await client.game.getBuildCount.query({ lobbyId, power });
        if (buildCount !== 0) {
          logger.info(`[${power}] submitBuilds (buildCount=${buildCount})`);
          const builds = generateRandomBuilds(gameState, power, buildCount);
          for (const b of builds) {
            logger.info(`[${power}]   build: ${JSON.stringify(b)}`);
          }
          await client.game.submitBuilds.mutate({ builds });
          logger.info(`[${power}] builds submitted to server`);
        }
      }
    } catch (err) {
      logger.error(`[${power}] phase action error:`, err);
    }

    // Send random diplomacy messages (30% chance)
    if (Math.random() < 0.3) {
      try {
        const otherPowers = ALL_POWERS.filter((p) => p !== power);
        const numMessages = Math.random() < 0.5 ? 1 : 2;
        for (let i = 0; i < numMessages; i++) {
          const isGlobal = Math.random() < 0.15;
          const to = isGlobal ? 'Global' : pickRandom(otherPowers);
          const content = pickRandom(DIPLOMACY_TEMPLATES);
          await client.game.sendMessage.mutate({ to, content });
          logger.info(`[${power}] -> ${to}: ${content}`);
        }
      } catch (err) {
        logger.error(`[${power}] sendMessage error:`, err);
      }
    }

    // Signal ready
    try {
      await client.game.submitReady.mutate();
      logger.info(`[${power}] signaled ready`);
    } catch (err) {
      logger.error(`[${power}] submitReady error:`, err);
    }
  }

  // ── Message batch handler ─────────────────────────────────────────

  async function handleMessageBatch(messages: Message[]) {
    try {
      const state = await client.game.getState.query({ lobbyId });
      const serialized = state as SerializedGameState;
      if (serialized.gameOver) {
        logger.info(`[${power}] Game over detected, skipping message batch`);
        return;
      }

      // 40% chance to reply to each message
      for (const message of messages) {
        if (Math.random() < 0.6) continue;
        const content = pickRandom(REPLY_TEMPLATES);
        try {
          await client.game.sendMessage.mutate({ to: message.from, content });
          logger.info(`[${power}] -> ${message.from}: ${content}`);
        } catch (err) {
          logger.error(`[${power}] reply sendMessage error:`, err);
        }
      }
    } catch (err) {
      logger.error(`[${power}] handleMessageBatch error:`, err);
    }
  }

  // ── Subscriptions ──────────────────────────────────────────────────

  const subs: Unsubscribable[] = [];
  let lastHandledPhase = '';

  function phaseKey(gs: GameState): string {
    const p = gs.phase;
    return `${p.year}-${p.season}-${p.type}`;
  }

  const phaseSub = client.game.onPhaseChange.subscribe(
    { lobbyId },
    {
      onData(envelope) {
        const tracked = envelope as unknown as {
          id: string;
          data: { gameState: SerializedGameState; deadlineMs?: number };
        };
        if (!tracked?.data?.gameState) {
          logger.warn(`[${power}] Unexpected phase envelope shape, skipping`);
          return;
        }
        const gameState = deserializeGameState(tracked.data.gameState);
        const key = phaseKey(gameState);
        if (key === lastHandledPhase) return;
        lastHandledPhase = key;
        enqueuePhase(gameState, tracked.data.gameState.deadlineMs ?? 0);
      },
      onError(err) {
        logger.error(`[${power}] onPhaseChange subscription error:`, err);
      },
    },
  );
  subs.push(phaseSub);

  const msgSub = client.game.onMessage.subscribe(
    { lobbyId },
    {
      onData(envelope) {
        const tracked = envelope as unknown as { id: string; data: Message };
        if (!tracked?.data?.from) {
          logger.warn(`[${power}] Unexpected message envelope shape, skipping`);
          return;
        }
        const message = tracked.data;
        if (message.from === power) return;
        logger.info(`[${power}] <- ${message.from}: ${message.content}`);
        enqueueMessage(message);
      },
      onError(err) {
        logger.error(`[${power}] onMessage subscription error:`, err);
      },
    },
  );
  subs.push(msgSub);

  const unsubscribe = () => {
    for (const sub of subs) sub.unsubscribe();
    logger.info(`[${power}] Disconnected from server`);
  };

  process.on('SIGINT', () => {
    unsubscribe();
    process.exit(0);
  });

  logger.info(`[${power}] Connected to remote server, listening for phase changes`);

  // Catch up: act on the current phase if we missed the SSE event
  try {
    const currentState = await client.game.getState.query({ lobbyId });
    const serialized = currentState as SerializedGameState;
    if (serialized.gameOver) {
      logger.info(`[${power}] Game is already over, disconnecting`);
      unsubscribe();
      return { unsubscribe };
    }
    const currentGameState = deserializeGameState(serialized);
    const key = phaseKey(currentGameState);
    if (
      key !== lastHandledPhase &&
      (currentGameState.phase.type === 'Diplomacy' ||
        currentGameState.phase.type === 'Orders' ||
        currentGameState.phase.type === 'Retreats' ||
        currentGameState.phase.type === 'Builds')
    ) {
      lastHandledPhase = key;
      logger.info(`[${power}] Catching up on current phase: ${currentGameState.phase.type}`);
      enqueuePhase(currentGameState, serialized.deadlineMs);
    }
  } catch (err) {
    logger.error(`[${power}] catch-up error (non-fatal):`, err);
  }

  return { unsubscribe };
}
