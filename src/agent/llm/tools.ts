import { PROVINCES } from '../../engine/map';
import { Coast, GameState, OrderType, Power, UnitType } from '../../engine/types';
import { logger } from '../../util/logger';
import type { ToolDefinition, ToolExecutor } from './llm-client';

export interface ToolGameClient {
  game: {
    submitOrders: { mutate: (input: { orders: unknown[] }) => Promise<{ ok: boolean }> };
    submitRetreats: { mutate: (input: { retreats: unknown[] }) => Promise<{ ok: boolean }> };
    submitBuilds: { mutate: (input: { builds: unknown[] }) => Promise<{ ok: boolean }> };
    sendMessage: {
      mutate: (input: { to: string | string[]; content: string }) => Promise<{ ok: boolean }>;
    };
    testOrders: {
      query: (input: { orders: unknown[] }) => Promise<unknown>;
    };
  };
}

interface FlatOrder {
  unit: string;
  type: string;
  destination?: string;
  coast?: string;
  viaConvoy?: boolean;
  supportedUnit?: string;
  convoyedUnit?: string;
}

interface FlatRetreat {
  unit: string;
  destination?: string;
  coast?: string;
}

interface FlatBuild {
  type: string;
  unitType?: string;
  province?: string;
  coast?: string;
}

export class GameToolExecutor implements ToolExecutor {
  hasSubmitted = false;

  constructor(
    private client: ToolGameClient,
    private gameState: GameState,
    private power: Power,
  ) {}

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const argsStr = Object.keys(args).length > 0 ? ` ${JSON.stringify(args)}` : '';
    logger.debug(`[${this.power}] tool:${name}${argsStr}`);

    let result: string;
    switch (name) {
      case 'getMyUnits':
        result = this.getMyUnits();
        break;
      case 'getAdjacentProvinces':
        result = this.getAdjacentProvinces(args);
        break;
      case 'getProvinceInfo':
        result = this.getProvinceInfo(args);
        break;
      case 'getSupplyCenterCounts':
        result = this.getSupplyCenterCounts();
        break;
      case 'getPhaseInfo':
        result = this.getPhaseInfo();
        break;
      case 'getRetreatOptions':
        result = this.getRetreatOptions();
        break;
      case 'submitOrders':
        result = await this.submitOrders(args);
        break;
      case 'submitRetreats':
        result = await this.submitRetreats(args);
        break;
      case 'submitBuilds':
        result = await this.submitBuilds(args);
        break;
      case 'sendMessage':
        result = await this.sendMessage(args);
        break;
      case 'testOrders':
        result = await this.testOrders(args);
        break;
      default:
        result = JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    // Log submission results and messages at info level, query results at debug
    const isAction = ['submitOrders', 'submitRetreats', 'submitBuilds', 'sendMessage'].includes(
      name,
    );
    if (isAction) {
      logger.info(`[${this.power}] tool:${name} => ${result}`);
    } else {
      logger.debug(
        `[${this.power}] tool:${name} => ${result.length > 200 ? result.slice(0, 200) + '...' : result}`,
      );
    }

    return result;
  }

  private getMyUnits(): string {
    const units = this.gameState.units
      .filter((u) => u.power === this.power)
      .map((u) => ({
        unit: u.province,
        type: u.type,
        ...(u.coast !== undefined ? { coast: u.coast } : {}),
      }));
    return JSON.stringify(units);
  }

  private getAdjacentProvinces(args: Record<string, unknown>): string {
    const province = args.province as string;
    const unitType = args.unitType as string | undefined;
    const coast = args.coast as Coast | undefined;

    const prov = PROVINCES[province];
    if (!prov) {
      return JSON.stringify({ error: `Unknown province: ${province}` });
    }

    let adjacent: string[];

    if (unitType === 'Army') {
      adjacent = [...prov.adjacency.army];
    } else if (unitType === 'Fleet') {
      if (coast && prov.adjacency.fleetByCoast?.[coast]) {
        adjacent = [...prov.adjacency.fleetByCoast[coast]];
      } else if (prov.adjacency.fleetByCoast && !coast) {
        // Multi-coast province without coast specified — list coasts available
        return JSON.stringify({
          error: `Province ${province} has multiple coasts. Specify coast parameter.`,
          availableCoasts: Object.keys(prov.adjacency.fleetByCoast),
        });
      } else {
        adjacent = [...(prov.adjacency.fleet ?? [])];
      }
    } else {
      // No unitType — return union of army and fleet
      const armySet = new Set(prov.adjacency.army);
      const fleetAdj = [...(prov.adjacency.fleet ?? [])];
      const combined = new Set([...armySet, ...fleetAdj]);
      adjacent = Array.from(combined);
    }

    return JSON.stringify(adjacent);
  }

