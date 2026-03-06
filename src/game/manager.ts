import { PROVINCES, STARTING_SUPPLY_CENTERS, STARTING_UNITS } from '../engine/map.js';
import { ResolutionResult, resolveOrders } from '../engine/resolver.js';
import {
  BuildOrder,
  Coast,
  GameState,
  Message,
  Order,
  OrderResolution,
  OrderType,
  Phase,
  PhaseType,
  Power,
  RetreatOrder,
  Season,
} from '../engine/types.js';
import { logger } from '../util/logger.js';
import { MessageBus } from './message-bus.js';

const VICTORY_THRESHOLD = 18;
const ALL_POWERS = [
  Power.England,
  Power.France,
  Power.Germany,
  Power.Italy,
  Power.Austria,
  Power.Russia,
  Power.Turkey,
];

export interface TurnRecord {
  phase: Phase;
  orders?: OrderResolution[];
  retreats?: RetreatOrder[];
  builds?: BuildOrder[];
}

export interface GameResult {
  winner: Power | null; // null if draw
  year: number;
  supplyCenters: Map<string, Power>;
  eliminatedPowers: Power[];
}

export type GameEventType =
  | 'game_start'
  | 'phase_start'
  | 'orders_resolved'
  | 'retreats_resolved'
  | 'builds_resolved'
  | 'game_end';

export interface GameEvent {
  type: GameEventType;
  phase: Phase;
  gameState: GameState;
  turnRecord?: TurnRecord;
  result?: GameResult;
}

export type GameEventListener = (event: GameEvent) => void;
export type GameMessageListener = (message: Message) => void;
export type PhaseChangeListener = (phase: Phase, gameState: GameState) => void;

export class GameManager {
  private state: GameState;
  private turnHistory: TurnRecord[] = [];
  private eventListeners: GameEventListener[] = [];
  private phaseChangeListeners: PhaseChangeListener[] = [];
  private endYear: number;
  private phaseDelayMs: number;
  private remoteTimeoutMs: number;
  private _deadlineMs = 0; // unix timestamp when current phase's submission window closes (0 = no deadline)
  readonly bus = new MessageBus();

  // Promise gates for collecting agent submissions
  private orderGates = new Map<Power, (orders: Order[]) => void>();
  private retreatGates = new Map<Power, (retreats: RetreatOrder[]) => void>();
  private buildGates = new Map<Power, (builds: BuildOrder[]) => void>();

  constructor(maxYears = 50, phaseDelayMs = 0, remoteTimeoutMs = 0) {
    this.endYear = 1900 + maxYears;
    this.phaseDelayMs = phaseDelayMs;
    this.remoteTimeoutMs = remoteTimeoutMs;
    this.state = {
      phase: { year: 1901, season: Season.Spring, type: PhaseType.Diplomacy },
      units: STARTING_UNITS.map((u) => ({ ...u })),
      supplyCenters: new Map(STARTING_SUPPLY_CENTERS),
      orderHistory: [],
      retreatSituations: [],
    };
  }

  // ── Public API (for agents via tRPC or adapter) ──────────────────────

  getState(): GameState {
    return this.state;
  }

  getBuildCount(power: Power): number {
    const scCount = this.getSupplyCenterCount(power);
    const unitCount = this.state.units.filter((u) => u.power === power).length;
    return scCount - unitCount;
  }

  submitOrders(power: Power, orders: Order[]): void {
    const gate = this.orderGates.get(power);
    if (!gate) {
      logger.warn(`[${power}] submitOrders ignored — not expecting orders`);
      return;
    }
    gate(orders);
  }

  submitRetreats(power: Power, retreats: RetreatOrder[]): void {
    const gate = this.retreatGates.get(power);
    if (!gate) {
      logger.warn(`[${power}] submitRetreats ignored — not expecting retreats`);
      return;
    }
    gate(retreats);
  }

  submitBuilds(power: Power, builds: BuildOrder[]): void {
    const gate = this.buildGates.get(power);
    if (!gate) {
      logger.warn(`[${power}] submitBuilds ignored — not expecting builds`);
      return;
    }
    gate(builds);
  }

  sendMessage(message: Message): void {
    this.bus.send(message);
  }

  /** Unix timestamp (ms) when the current phase's submission window closes. 0 = no deadline. */
  getDeadline(): number {
    return this._deadlineMs;
  }

  // ── Event subscriptions ──────────────────────────────────────────────

  onEvent(listener: GameEventListener): void {
    this.eventListeners.push(listener);
  }

