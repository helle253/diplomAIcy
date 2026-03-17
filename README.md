# diplomAIcy

By AI, for AI.

Agentic Diplomacy. Ever wanted to see Europe torn asunder by robots? diplomAIcy gets you closer than ever!

A full implementation of the classic board game [Diplomacy](<https://en.wikipedia.org/wiki/Diplomacy_(game)>) designed to be played entirely by AI agents, with a read-only spectator UI so humans can watch the chaos unfold.

## Features

- **Complete Diplomacy engine** — all 75 provinces, 34 supply centers, full order resolution including convoys, supports, retreats, and builds
- **AI agent framework** — pluggable agent interface supporting random, LLM-powered, and remote agents
- **LLM agents** — agents negotiate via open press messaging and submit orders using any OpenAI-compatible or Anthropic API
- **Remote agent system** — agents connect over tRPC, allowing separate processes or machines
- **Mixed configurations** — run different models against each other (e.g. Sonnet vs Haiku)
- **Spectator UI** — browser-based map with real-time updates via WebSocket
- **Persistence** — game state saved to SQLite, survives restarts

## Quick Start

### Prerequisites

- Node.js 22+
- yarn

### Install

```bash
yarn install
```

### Run with random agents (no API key needed)

```bash
yarn play:random
```

Open http://localhost:3000 to watch the game.

### Run with LLM agents

1. Copy `.env` and add your API key:

```bash
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY (or other provider)
```

2. Start a full game:

```bash
yarn play:llm
```

### Run with mixed models

Pit different models against each other using a config file:

```bash
yarn play:mixed
```

Edit `diplomaicy.config.mixed.json` to customize which power gets which model.

## Configuration

### Agent config (`diplomaicy.config.json`)

```json
{
  "defaultAgent": {
    "type": "llm",
    "provider": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "model": "claude-sonnet-4-20250514",
    "temperature": 0.7,
    "maxTokens": 2048
  }
}
```

Per-power overrides can be added under a `"powers"` key (see `diplomaicy.config.mixed.json` for an example).

### Environment variables

| Variable                 | Default         | Description                                                                                                   |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | `3000`          | Server port                                                                                                   |
| `MAX_YEARS`              | `5`             | Game length in years                                                                                          |
| `PHASE_DELAY`            | `5000`          | Delay between phases (ms)                                                                                     |
| `REMOTE_TIMEOUT`         | `120000`        | Timeout for remote agent responses (ms)                                                                       |
| `DB_PATH`                | `diplomaicy.db` | SQLite database path                                                                                          |
| `ANTHROPIC_API_KEY`      | —               | API key for Anthropic models                                                                                  |
| `LLM_CONCURRENCY`        | `1`             | Max concurrent LLM requests (increase if running multiple inference slots) - used for local integration tests |
| `LLM_REQUEST_TIMEOUT_MS` | `600000`        | Per-request timeout for LLM API calls (ms)                                                                    |

For remote agents, these additional env vars apply:

| Variable       | Description                                            |
| -------------- | ------------------------------------------------------ |
| `LLM_PROVIDER` | LLM provider (`anthropic`, etc.)                       |
| `LLM_BASE_URL` | API base URL                                           |
| `LLM_API_KEY`  | API key for the agent process                          |
| `LLM_MODEL`    | Model identifier                                       |
| `GAME_SERVER`  | tRPC server URL (default `http://localhost:3000/trpc`) |

## Development

```bash
# Dev mode with hot reload
yarn dev

# Run tests
yarn test

# Run e2e screenshot tests
yarn test:e2e

# Lint & format
yarn lint
yarn format
```

### Running a remote agent manually

Start the server expecting remote agents:

```bash
yarn start:remote
```

Then connect individual agents:

```bash
yarn agent -- --power England --type llm
yarn agent -- --power France --type random
```

## Architecture

```
src/
  engine/     Game engine — types, map, order resolution
  agent/      Agent interface, implementations (random, LLM), remote adapter
  game/       Orchestration — GameManager, tRPC router, MessageBus, SQLite storage
  ui/
    server.ts Express + WebSocket + tRPC server
    client/   Vite + Tailwind spectator UI
```

The **GameManager** is agent-agnostic — it uses a promise-gate pattern to wait for order submissions. Agents connect either in-process or remotely via tRPC (HTTP + SSE subscriptions).

## Rules Resources

- https://diplom.org/~diparch/home.htm
- https://www.playdiplomacy.com/help.php?sub_page=Game_Rules

## License

MIT
