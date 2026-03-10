# Lobby Auth: Anti-Impersonation Hardening

**Issue:** #12
**Branch:** `feat/lobby-auth` (off `nathanheller/harden-lobbies`)
**Date:** 2026-03-10

## Problem

The lobby and game systems have zero authentication. Player identity is entirely self-declared via the `power` field in request payloads. This enables:

1. **Order spoofing** — Anyone with a `lobbyId` can submit orders for any power
2. **Press forgery** — `sendMessage` accepts a caller-supplied `from` field
3. **Message eavesdropping** — `onMessage` subscription filtering is client-controlled
4. **Lobby hijacking** — No owner concept; anyone can start or delete any lobby

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Threat model | Untrusted network | Will be hosted publicly |
| Seat claiming | Explicit `lobby.join` → bearer token | Clean lifecycle, natural API |
| Creator auth | Creator token from `lobby.create` | Host ownership without complexity |
| Autostart | Lobby config option; starts on last join | Reduces friction |
| Token lifetime | Lives for lobby lifetime; kick/revoke for compromise | Bounded entity, no refresh needed |
| Spectators | No auth; private press filtered server-side | Read-only, orders revealed on resolution |
| Auth pattern | tRPC context middleware | Idiomatic, centralized, server-authoritative |

## Token Model

Two token types, both `crypto.randomUUID()` (128-bit, opaque):

- **Creator token** — returned from `lobby.create`, authorizes lobby management
- **Seat token** — returned from `lobby.join(lobbyId, power)`, authorizes game actions for that power

Tokens stored in-memory in the `Lobby` object:

```ts
// autostart added to LobbyConfig and lobbyConfigSchema
interface LobbyConfig {
  // ...existing fields...
  autostart?: boolean; // default false
}

interface Lobby {
  id: string;
  config: LobbyConfig;
  status: 'waiting' | 'playing' | 'finished';
  creatorToken: string;
  seats: Map<Power, string>; // power → seatToken
  manager: GameManager | null;
}
```

Tokens are garbage collected when the lobby is deleted or finished.

### LobbyManager Methods

```ts
// Returns { lobbyId, creatorToken }
createLobby(config: LobbyConfig): { lobbyId: string; creatorToken: string }

// Claims a seat. Lobby must be 'waiting', power must be unclaimed.
// If config.autostart && all 7 seats filled → triggers startLobby().
// Returns { seatToken }
joinLobby(lobbyId: string, power: Power): { seatToken: string }

// Reconnect during 'playing' status. Requires the OLD seat token as proof
// of prior ownership. Invalidates old token, issues fresh one.
// Input: { lobbyId, power, oldToken }
rejoinLobby(lobbyId: string, power: Power, oldToken: string): { seatToken: string }

// Removes seat and invalidates token. Only in 'waiting' status.
kickPlayer(lobbyId: string, power: Power): void

// Resolves a token to its identity. Returns null if invalid.
validateToken(token: string): { lobbyId: string; power: Power } | { lobbyId: string; role: 'creator' } | null
```

## tRPC Auth Layer

### Context

`createContext({ req })` extracts `Authorization: Bearer <token>` from request headers. For WebSocket/SSE, reads from `?token=` query param. Returns `{ token: string | null }`.

`initTRPC.context<Context>().create()` in `trpc.ts` types the context.

### Procedure Levels

| Procedure | Guards | Context provides |
|-----------|--------|-----------------|
| `publicProcedure` | None | `{ token: null }` |
| `playerProcedure` | Token resolves to a seat | `{ power, lobbyId }` |
| `creatorProcedure` | Token resolves to a creator | `{ lobbyId }` |

### Key Change

For `playerProcedure` and `creatorProcedure` endpoints, `power` and `lobbyId` are **derived from the token context** — removed from mutation inputs. Specifically:

- `submitOrders`, `submitRetreats`, `submitBuilds`, `sendMessage` — `power` and `lobbyId` removed from input, derived from `ctx`
- Public queries (`getState`, `getPhase`, `getBuildCount`, `getActivePowers`) — **retain `lobbyId` and `power` in input** since spectators have no token
- `onPhaseChange` — public, retains `lobbyId` input
- `onMessage` — stays `publicProcedure` with server-side filtering (see Subscriptions below)

### Subscriptions

`onMessage` remains a `publicProcedure` so spectators can subscribe. Filtering logic:

- **With valid seat token** → receives messages where `to === ctx.power` or `to === undefined` (broadcast)
- **Without token (spectator)** → receives only `to === undefined` (broadcast messages)

The `power` input field is removed; filtering is derived from the token in context (if present).

## Lobby Lifecycle

### Mutations