  /** Subscribe to phase changes — called when a new phase starts */
  onPhaseChange(listener: PhaseChangeListener): void {
    this.phaseChangeListeners.push(listener);
  }

  /** Subscribe to all messages flowing through the bus */
  onMessage(listener: GameMessageListener): void {
    this.bus.onMessage(listener);
  }

  getTurnHistory(): TurnRecord[] {
    return this.turnHistory;
  }

  // ── Game loop ────────────────────────────────────────────────────────

  async run(): Promise<GameResult> {
    await this.emit({
      type: 'game_start',
      phase: this.state.phase,
      gameState: this.state,
    });

    // Main game loop
    while (this.state.phase.year <= this.endYear) {
      // Spring
      await this.runDiplomacyPhase(Season.Spring);
      await this.runOrdersPhase(Season.Spring);
      const springVictory = await this.checkVictory();
      if (springVictory) return springVictory;

      // Fall
      await this.runDiplomacyPhase(Season.Fall);
      await this.runOrdersPhase(Season.Fall);

      // Update supply center ownership after Fall
      this.updateSupplyCenterOwnership();

      const fallVictory = await this.checkVictory();
      if (fallVictory) return fallVictory;

      // Winter builds
      await this.runBuildsPhase();

      // Eliminate dead powers
      this.eliminateDeadPowers();

      // Advance to next year
      this.state.phase = {
        year: this.state.phase.year + 1,
        season: Season.Spring,
        type: PhaseType.Diplomacy,
      };
    }

    // Game ended by year limit — it's a draw among surviving powers
    return {
      winner: null,
      year: this.state.phase.year,
      supplyCenters: new Map(this.state.supplyCenters),
      eliminatedPowers: this.getEliminatedPowers(),
    };
  }

  // ── Internal phase logic ─────────────────────────────────────────────

  private async startPhase(phase: Phase): Promise<void> {
    this.state.phase = phase;
    this.bus.phase = phase;

    // Set deadline for phases that require submissions
    if (
      this.remoteTimeoutMs > 0 &&
      (phase.type === PhaseType.Orders ||
        phase.type === PhaseType.Retreats ||
        phase.type === PhaseType.Builds)
    ) {
      this._deadlineMs = Date.now() + this.remoteTimeoutMs;
    } else {
      this._deadlineMs = 0;
    }

    await this.emit({
      type: 'phase_start',
      phase: this.state.phase,
      gameState: this.state,
    });

    // Notify phase change listeners (agents react to this)
    for (const listener of this.phaseChangeListeners) {
      listener(this.state.phase, this.state);
    }
  }