  private getProvinceInfo(args: Record<string, unknown>): string {
    const province = args.province as string;
    const prov = PROVINCES[province];
    if (!prov) {
      return JSON.stringify({ error: `Unknown province: ${province}` });
    }

    const owner = this.gameState.supplyCenters.get(province) ?? null;
    const unit = this.gameState.units.find((u) => u.province === province) ?? null;

    return JSON.stringify({
      name: prov.name,
      type: prov.type,
      supplyCenter: prov.supplyCenter,
      homeCenter: prov.homeCenter ?? null,
      owner,
      unit,
      coasts: prov.coasts ?? null,
    });
  }

  private getSupplyCenterCounts(): string {
    const counts: Record<string, number> = {
      England: 0,
      France: 0,
      Germany: 0,
      Italy: 0,
      Austria: 0,
      Russia: 0,
      Turkey: 0,
      neutral: 0,
    };

    for (const [province, prov] of Object.entries(PROVINCES)) {
      if (!prov.supplyCenter) continue;
      const owner = this.gameState.supplyCenters.get(province);
      if (owner) {
        counts[owner] = (counts[owner] ?? 0) + 1;
      } else {
        counts.neutral += 1;
      }
    }

    return JSON.stringify(counts);
  }

  private getPhaseInfo(): string {
    const { phase, endYear } = this.gameState;
    return JSON.stringify({
      season: phase.season,
      year: phase.year,
      type: phase.type,
      endYear,
    });
  }

  private getRetreatOptions(): string {
    const options = this.gameState.retreatSituations
      .filter((s) => s.unit.power === this.power)
      .map((s) => ({
        unit: s.unit,
        attackedFrom: s.attackedFrom,
        validDestinations: s.validDestinations,
      }));
    return JSON.stringify(options);
  }

  private async submitOrders(args: Record<string, unknown>): Promise<string> {
    if (!Array.isArray(args.orders)) {
      return JSON.stringify({ error: 'orders must be an array' });
    }
    const rawOrders = args.orders as FlatOrder[];
    const validTypes = new Set<string>([
      OrderType.Hold,
      OrderType.Move,
      OrderType.Support,
      OrderType.Convoy,
    ]);

    for (const order of rawOrders) {
      if (!validTypes.has(order.type)) {
        return JSON.stringify({ error: `Invalid order type: ${order.type}` });
      }
    }

    const orders = rawOrders.map((o) => {
      switch (o.type) {
        case OrderType.Hold:
          return { type: OrderType.Hold, unit: o.unit };
        case OrderType.Move:
          return {
            type: OrderType.Move,
            unit: o.unit,
            destination: o.destination as string,
            ...(o.coast ? { coast: o.coast } : {}),
            ...(o.viaConvoy ? { viaConvoy: o.viaConvoy } : {}),
          };
        case OrderType.Support:
          return {
            type: OrderType.Support,
            unit: o.unit,
            supportedUnit: o.supportedUnit as string,
            ...(o.destination ? { destination: o.destination } : {}),
          };
        case OrderType.Convoy:
          return {
            type: OrderType.Convoy,
            unit: o.unit,
            convoyedUnit: o.convoyedUnit as string,
            destination: o.destination as string,
          };
        default:
          return o;
      }
    });

    for (const o of orders) {
      logger.info(`[${this.power}]   order: ${JSON.stringify(o)}`);
    }

    try {
      const result = await this.client.game.submitOrders.mutate({ orders });
      this.hasSubmitted = true;
      return JSON.stringify(result);
    } catch (e) {
      return this.formatError(e);
    }
  }

