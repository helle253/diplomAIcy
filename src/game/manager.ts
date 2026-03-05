import {
  Power,
  GameState,
  Unit,
  Season,
  PhaseType,
  Phase,
  Order,
  OrderType,
  Message,
  RetreatOrder,
  BuildOrder,
  OrderResolution,
  Coast,
} from '../engine/types.js';
import { PROVINCES, STARTING_UNITS, STARTING_SUPPLY_CENTERS } from '../engine/map.js';
import { resolveOrders, ResolutionResult } from '../engine/resolver.js';
import { DiplomacyAgent } from '../agent/interface.js';

const VICTORY_THRESHOLD = 18;
const ALL_POWERS = [
  Power.England, Power.France, Power.Germany, Power.Italy,
  Power.Austria, Power.Russia, Power.Turkey,
];

export interface TurnRecord {
  phase: Phase;
  orders?: OrderResolution[];
  retreats?: RetreatOrder[];
  builds?: BuildOrder[];
  messages?: Message[];
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

export class GameManager {
  private agents: Map<Power, DiplomacyAgent> = new Map();
  private state: GameState;
  private turnHistory: TurnRecord[] = [];
  private listeners: GameEventListener[] = [];
  private endYear: number;

  constructor(maxYears = 50) {
    this.endYear = 1900 + maxYears;
    this.state = {
      phase: { year: 1901, season: Season.Spring, type: PhaseType.Diplomacy },
      units: STARTING_UNITS.map(u => ({ ...u })),
      supplyCenters: new Map(STARTING_SUPPLY_CENTERS),
      orderHistory: [],
      retreatSituations: [],
    };
  }

  registerAgent(agent: DiplomacyAgent): void {
    this.agents.set(agent.power, agent);
  }

  onEvent(listener: GameEventListener): void {
    this.listeners.push(listener);
  }

  getState(): GameState {
    return this.state;
  }

  getTurnHistory(): TurnRecord[] {
    return this.turnHistory;
  }