  private async runDiplomacyPhase(season: Season): Promise<void> {
    await this.startPhase({ year: this.state.phase.year, season, type: PhaseType.Diplomacy });

    // Diplomacy phase lasts for phaseDelay — agents can send messages during this time
    if (this.phaseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.phaseDelayMs));
    }
  }

  private async runOrdersPhase(season: Season): Promise<void> {
    await this.startPhase({ year: this.state.phase.year, season, type: PhaseType.Orders });

    // Wait for all active powers to submit orders
    const orderMap = await this.collectOrders();

    // Resolve orders
    const result = resolveOrders(this.state.units, orderMap, PROVINCES);

    // Record resolution
    const turnRecord: TurnRecord = {
      phase: { ...this.state.phase },
      orders: result.resolutions,
    };

    this.state.orderHistory.push(result.resolutions);

    await this.emit({
      type: 'orders_resolved',
      phase: this.state.phase,
      gameState: this.state,
      turnRecord,
    });

    // Handle retreats if any
    if (result.dislodgedUnits.length > 0) {
      await this.runRetreatsPhase(season, result);
    } else {
      this.state.units = result.newPositions;
      this.state.retreatSituations = [];
    }

    this.turnHistory.push(turnRecord);
  }

  private async runRetreatsPhase(
    season: Season,
    resolutionResult: ResolutionResult,
  ): Promise<void> {
    this.state.retreatSituations = resolutionResult.dislodgedUnits;
    await this.startPhase({ year: this.state.phase.year, season, type: PhaseType.Retreats });

    // Wait for affected powers to submit retreats
    const allRetreatOrders = await this.collectRetreats(resolutionResult);

    // Process retreat orders
    const newPositions = [...resolutionResult.newPositions];
    const retreatDestinations = new Map<string, RetreatOrder[]>();

    for (const order of allRetreatOrders) {
      if (order.type === 'RetreatMove') {
        const existing = retreatDestinations.get(order.destination) ?? [];
        existing.push(order);
        retreatDestinations.set(order.destination, existing);
      }
    }

    for (const [, orders] of retreatDestinations) {
      if (orders.length === 1) {
        const order = orders[0] as {
          type: 'RetreatMove';
          unit: string;
          destination: string;
          coast?: Coast;
        };
        const dislodgedInfo = resolutionResult.dislodgedUnits.find(
          (d) => d.unit.province === order.unit,
        );
        if (dislodgedInfo) {
          newPositions.push({
            ...dislodgedInfo.unit,
            province: order.destination,
            coast: order.coast,
          });
        }
      }
    }

    this.state.units = newPositions;
    this.state.retreatSituations = [];

    const turnRecord: TurnRecord = {
      phase: { ...this.state.phase },
      retreats: allRetreatOrders,
    };

    await this.emit({
      type: 'retreats_resolved',
      phase: this.state.phase,
      gameState: this.state,
      turnRecord,
    });

    this.turnHistory.push(turnRecord);
  }

  private async runBuildsPhase(): Promise<void> {
    await this.startPhase({
      year: this.state.phase.year,
      season: Season.Fall,
      type: PhaseType.Builds,
    });

    // Wait for powers that need to build/disband to submit
    const allBuildOrders = await this.collectBuilds();

    const turnRecord: TurnRecord = {
      phase: { ...this.state.phase },
      builds: allBuildOrders,
    };

    await this.emit({
      type: 'builds_resolved',
      phase: this.state.phase,
      gameState: this.state,
      turnRecord,
    });

    this.turnHistory.push(turnRecord);
  }

  // ── Promise-gate collectors ──────────────────────────────────────────

  /** Wraps a promise with an optional timeout. Returns true if timed out. */
  private withTimeout(promise: Promise<void>, power: Power, label: string): Promise<boolean> {
    if (this.remoteTimeoutMs <= 0) return promise.then(() => false);
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      promise.then(() => {
        clearTimeout(timer);
        return false;
      }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(
            `[${power}] ${label} timed out after ${this.remoteTimeoutMs}ms — using defaults`,
          );
          resolve(true);
        }, this.remoteTimeoutMs);
      }),
    ]);
  }

  private async collectOrders(): Promise<Map<string, Order>> {
    const activePowers = this.getActivePowers();
    const orderMap = new Map<string, Order>();

    const promises = activePowers.map(async (power) => {
      const gate = new Promise<void>((resolve) => {
        this.orderGates.set(power, (orders) => {
          logger.info(`[${power}] submitted ${orders.length} orders`);
          for (const order of orders) {
            const unit = this.state.units.find(
              (u) => u.province === order.unit && u.power === power,
            );
            if (unit) {
              orderMap.set(order.unit, order);
            }
          }
          this.orderGates.delete(power);
          resolve();
        });
      });

      const timedOut = await this.withTimeout(gate, power, 'orders');
      if (timedOut) {
        this.orderGates.delete(power);
        // Default: Hold all units
        for (const unit of this.state.units) {
          if (unit.power === power && !orderMap.has(unit.province)) {
            orderMap.set(unit.province, { type: OrderType.Hold, unit: unit.province });
          }
        }
      }
    });

    await Promise.all(promises);
    return orderMap;
  }

  private async collectRetreats(resolutionResult: ResolutionResult): Promise<RetreatOrder[]> {
    const affectedPowers = new Set(resolutionResult.dislodgedUnits.map((d) => d.unit.power));
    const allRetreatOrders: RetreatOrder[] = [];

    const promises = [...affectedPowers].map(async (power) => {
      const gate = new Promise<void>((resolve) => {
        this.retreatGates.set(power, (retreats) => {
          logger.info(`[${power}] submitted ${retreats.length} retreat orders`);
          allRetreatOrders.push(...retreats);
          this.retreatGates.delete(power);
          resolve();
        });
      });

      const timedOut = await this.withTimeout(gate, power, 'retreats');
      if (timedOut) {
        this.retreatGates.delete(power);
        // Default: Disband all dislodged units
        for (const situation of resolutionResult.dislodgedUnits) {
          if (situation.unit.power === power) {
            allRetreatOrders.push({ type: 'Disband', unit: situation.unit.province });
          }
        }
      }
    });

    await Promise.all(promises);
    return allRetreatOrders;
  }

  private async collectBuilds(): Promise<BuildOrder[]> {
    const activePowers = this.getActivePowers();
    const allBuildOrders: BuildOrder[] = [];

    const powersNeedingAction = activePowers.filter((power) => {
      return this.getBuildCount(power) !== 0;
    });

    const promises = powersNeedingAction.map(async (power) => {
      const buildCount = this.getBuildCount(power);
      const gate = new Promise<void>((resolve) => {
        this.buildGates.set(power, (builds) => {
          logger.info(`[${power}] submitted ${builds.length} build orders`);
          allBuildOrders.push(...builds);
          this.processBuildOrders(power, builds, buildCount);
          this.buildGates.delete(power);
          resolve();
        });
      });

      const timedOut = await this.withTimeout(gate, power, 'builds');
      if (timedOut) {
        this.buildGates.delete(power);
        if (buildCount > 0) {
          // Default: Waive all builds
          for (let i = 0; i < buildCount; i++) {
            allBuildOrders.push({ type: 'Waive' });
          }
        } else {
          // Default: Remove units from the end
          const myUnits = this.state.units.filter((u) => u.power === power);
          const removals = Math.min(Math.abs(buildCount), myUnits.length);
          for (let i = 0; i < removals; i++) {
            const unit = myUnits[myUnits.length - 1 - i];
            allBuildOrders.push({ type: 'Remove', unit: unit.province });
          }
          this.processBuildOrders(
            power,
            allBuildOrders.filter((o) => o.type === 'Remove'),
            buildCount,
          );
        }
      }
    });

    await Promise.all(promises);
    return allBuildOrders;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async emit(event: GameEvent): Promise<void> {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private updateSupplyCenterOwnership(): void {
    for (const unit of this.state.units) {
      const province = PROVINCES[unit.province];
      if (province && province.supplyCenter) {
        this.state.supplyCenters.set(unit.province, unit.power);
      }
    }
  }

  private processBuildOrders(power: Power, orders: BuildOrder[], buildCount: number): void {
    if (buildCount > 0) {
      let buildsPlaced = 0;
      for (const order of orders) {
        if (buildsPlaced >= buildCount) break;
        if (order.type === 'Build') {
          const province = PROVINCES[order.province];
          if (!province) continue;
          if (province.homeCenter !== power) continue;
          if (!province.supplyCenter) continue;
          if (this.state.units.some((u) => u.province === order.province)) continue;
          if (this.state.supplyCenters.get(order.province) !== power) continue;

          this.state.units.push({
            type: order.unitType,
            power,
            province: order.province,
            coast: order.coast,
          });
          buildsPlaced++;
        } else if (order.type === 'Waive') {
          buildsPlaced++;
        }
      }
    } else if (buildCount < 0) {
      let removalsNeeded = Math.abs(buildCount);
      for (const order of orders) {
        if (removalsNeeded <= 0) break;
        if (order.type === 'Remove') {
          const idx = this.state.units.findIndex(
            (u) => u.province === order.unit && u.power === power,
          );
          if (idx !== -1) {
            this.state.units.splice(idx, 1);
            removalsNeeded--;
          }
        }
      }
      while (removalsNeeded > 0) {
        let idx = -1;
        for (let i = this.state.units.length - 1; i >= 0; i--) {
          if (this.state.units[i].power === power) {
            idx = i;
            break;
          }
        }
        if (idx === -1) break;
        this.state.units.splice(idx, 1);
        removalsNeeded--;
      }
    }
  }

  private getSupplyCenterCount(power: Power): number {
    let count = 0;
    for (const [, owner] of this.state.supplyCenters) {
      if (owner === power) count++;
    }
    return count;
  }

  getActivePowers(): Power[] {
    const powersWithUnits = new Set(this.state.units.map((u) => u.power));
    return ALL_POWERS.filter((p) => powersWithUnits.has(p));
  }

  private getEliminatedPowers(): Power[] {
    const active = new Set(this.getActivePowers());
    return ALL_POWERS.filter((p) => !active.has(p));
  }

  private eliminateDeadPowers(): void {
    // Powers with no units AND no supply centers are eliminated
  }

  private async checkVictory(): Promise<GameResult | null> {
    for (const power of ALL_POWERS) {
      const scCount = this.getSupplyCenterCount(power);
      if (scCount >= VICTORY_THRESHOLD) {
        const result: GameResult = {
          winner: power,
          year: this.state.phase.year,
          supplyCenters: new Map(this.state.supplyCenters),
          eliminatedPowers: this.getEliminatedPowers(),
        };

        await this.emit({
          type: 'game_end',
          phase: this.state.phase,
          gameState: this.state,
          result,
        });

        return result;
      }
    }
    return null;
  }
}