  private async submitRetreats(args: Record<string, unknown>): Promise<string> {
    if (!Array.isArray(args.retreats)) {
      return JSON.stringify({ error: 'retreats must be an array' });
    }
    const rawRetreats = args.retreats as FlatRetreat[];

    const retreats = rawRetreats.map((r) => {
      if (r.destination) {
        return {
          type: 'RetreatMove' as const,
          unit: r.unit,
          destination: r.destination,
          ...(r.coast ? { coast: r.coast } : {}),
        };
      } else {
        return { type: 'Disband' as const, unit: r.unit };
      }
    });

    try {
      const result = await this.client.game.submitRetreats.mutate({ retreats });
      this.hasSubmitted = true;
      return JSON.stringify(result);
    } catch (e) {
      return this.formatError(e);
    }
  }

  private async submitBuilds(args: Record<string, unknown>): Promise<string> {
    if (!Array.isArray(args.builds)) {
      return JSON.stringify({ error: 'builds must be an array' });
    }
    const rawBuilds = args.builds as FlatBuild[];

    try {
      const result = await this.client.game.submitBuilds.mutate({ builds: rawBuilds });
      this.hasSubmitted = true;
      return JSON.stringify(result);
    } catch (e) {
      return this.formatError(e);
    }
  }

  private async sendMessage(args: Record<string, unknown>): Promise<string> {
    if (typeof args.content !== 'string') {
      return JSON.stringify({ error: 'content must be a string' });
    }
    if (typeof args.to !== 'string' && !Array.isArray(args.to)) {
      return JSON.stringify({ error: 'to must be a string or array of strings' });
    }
    const to = args.to as string | string[];
    const content = args.content;
    const toStr = Array.isArray(to) ? to.join(', ') : to;
    logger.info(`[${this.power}] -> ${toStr}: ${content}`);

    try {
      const result = await this.client.game.sendMessage.mutate({ to, content });
      return JSON.stringify(result);
    } catch (e) {
      return this.formatError(e);
    }
  }

  private async testOrders(args: Record<string, unknown>): Promise<string> {
    if (!Array.isArray(args.orders)) {
      return JSON.stringify({ error: 'orders must be an array' });
    }
    try {
      const result = await this.client.game.testOrders.query({ orders: args.orders });
      return JSON.stringify(result);
    } catch (e) {
      return this.formatError(e);
    }
  }

