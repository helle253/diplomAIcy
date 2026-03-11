// === Powers ===

export enum Power {
  England = 'England',
  France = 'France',
  Germany = 'Germany',
  Italy = 'Italy',
  Austria = 'Austria',
  Russia = 'Russia',
  Turkey = 'Turkey',
}

// === Geography ===

export enum ProvinceType {
  Land = 'Land',
  Sea = 'Sea',
  Coastal = 'Coastal',
}

export enum Coast {
  North = 'nc',
  South = 'sc',
}

export interface Province {
  id: string;
  name: string;
  type: ProvinceType;
  supplyCenter: boolean;
  homeCenter?: Power;
  coasts?: Coast[];
  adjacency: {
    army: string[];
    fleet: string[];
    // For provinces with multiple coasts, keyed by coast id
    fleetByCoast?: Partial<Record<Coast, string[]>>;
  };
}

// === Units ===

export enum UnitType {
  Army = 'Army',
  Fleet = 'Fleet',
}

export interface Unit {
  type: UnitType;
  power: Power;
  province: string;
  coast?: Coast;
}

// === Orders ===

export enum OrderType {
  Hold = 'Hold',
  Move = 'Move',
  Support = 'Support',
  Convoy = 'Convoy',
}

export interface HoldOrder {
  type: OrderType.Hold;
  unit: string; // province id where unit is
}

export interface MoveOrder {
  type: OrderType.Move;
  unit: string;
  destination: string;
  coast?: Coast;
  viaConvoy?: boolean;
}

export interface SupportOrder {
  type: OrderType.Support;
  unit: string;
  supportedUnit: string;
  // If destination is omitted, it's a support-hold
  destination?: string;
}

export interface ConvoyOrder {
  type: OrderType.Convoy;
  unit: string; // fleet doing the convoying
  convoyedUnit: string; // army being convoyed
  destination: string;
}

export type Order = HoldOrder | MoveOrder | SupportOrder | ConvoyOrder;

// === Retreat Orders ===

export interface RetreatMove {
  type: 'RetreatMove';
  unit: string;
  destination: string;
  coast?: Coast;
}

export interface Disband {
  type: 'Disband';
  unit: string;
}

export type RetreatOrder = RetreatMove | Disband;

// === Build Orders ===

export interface Build {
  type: 'Build';
  unitType: UnitType;
  province: string;
  coast?: Coast;
}

export interface Remove {
  type: 'Remove';
  unit: string;
}

export interface Waive {
  type: 'Waive';
}

export type BuildOrder = Build | Remove | Waive;

// === Retreat Situation ===

export interface RetreatSituation {
  unit: Unit;
  attackedFrom: string;
  validDestinations: string[];
}

// === Phases ===

export enum Season {
  Spring = 'Spring',
  Fall = 'Fall',
}

export enum PhaseType {
  Diplomacy = 'Diplomacy',
  Orders = 'Orders',
  Retreats = 'Retreats',
  Builds = 'Builds',
}

export interface Phase {
  year: number;
  season: Season;
  type: PhaseType;
}

// === Resolution ===

export enum OrderStatus {
  Succeeds = 'Succeeds',
  Fails = 'Fails',
  Invalid = 'Invalid',
}

export interface OrderResolution {
  order: Order;
  power: Power;
  status: OrderStatus;
  reason?: string;
}

// === Game State ===

export interface GameState {
  phase: Phase;
  units: Unit[];
  supplyCenters: Map<string, Power>; // province id -> owning power
  orderHistory: OrderResolution[][];
  retreatSituations: RetreatSituation[];
  endYear: number; // final year of the game (e.g. 1901 for a 1-year game)
}

// === Province State (wire format) ===

export interface ProvinceState {
  type: ProvinceType;
  supplyCenter: boolean;
  homeCenter: Power | null;
  adjacent: string[];
  coasts: Record<string, string[]> | null;
  owner: Power | null;
  unit: { type: UnitType; power: Power; coast: string | null } | null;
}

// === Messages (for negotiation) ===

export interface Message {
  id?: string;
  gameId?: string;
  from: Power;
  to: Power | Power[] | 'Global';
  content: string;
  phase: Phase;
  timestamp: number;
}
