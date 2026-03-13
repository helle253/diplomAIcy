---
name: integration-test
description: Use when the user wants to run a full Diplomacy game with Ollama-powered agents, integration test the tRPC API, or verify game features end-to-end
---

# DiplomAIcy Integration Test

Run a full Diplomacy game with 7 Ollama-powered remote agents playing all powers via the tRPC API.

## Prerequisites

- Start Ollama (opt-in, not running by default): `.devcontainer/start-ollama.sh`
  - This starts the Ollama Docker service and pulls the default model (`qwen2.5:7b`)
  - Pass a different model name as an argument: `.devcontainer/start-ollama.sh qwen2.5:3b`
- Verify Ollama is reachable: `curl -s http://ollama:11434/api/tags`

## Setup

### 1. Build the project

```bash
cd /workspaces/diplomAIcy
yarn build
```

### 2. Start the server

```bash
npx tsx src/ui/server.ts &
```

Wait for `Diplomacy game server running at http://localhost:3000`.

### 3. Create a lobby

```bash
curl -s -X POST http://localhost:3000/trpc/lobby.create \
  -H "Content-Type: application/json" \
  -d '{"name":"Ollama Integration Test","maxYears":2,"autostart":true,"fastAdjudication":false,"agentConfig":{"defaultAgent":{"type":"remote"}},"remoteTimeoutMs":600000}'
```

Response: `{"result":{"data":{"lobbyId":"...","creatorToken":"..."}}}`. Extract `lobbyId` from `result.data`. `maxYears: 2` keeps the test short (1901-1902). `fastAdjudication: false` means agents don't need to call `submitReady`.

### 4. Create game-notes directory

```bash
mkdir -p game-notes
```

### 5. Write initial referee notes

Create `game-notes/REFEREE_NOTES_{timestamp}.md` with setup info (lobby ID, model, start time).

### 6. Launch 7 Ollama-powered agents

Launch each power as a background remote agent process. Stagger launches by 3 seconds to avoid thundering herd:

```bash
POWERS=(England France Germany Italy Austria Russia Turkey)
LOBBY_ID="<lobby-id-from-step-3>"

for power in "${POWERS[@]}"; do
  DIPLOMAICY_CONFIG=diplomaicy.config.ollama.json \
  npx tsx .claude/skills/integration-test/run-with-notes.ts --power "$power" --lobby "$LOBBY_ID" --type llm --notes-dir "game-notes" &
  echo "Launched $power agent (PID $!)"
  sleep 3
done
```

You MUST run this via the Bash tool — these are native remote agent processes, not sub-agents.

### 7. Monitor as referee

Poll game state periodically (replace `LOBBY_ID` with the actual lobby ID):

```bash
curl -s "http://localhost:3000/trpc/game.getState?input=%7B%22lobbyId%22%3A%22LOBBY_ID%22%7D" | python3 -m json.tool
```

Check lobby status for game completion:

```bash
curl -s "http://localhost:3000/trpc/lobby.get?input=%7B%22id%22%3A%22LOBBY_ID%22%7D" | python3 -m json.tool
```

Response data is at `result.data`.

Update referee notes at milestones (yearly, on retreats, at game end).

### 8. Cleanup

When the game ends (or to abort early):

```bash
kill $(jobs -p) 2>/dev/null
```

## Configuration

### Changing the model

Any Ollama model works. Smaller models are faster but produce worse orders:

| Model          | Size | Quality                   | Speed     |
| -------------- | ---- | ------------------------- | --------- |
| `qwen2.5:0.5b` | 0.5B | Low (many invalid orders) | Very fast |
| `qwen2.5:3b`   | 3B   | Moderate                  | Fast      |
| `llama3.2`     | 3B   | Moderate                  | Fast      |
| `qwen2.5:7b`   | 7B   | Good (default, 8K ctx)    | Moderate  |

### Using a different Ollama host

If Ollama is running somewhere other than the devcontainer service:

```bash
LLM_BASE_URL=http://localhost:11434/v1  # or wherever Ollama is
```

### Timeouts

- `remoteTimeoutMs` in lobby creation controls how long the server waits for agent submissions
- The default of 600000 (10 min) is generous; for faster models you can decrease it (e.g. `"remoteTimeoutMs": 180000` for 3 min)
- `PHASE_DELAY` env var on the server controls delay between phases

## Monitoring

### Ollama Docker Container

Periodically check the Ollama Docker container logs for issues during the game:

```bash
# Check Ollama health
curl -s http://ollama:11434/api/ps | python3 -m json.tool

# Watch for aborted requests, OOM, or errors in the Docker logs
# (run from the host or use `docker logs ollama-1 --tail 20`)
```

Common issues to watch for:
- `"aborting completion request due to client closing the connection"` — LLM client timeout too short for CPU inference. Set `LLM_REQUEST_TIMEOUT_MS` env var higher (e.g. `600000` for 10 min)
- `size_vram: 0` in `api/ps` output — model is running on CPU only, expect slow inference. Use a smaller model (3B or 0.5B)
- OOM kills — model too large for available memory

## What to watch for

1. **Invalid orders** — check server logs for orders that silently became Hold (indicates the model isn't following the province ID format)
2. **Timeouts** — if agents don't submit in time, their orders default. Increase `remoteTimeoutMs` or use a faster model
3. **Agent crashes** — check background job output. Common cause: Ollama OOM on large models
4. **Phase progression** — game should advance through Spring 1901 Orders → Fall 1901 Orders → Winter 1901 Builds → etc.
5. **Diplomacy messages** — agents should be sending press messages via `sendMessage`

## Reviewing Agent Notes

After the game, each agent's notes are in `game-notes/{lobbyId}/{Power}.md`. These contain:

- **Strategy sections** — the agent's plans, alliance assessments, and reflections on what worked
- **UX Feedback sections** — observations about prompt clarity, format confusion, and suggestions

Review these to understand agent behavior and identify prompt improvements.

## Troubleshooting

**"Ollama not reachable"** — Ollama doesn't start by default. Run `.devcontainer/start-ollama.sh` to start it.

**"model not found"** — Pull the model first: `curl http://ollama:11434/api/pull -d '{"name":"qwen2.5:7b"}'`

**Agents hang** — The model may be too slow. Try a smaller model or increase timeouts.

**All orders are Hold** — The model is producing invalid order JSON. Check agent logs and try a larger model with better instruction following.
