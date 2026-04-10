import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import { PhaseType, Power, Season, UnitType } from '../../engine/types';
import { GameToolExecutor, type ToolGameClient } from './tools';

type MockToolGameClient = {
  game: {
    [K in keyof ToolGameClient['game']]: K extends 'testOrders'
      ? { query: Mock }
      : { mutate: Mock };
  };
};

function makeState(overrides = {}) {
  return {
    phase: { season: Season.Spring, year: 1901, type: PhaseType.Orders },
    units: [
      { type: UnitType.Fleet, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'edi' },
      { type: UnitType.Army, power: Power.England, province: 'lvp' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
    ],
    supplyCenters: new Map([
      ['lon', Power.England],
      ['edi', Power.England],
      ['lvp', Power.England],
      ['par', Power.France],
      ['bre', Power.France],
      ['mar', Power.France],
    ]),
    orderHistory: [],
    retreatSituations: [],
    endYear: 1910,
    ...overrides,
  };
}

const mockClient = {} as ToolGameClient;

describe('GameToolExecutor - map query tools', () => {
  it("getMyUnits returns only this power's units", async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getMyUnits', {}));
    expect(result).toHaveLength(3);
    expect(result.map((u: { unit: string }) => u.unit).sort()).toEqual(['edi', 'lon', 'lvp']);
  });

  it('getAdjacentProvinces returns army adjacencies', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(
      await exec.execute('getAdjacentProvinces', {
        province: 'lon',
        unitType: 'Army',
      }),
    );
    expect(result).toContain('wal');
    expect(result).toContain('yor');
    expect(result).not.toContain('nth');
  });

  it('getAdjacentProvinces returns fleet adjacencies', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(
      await exec.execute('getAdjacentProvinces', {
        province: 'lon',
        unitType: 'Fleet',
      }),
    );
    expect(result).toContain('nth');
    expect(result).toContain('eng');
    expect(result).toContain('wal');
    expect(result).toContain('yor');
  });

  it('getAdjacentProvinces returns error for invalid province', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getAdjacentProvinces', { province: 'xyz' }));
    expect(result.error).toContain('xyz');
  });

  it('getProvinceInfo returns full province data', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getProvinceInfo', { province: 'lon' }));
    expect(result.name).toBe('London');
    expect(result.type).toBe('Coastal');
    expect(result.supplyCenter).toBe(true);
    expect(result.owner).toBe('England');
    expect(result.unit).toMatchObject({ type: 'Fleet', power: 'England' });
  });

  it('getSupplyCenterCounts returns per-power counts', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getSupplyCenterCounts', {}));
    expect(result.England).toBe(3);
    expect(result.France).toBe(3);
    expect(result.neutral).toBeGreaterThan(0);
  });

  it('getPhaseInfo returns phase details', async () => {
    const exec = new GameToolExecutor(mockClient, makeState(), Power.England);
    const result = JSON.parse(await exec.execute('getPhaseInfo', {}));
    expect(result.season).toBe('Spring');
    expect(result.year).toBe(1901);
    expect(result.type).toBe('Orders');
    expect(result.endYear).toBe(1910);
  });

  it('getRetreatOptions returns dislodged units for this power', async () => {
    const state = makeState({
      retreatSituations: [
        {
          unit: { type: UnitType.Army, power: Power.England, province: 'lon' },
          attackedFrom: 'wal',
          validDestinations: ['yor'],
        },
        {
          unit: { type: UnitType.Army, power: Power.France, province: 'par' },
          attackedFrom: 'bur',
          validDestinations: ['pic', 'gas'],
        },
      ],
    });
    const exec = new GameToolExecutor(mockClient, state, Power.England);
    const result = JSON.parse(await exec.execute('getRetreatOptions', {}));
    expect(result).toHaveLength(1);
    expect(result[0].unit.province).toBe('lon');
    expect(result[0].validDestinations).toEqual(['yor']);
  });
});

