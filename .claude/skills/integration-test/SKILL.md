---
name: integration-test
description: Use when the user wants to run a full Diplomacy game with Ollama-powered agents, integration test the tRPC API, or verify game features end-to-end
---

# DiplomAIcy Integration Test

Run a full Diplomacy game with 7 Ollama-powered remote agents playing all powers via the tRPC API.

## Prerequisites

Ollama can run either as a Docker container inside the devcontainer, or natively on the host machine for GPU acceleration.

### Option A: Host Ollama (recommended for GPU acceleration)

On Apple Silicon (M1/M2/M3/M4) or machines with NVIDIA GPUs, running Ollama natively on the host gives significantly faster inference via Metal/CUDA:

1. Install Ollama on the host: https://ollama.com/download
2. Start it: `ollama serve` (or use the menu bar app on macOS)
3. Pull your model: `ollama pull qwen2.5:3b` (or `qwen2.5:7b` for higher quality)
4. From inside the devcontainer, run: `.devcontainer/use-host-ollama.sh [model]` (defaults to `qwen2.5:3b`)
5. Use `DIPLOMAICY_CONFIG=diplomaicy.config.ollama-host.json` when launching agents (must match the model you pulled)

Verify reachability: `curl -s http://host.docker.internal:11434/api/tags`

### Option B: Docker Ollama (CPU-only, no host setup needed)

- Start Ollama (opt-in, not running by default): `.devcontainer/start-ollama.sh`
  - This starts the Ollama Docker service and pulls the default model (`qwen2.5:7b`)
  - Pass a different model name as an argument: `.devcontainer/start-ollama.sh qwen2.5:3b`
- Verify Ollama is reachable: `curl -s http://ollama:11434/api/tags`

## Setup

### 1. Build the project

```bash
cd /workspaces/diplomAIcy
yarn install
yarn build
```

Ensure `node_modules` exists before building. `yarn install` is a no-op if dependencies are already up to date.

### 2. Pre-flight checks

Verify Ollama is reachable and list available models. For host Ollama:

```bash
curl -sf http://host.docker.internal:11434/api/tags | python3 -c "
import json, sys
data = json.load(sys.stdin)
models = [m['name'] for m in data.get('models', [])]
if not models:
    print('WARNING: No models pulled. Run: ollama pull <model>')
    sys.exit(1)
print('Available models:')
for m in models:
    print(f'  - {m}')
"
```

For Docker Ollama, use `http://ollama:11434` instead.

If the desired model is not listed, ask the user which model to use from the available list, or whether to pull a new one.

### 3. Start the server

```bash
npx tsx src/ui/server.ts &
SERVER_PID=$!
# Wait for server to be ready
until curl -sf http://localhost:3000/health > /dev/null 2>&1; do sleep 1; done
echo "Server ready (PID $SERVER_PID)"
```

Save `SERVER_PID` for cleanup in step 9.

### 4. Create a lobby

```bash
curl -s -X POST http://localhost:3000/trpc/lobby.create \
  -H "Content-Type: application/json" \
  -d '{"name":"Ollama Integration Test","maxYears":2,"autostart":true,"fastAdjudication":true,"agentConfig":{"defaultAgent":{"type":"remote"}},"remoteTimeoutMs":600000}'
```

Response: `{"result":{"data":{"lobbyId":"...","creatorToken":"..."}}}`. Extract `lobbyId` from `result.data`. `maxYears: 2` keeps the test short (1901-1902). `fastAdjudication: true` means the engine advances as soon as all agents have submitted — no waiting for `PHASE_DELAY`.

### 5. Create game-notes directory

```bash
mkdir -p game-notes
```

### 6. Write initial referee notes

Create `game-notes/REFEREE_NOTES_{lobbyId}.md` with setup info (lobby ID, model, start time).

### 7. Launch 7 Ollama-powered agents

Launch each power as a background remote agent process. All agents launch simultaneously — Ollama queues requests naturally. PIDs are saved to a file for reliable cleanup later.

```bash
POWERS=(England France Germany Italy Austria Russia Turkey)
LOBBY_ID="<lobby-id-from-step-4>"
PID_FILE="game-notes/agent-pids.txt"
> "$PID_FILE"

## Set config based on Ollama setup:
## Option A (host Ollama):  DIPLOMAICY_CONFIG=diplomaicy.config.ollama-host.json
## Option B (docker Ollama): DIPLOMAICY_CONFIG=diplomaicy.config.ollama-docker.json
DIPLOMAICY_CONFIG=diplomaicy.config.ollama-host.json

for power in "${POWERS[@]}"; do
  DIPLOMAICY_CONFIG="$DIPLOMAICY_CONFIG" \
  npx tsx integration-test/run-with-notes.ts --power "$power" --lobby "$LOBBY_ID" --type llm --notes-dir "game-notes" > "game-notes/${power}.log" 2>&1 &
  echo $! >> "$PID_FILE"
done
echo "All 7 agents launched. PIDs saved to $PID_FILE"
```