  /** Extract structured error from TRPCError or fall back to string representation. */
  private formatError(e: unknown): string {
    if (e instanceof Error && e.message) {
      try {
        const parsed = JSON.parse(e.message) as Record<string, unknown>;
        return JSON.stringify({ error: 'Request failed', ...parsed });
      } catch {
        // message wasn't JSON — use it directly
        return JSON.stringify({ error: e.message });
      }
    }
    return JSON.stringify({ error: String(e) });
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'getMyUnits',
      description:
        'Get all your units. Returns [{unit: "lon", type: "Fleet"}, ...] — use the "unit" field as the province ID in submitOrders.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getAdjacentProvinces',
      description:
        'Get provinces adjacent to (reachable from) a given province, optionally filtered by unit type.',
      parameters: {
        type: 'object',
        properties: {
          province: {
            type: 'string',
            description: 'The province ID to get adjacencies for (e.g. "lon", "par")',
          },
          unitType: {
            type: 'string',
            enum: ['Army', 'Fleet'],
            description:
              'Filter adjacencies by unit type. If omitted, returns union of army and fleet adjacencies.',
          },
          coast: {
            type: 'string',
            enum: ['nc', 'sc'],
            description:
              'Coast for multi-coast provinces (spa, stp, bul). Required for Fleet on these provinces.',
          },
        },
        required: ['province'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getProvinceInfo',
      description:
        'Get detailed information about a province including type, supply center status, owner, and current unit.',
      parameters: {
        type: 'object',
        properties: {
          province: {
            type: 'string',
            description: 'The province ID (e.g. "lon", "par")',
          },
        },
        required: ['province'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSupplyCenterCounts',
      description: 'Get the number of supply centers owned by each power plus neutral count.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getPhaseInfo',
      description: 'Get information about the current game phase.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getRetreatOptions',
      description: 'Get retreat options for all dislodged units belonging to your power.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submitOrders',
      description: 'Submit movement orders for your units during the Orders phase.',
      parameters: {
        type: 'object',
        properties: {
          orders: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                unit: { type: 'string', description: 'Province ID where the unit is located' },
                type: {
                  type: 'string',
                  enum: ['Hold', 'Move', 'Support', 'Convoy'],
                  description: 'Order type',
                },
                destination: {
                  type: 'string',
                  description: 'Destination province ID (for Move, Convoy)',
                },
                coast: { type: 'string', description: 'Coast for fleet moves (nc or sc)' },
                viaConvoy: { type: 'boolean', description: 'Whether to move via convoy' },
                supportedUnit: {
                  type: 'string',
                  description: 'Province of unit being supported (for Support)',
                },
                convoyedUnit: {
                  type: 'string',
                  description: 'Province of army being convoyed (for Convoy)',
                },
              },
              required: ['unit', 'type'],
            },
          },
        },
        required: ['orders'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submitRetreats',
      description:
        'Submit retreat or disband orders for dislodged units during the Retreats phase.',
      parameters: {
        type: 'object',
        properties: {
          retreats: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                unit: { type: 'string', description: 'Province ID of the dislodged unit' },
                destination: {
                  type: 'string',
                  description: 'Province to retreat to. Omit to disband the unit.',
                },
                coast: { type: 'string', description: 'Coast for fleet retreat (nc or sc)' },
              },
              required: ['unit'],
            },
          },
        },
        required: ['retreats'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submitBuilds',
      description: 'Submit build, remove, or waive orders during the Builds phase.',
      parameters: {
        type: 'object',
        properties: {
          builds: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['Build', 'Remove', 'Waive'],
                  description: 'Build order type',
                },
                unitType: {
                  type: 'string',
                  enum: ['Army', 'Fleet'],
                  description: 'Type of unit to build (for Build)',
                },
                province: {
                  type: 'string',
                  description:
                    'Province to build in (must be an unoccupied HOME supply center) or remove from',
                },
                coast: { type: 'string', description: 'Coast for fleet build (nc or sc)' },
              },
              required: ['type'],
            },
          },
        },
        required: ['builds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sendMessage',
      description: 'Send a diplomatic message to one or more powers.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            oneOf: [
              {
                type: 'string',
                enum: ['eng', 'fra', 'ger', 'ita', 'aus', 'rus', 'tur', 'Global'],
                description:
                  'Single recipient: a power abbreviation (eng, fra, ger, ita, aus, rus, tur) or "Global" for all',
              },
              {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['eng', 'fra', 'ger', 'ita', 'aus', 'rus', 'tur'],
                },
                description: 'List of power abbreviations to send to',
              },
            ],
            description:
              'Recipient(s): use power abbreviations (eng, fra, ger, ita, aus, rus, tur) or "Global"',
          },
          content: { type: 'string', description: 'Message content' },
        },
        required: ['to', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'testOrders',
      description:
        'Simulate order or retreat resolution without submitting. Test what would happen if specific orders were issued. Pass "orders" for movement phase, "retreats" for retreat phase.',
      parameters: {
        type: 'object',
        properties: {
          orders: {
            type: 'array',
            description:
              'Movement orders to simulate. Include your orders and hypothetical orders for other powers. Units without orders Hold.',
            items: {
              type: 'object',
              properties: {
                unit: { type: 'string', description: 'Province ID where the unit is' },
                type: {
                  type: 'string',
                  enum: ['Hold', 'Move', 'Support', 'Convoy'],
                },
                destination: { type: 'string', description: 'Destination province ID' },
                supportedUnit: { type: 'string', description: 'Province of supported unit' },
                convoyedUnit: { type: 'string', description: 'Province of convoyed army' },
                coast: { type: 'string', description: 'Coast (nc or sc)' },
                viaConvoy: { type: 'boolean' },
              },
              required: ['unit', 'type'],
            },
          },
          retreats: {
            type: 'array',
            description:
              'Retreat orders to simulate. Test for collisions (two retreats to the same province = both disbanded).',
            items: {
              type: 'object',
              properties: {
                unit: { type: 'string', description: 'Province ID of dislodged unit' },
                destination: {
                  type: 'string',
                  description: 'Province to retreat to. Omit to disband.',
                },
                coast: { type: 'string', description: 'Coast (nc or sc)' },
              },
              required: ['unit'],
            },
          },
        },
      },
    },
  },
];

// Re-export UnitType to make it available from this module
export { UnitType };