- **`lobby.create`** — Public. Returns `{ lobbyId, creatorToken }`. Creator sets config including `autostart: boolean`.
- **`lobby.join`** — Public. Input: `{ lobbyId, power }`. Returns `{ seatToken }`. Lobby must be `waiting`, power must not be claimed. If autostart enabled and last seat claimed, triggers `startLobby()` automatically.
- **`lobby.start`** — `creatorProcedure`. Manual start (can start with unfilled seats).
- **`lobby.delete`** — `creatorProcedure`. Blocked during `playing`.
- **`lobby.kick`** — `creatorProcedure`. Input: `{ power }`. Removes seat, invalidates token. Only in `waiting` status.
- **`lobby.rejoin`** — Public. Input: `{ lobbyId, power, oldToken }`. For `playing` status only. Requires the **old seat token** as proof of prior ownership — prevents seat theft. Invalidates old token, issues fresh one. Concurrent rejoin calls: first-write-wins (same as join).

### Status Flow

```
waiting (seats filling) → playing (game active) → finished (game over)
         ↑ kick removes a seat
```

## Endpoint Auth Matrix

| Endpoint | Auth | Rationale |
|----------|------|-----------|
| `lobby.list`, `lobby.get` | Public | Discovery |
| `lobby.create` | Public | Anyone can host |
| `lobby.join` | Public | Returns seat token |
| `lobby.rejoin` | Public (requires old token in body) | Re-issues seat token |
| `lobby.start`, `lobby.delete`, `lobby.kick` | Creator | Lobby ownership |
| `game.getState`, `game.getPhase` | Public | Spectating |
| `game.submitOrders/Retreats/Builds` | Player | Core anti-impersonation |
| `game.sendMessage` | Player | Press integrity |
| `onPhaseChange` | Public | Spectating |
| `onMessage` | Public (token-based filtering) | Press privacy |
| WebSocket `/ws/:lobbyId` | Public (filtered) | Spectating |

## Remote Agent & CLI Changes

Agent startup becomes two-step:

1. **Join** — `POST lobby.join({ lobbyId, power })` → receives `seatToken`
2. **Play** — All tRPC calls include `Authorization: Bearer <seatToken>` header

`run.ts`: `--power` and `--lobby` flags remain. Token is ephemeral (in-memory only).

`client.ts`: tRPC client factory gains `token` param. `httpLink` uses `Authorization` header. For `httpSubscriptionLink`, since the `eventsource` npm package (v4) does not support custom headers, the token is appended as a `?token=` query parameter on the SSE URL. This requires configuring `httpSubscriptionLink` with a custom `url` function that appends the token, or wrapping EventSource construction.

`remote-adapter.ts`: `power` removed from mutation payloads. Adapter still knows its power locally for order generation.

## Spectator UI & WebSocket

- No auth required for spectators
- WebSocket broadcasts: each WS connection tracks its auth state (power or spectator) established at upgrade time via `?token=` query param. The `broadcastToLobby` function filters press per-connection: authenticated connections see their private press; unauthenticated see only broadcast messages (`to === undefined`).
- Frontend client unchanged (no token sent)

### Autostart Transactionality

`startLobby()` must set `status = 'playing'` **after** successful `_onStart` callback, not before. If `_onStart` throws, the lobby remains in `waiting` status and the error is returned to the joining player who triggered autostart.

## Error Handling

| Scenario | Response |
|----------|----------|
| Missing token on protected endpoint | `UNAUTHORIZED` — "Authentication required" |
| Invalid/expired token | `UNAUTHORIZED` — "Invalid token" |
| Token valid but wrong lobby | `FORBIDDEN` — "Token not valid for this lobby" |
| Two agents claim same power | `CONFLICT` — first write wins |
| Join during `playing`/`finished` | `BAD_REQUEST` — "Lobby not accepting players" |
| Autostart fails on last join | Lobby reverts to `waiting`, error to joining player |
| Kicked player's old token | Immediately invalidated; must rejoin |
| Agent reconnect mid-game | Uses `lobby.rejoin`, old token invalidated |

## Files to Modify

- `src/game/trpc.ts` — Add `createContext`, `playerProcedure`, `creatorProcedure`
- `src/game/lobby-manager.ts` — Add `seats`, `creatorToken`, `autostart`, join/kick/rejoin/validate methods
- `src/game/lobby-router.ts` — Add `join`, `kick`, `rejoin` mutations; guard `start`/`delete` with creator auth
- `src/game/router.ts` — Switch game mutations to `playerProcedure`; remove `power`/`from` from inputs; use `ctx.power`
- `src/ui/server.ts` — Pass `createContext` to `createExpressMiddleware({ router, createContext })`; track per-WS-connection auth state at upgrade time via `?token=` query param; filter press in broadcast
- `src/agent/remote/client.ts` — Accept token param; add auth headers
- `src/agent/remote/run.ts` — Add join step before play loop
- `src/agent/remote/remote-adapter.ts` — Remove power from mutation payloads