  private emit(event: GameEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async run(): Promise<GameResult> {
    // Verify all 7 powers have agents
    for (const power of ALL_POWERS) {
      if (!this.agents.has(power)) {
        throw new Error(`No agent registered for ${power}`);
      }
    }

    // Initialize all agents
    await Promise.all(
      ALL_POWERS.map(p => this.agents.get(p)!.initialize(this.state))
    );

    this.emit({
      type: 'game_start',
      phase: this.state.phase,
      gameState: this.state,
    });

    // Main game loop
    while (this.state.phase.year <= this.endYear) {
      // Spring
      await this.runDiplomacyPhase(Season.Spring);
      await this.runOrdersPhase(Season.Spring);
      const springVictory = this.checkVictory();
      if (springVictory) return springVictory;

      // Fall
      await this.runDiplomacyPhase(Season.Fall);
      await this.runOrdersPhase(Season.Fall);

      // Update supply center ownership after Fall
      this.updateSupplyCenterOwnership();

      const fallVictory = this.checkVictory();
      if (fallVictory) return fallVictory;

      // Winter builds
      await this.runBuildsPhase();

      // Eliminate powers with no units and no supply centers
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

  private async runDiplomacyPhase(season: Season): Promise<void> {
    this.state.phase = { year: this.state.phase.year, season, type: PhaseType.Diplomacy };

    this.emit({
      type: 'phase_start',
      phase: this.state.phase,
      gameState: this.state,
    });

    // Collect messages from all agents
    const allMessages: Message[] = [];
    const activePowers = this.getActivePowers();

    // Run multiple negotiation rounds
    const NEGOTIATION_ROUNDS = 3;
    for (let round = 0; round < NEGOTIATION_ROUNDS; round++) {
      const roundMessages: Message[] = [];
      await Promise.all(
        activePowers.map(async (power) => {
          const agent = this.agents.get(power)!;
          // Filter messages visible to this power
          const incoming = allMessages.filter(
            m => m.to === power || m.to === 'Global'
          );
          const newMessages = await agent.negotiate(this.state, incoming);
          // Stamp messages with metadata
          for (const msg of newMessages) {
            msg.phase = { ...this.state.phase };
            msg.timestamp = Date.now();
          }
          roundMessages.push(...newMessages);
        })
      );
      allMessages.push(...roundMessages);
    }

    this.turnHistory.push({
      phase: { ...this.state.phase },
      messages: allMessages,
    });
  }

  private async runOrdersPhase(season: Season): Promise<void> {
    this.state.phase = { year: this.state.phase.year, season, type: PhaseType.Orders };

    this.emit({
      type: 'phase_start',
      phase: this.state.phase,
      gameState: this.state,
    });

    // Collect orders from all active powers
    const orderMap = new Map<string, Order>();
    const activePowers = this.getActivePowers();

    await Promise.all(
      activePowers.map(async (power) => {
        const agent = this.agents.get(power)!;
        const orders = await agent.submitOrders(this.state);
        for (const order of orders) {
          // Verify the order is for this power's unit
          const unit = this.state.units.find(
            u => u.province === order.unit && u.power === power
          );
          if (unit) {
            orderMap.set(order.unit, order);
          }
        }
      })
    );

    // Resolve orders
    const result = resolveOrders(this.state.units, orderMap, PROVINCES);

    // Record resolution
    const turnRecord: TurnRecord = {
      phase: { ...this.state.phase },
      orders: result.resolutions,
    };

    this.state.orderHistory.push(result.resolutions);

    this.emit({
      type: 'orders_resolved',
      phase: this.state.phase,
      gameState: this.state,
      turnRecord,
    });

    // Handle retreats if any
    if (result.dislodgedUnits.length > 0) {
      await this.runRetreatsPhase(season, result);
    } else {
      // No retreats needed — just update positions
      this.state.units = result.newPositions;
      this.state.retreatSituations = [];
    }

    this.turnHistory.push(turnRecord);
  }

  private async runRetreatsPhase(
    season: Season,
    resolutionResult: ResolutionResult
  ): Promise<void> {
    this.state.phase = { year: this.state.phase.year, season, type: PhaseType.Retreats };
    this.state.retreatSituations = resolutionResult.dislodgedUnits;

    this.emit({
      type: 'phase_start',
      phase: this.state.phase,
      gameState: this.state,
    });

    // Collect retreat orders from affected powers
    const allRetreatOrders: RetreatOrder[] = [];
    const affectedPowers = new Set(
      resolutionResult.dislodgedUnits.map(d => d.unit.power)
    );

    await Promise.all(
      [...affectedPowers].map(async (power) => {
        const agent = this.agents.get(power)!;
        const retreatOrders = await agent.submitRetreats(
          this.state,
          resolutionResult.dislodgedUnits
        );
        allRetreatOrders.push(...retreatOrders);
      })
    );

    // Process retreat orders
    const newPositions = [...resolutionResult.newPositions];
    const retreatDestinations = new Map<string, RetreatOrder[]>();

    // Group retreats by destination to detect conflicts
    for (const order of allRetreatOrders) {
      if (order.type === 'RetreatMove') {
        const existing = retreatDestinations.get(order.destination) ?? [];
        existing.push(order);
        retreatDestinations.set(order.destination, existing);
      }
      // Disbands are handled by simply not adding the unit
    }

    // Resolve retreat conflicts (two units retreating to same province = both destroyed)
    for (const [dest, orders] of retreatDestinations) {
      if (orders.length === 1) {
        const order = orders[0] as { type: 'RetreatMove'; unit: string; destination: string; coast?: Coast };
        const dislodgedInfo = resolutionResult.dislodgedUnits.find(
          d => d.unit.province === order.unit
        );
        if (dislodgedInfo) {
          newPositions.push({
            ...dislodgedInfo.unit,
            province: order.destination,
            coast: order.coast,
          });
        }
      }
      // If multiple units retreat to same province, all are destroyed (not added)
    }

    this.state.units = newPositions;
    this.state.retreatSituations = [];

    const turnRecord: TurnRecord = {
      phase: { ...this.state.phase },
      retreats: allRetreatOrders,
    };

    this.emit({
      type: 'retreats_resolved',
      phase: this.state.phase,
      gameState: this.state,
      turnRecord,
    });

    this.turnHistory.push(turnRecord);
  }

  private updateSupplyCenterOwnership(): void {
    // After Fall moves, any supply center with a unit on it changes ownership
    for (const unit of this.state.units) {
      const province = PROVINCES[unit.province];
      if (province && province.supplyCenter) {
        this.state.supplyCenters.set(unit.province, unit.power);
      }
    }
  }

  private async runBuildsPhase(): Promise<void> {
    this.state.phase = {
      year: this.state.phase.year,
      season: Season.Fall,
      type: PhaseType.Builds,
    };

    this.emit({
      type: 'phase_start',
      phase: this.state.phase,
      gameState: this.state,
    });

    const allBuildOrders: BuildOrder[] = [];
    const activePowers = this.getActivePowers();

    await Promise.all(
      activePowers.map(async (power) => {
        const scCount = this.getSupplyCenterCount(power);
        const unitCount = this.state.units.filter(u => u.power === power).length;
        const buildCount = scCount - unitCount;

        if (buildCount === 0) return;

        const agent = this.agents.get(power)!;
        const buildOrders = await agent.submitBuilds(this.state, buildCount);
        allBuildOrders.push(...buildOrders);

        // Process build orders
        this.processBuildOrders(power, buildOrders, buildCount);
      })
    );

    const turnRecord: TurnRecord = {
      phase: { ...this.state.phase },
      builds: allBuildOrders,
    };

    this.emit({
      type: 'builds_resolved',
      phase: this.state.phase,
      gameState: this.state,
      turnRecord,
    });

    this.turnHistory.push(turnRecord);
  }

  private processBuildOrders(power: Power, orders: BuildOrder[], buildCount: number): void {
    if (buildCount > 0) {
      // Building new units
      let buildsPlaced = 0;
      for (const order of orders) {
        if (buildsPlaced >= buildCount) break;
        if (order.type === 'Build') {
          const province = PROVINCES[order.province];
          if (!province) continue;
          // Must be an unoccupied home supply center
          if (province.homeCenter !== power) continue;
          if (!province.supplyCenter) continue;
          if (this.state.units.some(u => u.province === order.province)) continue;
          // Must own the supply center
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
      // Must remove units
      let removalsNeeded = Math.abs(buildCount);
      for (const order of orders) {
        if (removalsNeeded <= 0) break;
        if (order.type === 'Remove') {
          const idx = this.state.units.findIndex(
            u => u.province === order.unit && u.power === power
          );
          if (idx !== -1) {
            this.state.units.splice(idx, 1);
            removalsNeeded--;
          }
        }
      }
      // If agent didn't remove enough, force-remove from the end
      while (removalsNeeded > 0) {
        let idx = -1;
        for (let i = this.state.units.length - 1; i >= 0; i--) {
          if (this.state.units[i].power === power) { idx = i; break; }
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

  private getActivePowers(): Power[] {
    const powersWithUnits = new Set(this.state.units.map(u => u.power));
    return ALL_POWERS.filter(p => powersWithUnits.has(p));
  }

  private getEliminatedPowers(): Power[] {
    const active = new Set(this.getActivePowers());
    return ALL_POWERS.filter(p => !active.has(p));
  }

  private eliminateDeadPowers(): void {
    // Powers with no units AND no supply centers are eliminated
    // (Powers with supply centers but no units might still build in winter)
    // This is called after winter builds, so any power with SCs should have had a chance to build
  }

  private checkVictory(): GameResult | null {
    for (const power of ALL_POWERS) {
      const scCount = this.getSupplyCenterCount(power);
      if (scCount >= VICTORY_THRESHOLD) {
        const result: GameResult = {
          winner: power,
          year: this.state.phase.year,
          supplyCenters: new Map(this.state.supplyCenters),
          eliminatedPowers: this.getEliminatedPowers(),
        };

        this.emit({
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
