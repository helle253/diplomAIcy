---
name: diplomaicy-integration-test
description: Use when the user wants to run a full Diplomacy game with Claude sub-agents as players, integration test the tRPC API, or verify game features end-to-end
---

# DiplomAIcy Integration Test

Run a full Diplomacy game with 7 Claude sub-agents playing all powers via the tRPC API. Each agent thinks strategically, sends diplomacy, submits orders, and writes game notes.

## Setup

### 1. Build and start the server

```bash
cd /workspaces/diplomAIcy
yarn build && node dist/ui/server.js &
```

Wait for `Diplomacy game server running at http://localhost:3000`.

### 2. Create a lobby

```bash
curl -s -X POST http://localhost:3000/trpc/lobby.create \
  -H "Content-Type: application/json" \
  -d '{"name":"Claude vs Claude","maxYears":3,"autostart":true,"agentConfig":{"defaultAgent":{"type":"remote"}},"remoteTimeoutMs":90000}'
```

Save the `lobbyId` and `creatorToken` from the response. `maxYears` controls game length (3 = 1901-1903).

### 3. Create game-notes directory

```bash
mkdir -p game-notes
```

### 4. Write initial referee notes

Create `game-notes/REFEREE_NOTES_{timestamp}.md` with setup info.

### 5. Dispatch 7 sub-agents

Launch all 7 in parallel using the Agent tool with `run_in_background: true`. Each gets a power-specific prompt (see Agent Prompt Template below).

### 6. Monitor as referee

Poll game state periodically:

```bash
curl -s "http://localhost:3000/trpc/game.getState?input=%7B%22lobbyId%22%3A%22LOBBY_ID%22%7D"
```

Check lobby status for game completion:

```bash
curl -s "http://localhost:3000/trpc/lobby.get?input=%7B%22id%22%3A%22LOBBY_ID%22%7D"
```

Update referee notes at milestones (yearly, on retreats, at game end).

## Agent Prompt Template

Each sub-agent prompt MUST include:

1. **Power assignment and lobby ID**
2. **Step 1 — Join**: `POST /trpc/lobby.join` with `{"lobbyId":"...","power":"..."}`, extract seatToken
3. **Step 2 — Wait for game start**: Poll `getState` every 2s until it succeeds
4. **Step 3 — Game loop**: Poll `getState` every 5s, act on phase changes
5. **API reference** (see below)
6. **Starting units** for their power
7. **Strategy hints** for their power
8. **Province ID list** (critical — agents WILL use wrong IDs without this)
9. **Notes file path**: `game-notes/{Power}_NOTES_{timestamp}.md`
10. **Instructions to append-only** to notes (sequential log, not overwrite)
11. **Instructions to report bugs/issues** from their perspective
12. **`gameOver` field**: Tell agents to check `gameOver` in getState response and exit when true

## API Reference (include in each agent prompt)

### Queries (GET, no auth)

**getState**: `GET /trpc/game.getState?input={"lobbyId":"..."}`

- Returns: phase, units, supplyCenters, orderHistory, retreatSituations, endYear, deadlineMs, gameOver

**getRules**: `GET /trpc/game.getRules?input={"lobbyId":"..."}`

- Returns: `{rules: "..."}` — full Diplomacy rules with game-specific values (victory threshold, end year, deadlines). Agents should fetch this once after joining.

**getBuildCount**: `GET /trpc/game.getBuildCount?input={"lobbyId":"...","power":"..."}`

- Returns: `{buildCount: N}` (positive=build, negative=remove)

### Mutations (POST, requires `Authorization: Bearer <seatToken>`)

**submitOrders**: `POST /trpc/game.submitOrders`

```json
{ "orders": [{ "type": "Move", "unit": "lon", "destination": "nth" }] }
```

**submitRetreats**: `POST /trpc/game.submitRetreats`

```json
{ "retreats": [{ "type": "RetreatMove", "unit": "lon", "destination": "wal" }] }
```

**submitBuilds**: `POST /trpc/game.submitBuilds`

```json
{ "builds": [{ "type": "Build", "unitType": "Fleet", "province": "lon" }] }
```

**sendMessage**: `POST /trpc/game.sendMessage`

```json
{ "to": "France", "content": "Alliance?" }
```

`to` can be: power name, array of powers, or `"Global"`.

**Important**: Message content may contain special characters (quotes, newlines, etc.) that break shell quoting in curl. Always generate the JSON body via python3 to avoid encoding issues:

```bash
BODY=$(python3 -c "import json; print(json.dumps({'to':'France','content':'Let us ally — I will not attack you.'}))")
curl -s -X POST http://localhost:3000/trpc/game.sendMessage \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SEAT_TOKEN" \
  -d "$BODY"
```

### Order Types

| Phase    | Type    | Schema                                                                                    |
| -------- | ------- | ----------------------------------------------------------------------------------------- |
| Orders   | Hold    | `{"type":"Hold","unit":"PROV"}`                                                           |
| Orders   | Move    | `{"type":"Move","unit":"FROM","destination":"TO","coast":"nc\|sc"}`                       |
| Orders   | Support | `{"type":"Support","unit":"SUPPORTER","supportedUnit":"SUPPORTED","destination":"WHERE"}` |
| Orders   | Convoy  | `{"type":"Convoy","unit":"FLEET","convoyedUnit":"ARMY","destination":"WHERE"}`            |
| Retreats | Move    | `{"type":"RetreatMove","unit":"PROV","destination":"TO"}`                                 |
| Retreats | Disband | `{"type":"Disband","unit":"PROV"}`                                                        |
| Builds   | Build   | `{"type":"Build","unitType":"Army\|Fleet","province":"PROV","coast":"nc\|sc"}`            |
| Builds   | Remove  | `{"type":"Remove","unit":"PROV"}`                                                         |
| Builds   | Waive   | `{"type":"Waive"}`                                                                        |

Coast is required for moves TO: `stp` (nc/sc), `spa` (nc/sc), `bul` (nc/sc).

## Starting Units

| Power   | Units                          |
| ------- | ------------------------------ |
| England | F lon, F edi, A lvp            |
| France  | F bre, A par, A mar            |
| Germany | F kie, A ber, A mun            |
| Italy   | F nap, A rom, A ven            |
| Austria | F tri, A vie, A bud            |
| Russia  | F stp(sc), F sev, A mos, A war |
| Turkey  | F ank, A con, A smy            |

## Province IDs (CRITICAL — include in agent prompts)

Agents WILL use wrong province IDs (nwy instead of nor, mid instead of mao). Invalid orders silently become Hold. Always include this reference.

**Land**: lon, edi, lvp, cly, wal, yor, par, bre, mar, pic, bur, gas, ber, kie, mun, pru, ruh, sil, rom, nap, ven, pie, tus, apu, vie, bud, tri, boh, gal, tyr, mos, stp, war, sev, ukr, lvn, fin, con, ank, smy, arm, syr, nor, swe, den, hol, bel, spa, por, tun, ser, rum, bul, gre, naf, alb

**Sea**: nat, nwg, bar, nth, iri, eng, mao, wes, lyo, tys, ion, adr, aeg, eas, bla, bal, bot, hel, ska

## Known Issues

None currently.

Agents should call `GET /trpc/game.getRules?input={"lobbyId":"..."}` to get the full Diplomacy rules with game-specific values (victory threshold, end year, deadlines). Include this endpoint in each agent's prompt so they fetch rules after joining. Key rule: invalid orders silently become Hold.