describe('GameToolExecutor - action tools', () => {
  function makeMockClient(): MockToolGameClient {
    return {
      game: {
        submitOrders: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        submitRetreats: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        submitBuilds: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        sendMessage: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        testOrders: { query: vi.fn().mockResolvedValue({ resolutions: [] }) },
      },
    } as MockToolGameClient;
  }

  it('submitOrders calls tRPC mutation with converted orders', async () => {
    const client = makeMockClient();
    const exec = new GameToolExecutor(client, makeState(), Power.England);
    const result = JSON.parse(
      await exec.execute('submitOrders', {
        orders: [
          { unit: 'lon', type: 'Hold' },
          { unit: 'edi', type: 'Move', destination: 'nth' },
          { unit: 'lvp', type: 'Move', destination: 'yor' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(client.game.submitOrders.mutate).toHaveBeenCalledOnce();
  });

  it('submitOrders returns error for invalid order type', async () => {
    const client = makeMockClient();
    const exec = new GameToolExecutor(client, makeState(), Power.England);
    const result = JSON.parse(
      await exec.execute('submitOrders', {
        orders: [{ unit: 'lon', type: 'InvalidType' }],
      }),
    );
    expect(result.error).toBeDefined();
  });

  it('sendMessage calls tRPC mutation', async () => {
    const client = makeMockClient();
    const exec = new GameToolExecutor(client, makeState(), Power.England);
    const result = JSON.parse(
      await exec.execute('sendMessage', {
        to: 'France',
        content: 'Shall we ally?',
      }),
    );
    expect(result.ok).toBe(true);
    expect(client.game.sendMessage.mutate).toHaveBeenCalledWith({
      to: 'France',
      content: 'Shall we ally?',
    });
  });

  it('submitRetreats converts to proper discriminated union', async () => {
    const client = makeMockClient();
    const state = makeState({
      retreatSituations: [
        {
          unit: { type: UnitType.Army, power: Power.England, province: 'lon' },
          attackedFrom: 'wal',
          validDestinations: ['yor'],
        },
      ],
    });
    const exec = new GameToolExecutor(client, state, Power.England);
    const result = JSON.parse(
      await exec.execute('submitRetreats', {
        retreats: [{ unit: 'lon', destination: 'yor' }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(client.game.submitRetreats.mutate).toHaveBeenCalledOnce();
  });

  it('submitRetreats converts missing destination to Disband', async () => {
    const client = makeMockClient();
    const state = makeState({
      retreatSituations: [
        {
          unit: { type: UnitType.Fleet, power: Power.England, province: 'lon' },
          attackedFrom: 'wal',
          validDestinations: ['yor'],
        },
      ],
    });
    const exec = new GameToolExecutor(client, state, Power.England);
    const result = JSON.parse(
      await exec.execute('submitRetreats', {
        retreats: [{ unit: 'lon' }],
      }),
    );
    expect(result.ok).toBe(true);
    const args = client.game.submitRetreats.mutate.mock.calls[0][0];
    expect(args.retreats[0].type).toBe('Disband');
  });

  it('submitOrders accepts non-adjacent move (engine resolves as hold)', async () => {
    const client = makeMockClient();
    const exec = new GameToolExecutor(client, makeState(), Power.England);
    const result = JSON.parse(
      await exec.execute('submitOrders', {
        orders: [{ unit: 'lon', type: 'Move', destination: 'nor' }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(client.game.submitOrders.mutate).toHaveBeenCalledOnce();
  });

  it('hasSubmitted stays false when server rejects orders', async () => {
    const client = makeMockClient();
    client.game.submitOrders.mutate.mockRejectedValueOnce(new Error('BAD_REQUEST'));
    const exec = new GameToolExecutor(client, makeState(), Power.England);
    const result = JSON.parse(
      await exec.execute('submitOrders', {
        orders: [{ unit: 'par', type: 'Hold' }],
      }),
    );
    expect(result.error).toBeDefined();
    expect(exec.hasSubmitted).toBe(false);
  });
});