You MUST run this via the Bash tool — these are native remote agent processes, not sub-agents.

### 8. Monitor as referee using /loop

After all agents are connected, invoke the `/loop` skill to set up recurring monitoring. Set the interval to roughly **half the observed phase length** — watch the first phase complete to gauge timing, then set the loop accordingly.

Use the `/loop` skill with a prompt like:

```text
/loop <interval> Check game <LOBBY_ID>: curl game state from localhost:3000, report phase/year, SC counts per power, unit positions, check lobby status for game completion. If game is finished, report final results and stop. Append notable events to game-notes/REFEREE_NOTES_<LOBBY_ID>.md.
```

You can also poll manually at any time:

```bash
curl -s "http://localhost:3000/trpc/game.getState?input=%7B%22lobbyId%22%3A%22${LOBBY_ID}%22%7D" | python3 -m json.tool
```

Check lobby status for game completion:

```bash
curl -s "http://localhost:3000/trpc/lobby.get?input=%7B%22id%22%3A%22${LOBBY_ID}%22%7D" | python3 -m json.tool
```

Response data is at `result.data`.

#### Reading agent logs

Tail individual agent logs for real-time debugging (invalid orders, LLM timeouts, tool call failures):

```bash
# Tail a specific agent
tail -f game-notes/England.log

# Tail all agents at once
tail -f game-notes/*.log
```

Update referee notes at milestones (yearly, on retreats, at game end).

### 9. Cleanup

When the game ends (or to abort early), kill all agent processes and the server using saved PIDs:

```bash
# Kill agents
PID_FILE="game-notes/agent-pids.txt"
if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    kill "$pid" 2>/dev/null
  done < "$PID_FILE"
  rm "$PID_FILE"
  echo "All agents stopped."
else
  pkill -f "run-with-notes.ts" 2>/dev/null
  echo "Agents stopped (fallback)."
fi

# Kill server
if [ -n "$SERVER_PID" ]; then
  kill "$SERVER_PID" 2>/dev/null
  echo "Server stopped."
fi
```

### Alternative: Automated Script

For quick runs without manual control, `scripts/play-llm.sh` automates the full setup (server start, agent launch, cleanup). The manual steps above give more control for monitoring and customization.

## Configuration

### Using a different Ollama host

If Ollama is running somewhere other than the devcontainer service:

```bash
LLM_BASE_URL=http://localhost:11434/v1  # or wherever Ollama is
```

### Parallel Ollama Slots

By default, Ollama processes requests sequentially (`OLLAMA_NUM_PARALLEL=1`). With 7 agents each making 3-5 LLM calls per phase, this creates a bottleneck where phases take 10-15 minutes to resolve.

Setting `OLLAMA_NUM_PARALLEL` allows multiple agents to query simultaneously:

```bash
# On the host machine (stop existing Ollama first):
OLLAMA_NUM_PARALLEL=3 ollama serve
```

**VRAM budget** (qwen2.5:14b Q4_K_M uses ~9.3GB base):
- **16GB unified memory (M2 Pro etc.):** `N=2` safe, `N=3` tight but workable
- **32GB:** `N=4-5` comfortably
- **48GB+:** `N=7` (one slot per agent)

Each parallel slot adds ~0.5-1GB for KV cache. If you see performance degrade or swapping, reduce `N`.

**Alternative:** Use a smaller model (`qwen2.5:7b` at ~4.7GB) with higher parallelism — e.g., `N=3` with 7b on 16GB gives ~6x speedup vs `N=1` with 14b.

If Ollama is managed by Homebrew:
```bash
brew services stop ollama
OLLAMA_NUM_PARALLEL=3 ollama serve   # runs in foreground
```

Or via launchctl:
```bash
launchctl setenv OLLAMA_NUM_PARALLEL 3
brew services restart ollama
```

### Timeouts

- `remoteTimeoutMs` in lobby creation controls how long the server waits for agent submissions
- The default of 600000 (10 min) is generous; for faster models you can decrease it (e.g. `"remoteTimeoutMs": 180000` for 3 min)
- `PHASE_DELAY` env var on the server controls the minimum delay between engine phases (default 10 minutes). With `fastAdjudication: true`, the engine advances as soon as all agents submit, so `PHASE_DELAY` only matters if agents are faster than the delay

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
- `"aborting completion request due to client closing the connection"` — LLM client timeout too short for inference. The default is 600s (10 min). Set `LLM_REQUEST_TIMEOUT_MS` env var to adjust
- `size_vram: 0` in `api/ps` output — model is running on CPU only, expect slow inference. Use a smaller model (3B or 0.5B)
- OOM kills — model too large for available memory

## What to watch for

1. **Invalid orders** — check agent logs (`game-notes/*.log`) for orders that silently became Hold (indicates the model isn't following the province ID format)
2. **Timeouts** — if agents don't submit in time, their orders default. Increase `remoteTimeoutMs` or use a faster model
3. **Agent crashes** — check per-power log files in `game-notes/`. Common cause: Ollama OOM on large models
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
