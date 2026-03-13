import { PROVINCES, STARTING_SUPPLY_CENTERS, STARTING_UNITS } from '../engine/map';
import { ResolutionResult, resolveOrders } from '../engine/resolver';
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
} from '../engine/types';
import { logger } from '../util/logger';
import { MessageBus } from './message-bus';

export interface GameManagerConfig {
  maxYears?: number;
  victoryThreshold?: number;
  startYear?: number;
  phaseDelayMs?: number;
  remoteTimeoutMs?: number;
  pressDelayMin?: number;
  pressDelayMax?: number;
  fastAdjudication?: boolean;
  allowDraws?: boolean;
}

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
  concededPowers: Power[];
}

export type GameEventType =
  | 'game_start'
  | 'phase_start'
  | 'orders_resolved'
  | 'retreats_resolved'
  | 'builds_resolved'
  | 'game_end'
  | 'concede';

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
  private startYear: number;
  private endYear: number;
  private phaseDelayMs: number;
  private remoteTimeoutMs: number;
  private victoryThreshold: number;
  private _deadlineMs = 0; // unix timestamp when current phase's submission window closes (0 = no deadline)
  private allowDraws: boolean;
  private drawVotes = new Set<Power>();
  private drawResolve: (() => void) | null = null;
  private concededPowers = new Set<Power>();
  readonly bus: MessageBus;

  // Promise gates for collecting agent submissions
  private orderGates = new Map<Power, (orders: Order[]) => void>();
  private retreatGates = new Map<Power, (retreats: RetreatOrder[]) => void>();
  private buildGates = new Map<Power, (builds: BuildOrder[]) => void>();
  private readyGates = new Map<Power, () => void>();
  private fastAdjudication: boolean;

  constructor(config: GameManagerConfig = {}) {
    const {
      maxYears = 50,
      phaseDelayMs = 0,
      remoteTimeoutMs = 0,
      pressDelayMin = 0,
      pressDelayMax = 0,
      victoryThreshold = 18,
      startYear = 1901,
      fastAdjudication = true,
      allowDraws = true,
    } = config;
    this.bus = new MessageBus({ pressDelayMin, pressDelayMax });
    this.startYear = startYear;
    this.endYear = startYear - 1 + maxYears;
    this.phaseDelayMs = phaseDelayMs;
    this.remoteTimeoutMs = remoteTimeoutMs;
    this.victoryThreshold = victoryThreshold;
    this.fastAdjudication = fastAdjudication;
    this.allowDraws = allowDraws;
    this.state = {
      phase: { year: startYear, season: Season.Spring, type: PhaseType.Diplomacy },
      units: STARTING_UNITS.map((u) => ({ ...u })),
      supplyCenters: new Map(STARTING_SUPPLY_CENTERS),
      orderHistory: [],
      retreatSituations: [],
      endYear: this.endYear,
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

  submitReady(power: Power): void {
    const gate = this.readyGates.get(power);
    if (!gate) {
      logger.warn(`[${power}] submitReady ignored — not expecting ready signal`);
      return;
    }
    gate();
  }

  sendMessage(message: Message): void {
    this.bus.send(message);
  }

  /** Unix timestamp (ms) when the current phase's submission window closes. 0 = no deadline. */
  getDeadline(): number {
    return this._deadlineMs;
  }

  proposeDraw(power: Power): boolean {
    if (!this.allowDraws) {
      logger.warn(`[${power}] draw proposal rejected — draws are disabled`);
      return false;
    }
    this.drawVotes.add(power);
    const activePowers = this.getActivePowers();
    logger.info(`[${power}] proposed a draw (${this.drawVotes.size}/${activePowers.length} votes)`);

    // Broadcast draw proposal as a global message
    this.bus.send({
      from: power,
      to: 'Global',
      content: `${power} proposes a draw (${this.drawVotes.size}/${activePowers.length} votes).`,
      phase: this.state.phase,
      timestamp: Date.now(),
    });

    if (activePowers.every((p) => this.drawVotes.has(p))) {
      if (this.drawResolve) this.drawResolve();
    }
    return true;
  }

  getDrawVotes(): Power[] {
    return [...this.drawVotes];
  }

  concede(power: Power): boolean {
    if (this.concededPowers.has(power)) {
      logger.warn(`[${power}] already conceded`);
      return false;
    }
    if (!this.getActivePowers().includes(power)) {
      logger.warn(`[${power}] cannot concede — not an active power`);
      return false;
    }

    this.concededPowers.add(power);
    logger.info(`[${power}] has conceded`);

    // Broadcast concession as a global message (bus.phase may not be set if
    // concede is called before the game loop starts, so set it first)
    if (!this.bus.currentPhase) this.bus.phase = this.state.phase;
    this.bus.send({
      from: power,
      to: 'Global',
      content: `${power} has conceded.`,
      phase: this.state.phase,
      timestamp: Date.now(),
    });

    // Resolve any pending gates immediately with civil-disorder defaults
    this.resolveGatesForConcession(power);

    return true;
  }

  getConcededPowers(): Power[] {
    return [...this.concededPowers];
  }

  /** Player-facing game configuration for rules templating. */
  getGameConfig() {
    return {
      victoryThreshold: this.victoryThreshold,
      startYear: this.startYear,
      endYear: this.endYear,
      phaseDeadlineMs: this.remoteTimeoutMs,
      fastAdjudication: this.fastAdjudication,
      allowDraws: this.allowDraws,
    };
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

  /** Get all messages (for spectators/public view) */
  getMessages(): Message[] {
    return this.bus.getMessages();
  }

  /** Get messages visible to a specific power (includes private messages to them) */
  getMessagesFor(power: Power): Message[] {
    return this.bus.getMessagesFor(power);
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
      const springDraw = this.checkDrawVote();
      if (springDraw) {
        await this.emit({
          type: 'game_end',
          phase: this.state.phase,
          gameState: this.state,
          result: springDraw,
        });
        return springDraw;
      }
      await this.runOrdersPhase(Season.Spring);
      const springVictory = await this.checkVictory();
      if (springVictory) return springVictory;

      // Fall
      await this.runDiplomacyPhase(Season.Fall);
      const fallDraw = this.checkDrawVote();
      if (fallDraw) {
        await this.emit({
          type: 'game_end',
          phase: this.state.phase,
          gameState: this.state,
          result: fallDraw,
        });
        return fallDraw;
      }
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
      concededPowers: this.getConcededPowers(),
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
    this.drawVotes.clear();
    this.drawResolve = null;

    if (this.phaseDelayMs > 0 && this.fastAdjudication) {
      // Set up ready gates before startPhase so that phase change listeners
      // (which fire during startPhase) can resolve them immediately.
      const activePowers = this.getActivePowers();
      let readyCount = 0;
      let resolveAllReady: () => void;
      const allReady = new Promise<void>((resolve) => {
        resolveAllReady = resolve;
      });

      for (const power of activePowers) {
        this.readyGates.set(power, () => {
          this.readyGates.delete(power);
          readyCount++;
          if (readyCount >= activePowers.length) {
            resolveAllReady();
          }
        });
      }

      await this.startPhase({ year: this.state.phase.year, season, type: PhaseType.Diplomacy });

      const drawPromise = new Promise<void>((resolve) => {
        this.drawResolve = resolve;
      });

      await Promise.race([
        allReady,
        drawPromise,
        new Promise<void>((resolve) => setTimeout(resolve, this.phaseDelayMs)),
      ]);

      this.readyGates.clear();
    } else {
      await this.startPhase({ year: this.state.phase.year, season, type: PhaseType.Diplomacy });

      if (this.phaseDelayMs > 0) {
        const drawPromise = new Promise<void>((resolve) => {
          this.drawResolve = resolve;
        });
        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, this.phaseDelayMs)),
          drawPromise,
        ]);
      }
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

  private resolveGatesForConcession(power: Power): void {
    const orderGate = this.orderGates.get(power);
    if (orderGate) {
      orderGate(
        this.state.units
          .filter((u) => u.power === power)
          .map((u) => ({ type: OrderType.Hold, unit: u.province })),
      );
    }

    const retreatGate = this.retreatGates.get(power);
    if (retreatGate) {
      retreatGate(
        this.state.retreatSituations
          .filter((s) => s.unit.power === power)
          .map((s) => ({ type: 'Disband' as const, unit: s.unit.province })),
      );
    }

    const buildGate = this.buildGates.get(power);
    if (buildGate) {
      const buildCount = this.getBuildCount(power);
      if (buildCount > 0) {
        buildGate(Array.from({ length: buildCount }, () => ({ type: 'Waive' as const })));
      } else if (buildCount < 0) {
        const myUnits = this.state.units.filter((u) => u.power === power);
        const removals = Math.min(Math.abs(buildCount), myUnits.length);
        buildGate(
          myUnits.slice(-removals).map((u) => ({ type: 'Remove' as const, unit: u.province })),
        );
      } else {
        buildGate([]);
      }
    }

    const readyGate = this.readyGates.get(power);
    if (readyGate) readyGate();
  }

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
    return ALL_POWERS.filter((p) => powersWithUnits.has(p) && !this.concededPowers.has(p));
  }

  private getEliminatedPowers(): Power[] {
    const active = new Set(this.getActivePowers());
    return ALL_POWERS.filter((p) => !active.has(p) && !this.concededPowers.has(p));
  }

  private eliminateDeadPowers(): void {
    // Powers with no units AND no supply centers are eliminated
  }

  private checkDrawVote(): GameResult | null {
    if (!this.allowDraws) return null;
    const activePowers = this.getActivePowers();
    if (activePowers.length > 0 && activePowers.every((p) => this.drawVotes.has(p))) {
      return {
        winner: null,
        year: this.state.phase.year,
        supplyCenters: new Map(this.state.supplyCenters),
        eliminatedPowers: this.getEliminatedPowers(),
        concededPowers: this.getConcededPowers(),
      };
    }
    return null;
  }

  private async checkVictory(): Promise<GameResult | null> {
    for (const power of ALL_POWERS) {
      const scCount = this.getSupplyCenterCount(power);
      if (scCount >= this.victoryThreshold) {
        const result: GameResult = {
          winner: power,
          year: this.state.phase.year,
          supplyCenters: new Map(this.state.supplyCenters),
          eliminatedPowers: this.getEliminatedPowers(),
          concededPowers: this.getConcededPowers(),
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
