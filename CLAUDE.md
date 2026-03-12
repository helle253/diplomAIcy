# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
yarn build            # tsc + vite build
yarn test             # vitest run (all tests)
yarn test -- src/engine/resolver.test.ts   # run a single test file
yarn test -- -t "convoy"                   # run tests matching a name pattern
yarn test:watch       # vitest in watch mode
yarn test:e2e         # vite build + playwright tests (screenshot comparisons)
yarn test:e2e:update  # update e2e screenshot snapshots
yarn lint             # eslint src/
yarn format           # prettier --write src/
yarn dev              # concurrent tsc --watch + vite dev server + node --watch
yarn start            # production build + run server on port 3000
```

## Architecture

This is an agent-oriented Diplomacy game engine where AI agents play against each other, with a read-only browser spectator UI.

### Core Layers

**Engine** (`src/engine/`) — Pure game logic, no I/O. Types, map data (75 provinces, 34 supply centers), and order resolution algorithm. `map-state.ts` provides derived state helpers (build counts, unit lookups). All types live in `types.ts`.

**Agents** (`src/agent/`) — Pluggable agent implementations behind the `DiplomacyAgent` interface (`interface.ts`). Agents implement `onPhaseStart`, `submitOrders`, `submitRetreats`, `submitBuilds`, and message handlers. `adapter.ts` bridges agents to GameManager events. Implementations: `random.ts` (testing), `llm/` (LLM-powered via OpenAI-compatible or Anthropic APIs), `remote/` (tRPC client for out-of-process agents).

**Game** (`src/game/`) — Orchestration layer. `GameManager` runs the game loop using a **promise-gate pattern**: it creates a promise per power and `await`s all submissions, making it fully agent-agnostic. `MessageBus` handles inter-agent press (stamp, store, emit). `router.ts` exposes the tRPC API. `storage.ts` persists to SQLite (better-sqlite3, WAL mode). `lobby-manager.ts` handles pre-game lobby state.

**UI** (`src/ui/`) — `server.ts` runs Express + WebSocket + tRPC on a single port. `client/` is a Vite + Tailwind v4 frontend (HTML/JS/CSS, no framework).

### Key Patterns

- **ESM with `.js` extensions** — all imports use `.js` even for `.ts` source files (Node16 module resolution)
- **Promise-gate pattern** — GameManager creates a deferred promise per power, resolves it when that power submits; phase advances when all resolve
- **tRPC for agent API** — queries (`getState`, `getPhase`), mutations (`submitOrders`, `submitRetreats`, `submitBuilds`, `sendMessage`), SSE subscriptions (`onPhaseChange`, `onMessage`)
- **Supply centers as `Map<string, Power>`** — serialized as `Record<string, Power>` over the wire, deserialized back to `Map` in `remote/deserialize.ts`
- **Press is always open** — agents can send messages during any phase, stamped with the current phase

## Code Conventions

- TypeScript strict mode, ES2022 target, `declaration: false` (needed for tRPC compatibility)
- `@typescript-eslint/no-explicit-any: error` — no `any` types
- Sorted imports enforced by `eslint-plugin-simple-import-sort`
- Unused imports are errors (`eslint-plugin-unused-imports`)
- Single quotes (prettier config)
- Use `yarn` (not npm)

## Running Games

```bash
yarn play:random                           # random agents, no API key needed
yarn play:llm                              # LLM agents (needs .env with API key)
yarn play:mixed                            # different models per power (see diplomaicy.config.mixed.json)
yarn start:remote                          # server expecting remote agent connections
yarn agent -- --power England --type llm   # connect a single remote agent
```

## Environment Variables

`PORT`, `MAX_YEARS`, `PHASE_DELAY`, `REMOTE_TIMEOUT`, `DB_PATH`, `ANTHROPIC_API_KEY` — see README.md for full list. Server loads from `.env` via `--env-file`.
