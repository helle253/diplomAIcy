# Diplomacy Rules

## Overview

Diplomacy is a strategic board game for seven powers (England, France, Germany, Italy, Austria, Russia, Turkey) set in pre-WWI Europe. Players negotiate alliances and issue simultaneous orders to their armies and fleets. There is no luck — outcomes are determined entirely by negotiation and coordination.

## Units

- **Army** — moves on land provinces (Land, Coastal). Cannot enter sea zones (except via convoy).
- **Fleet** — moves on sea zones and coastal provinces. Cannot move inland (Land provinces).

## Provinces

Each province is one of three types:
- **Land** — only armies can occupy
- **Sea** — only fleets can occupy
- **Coastal** — both armies and fleets can occupy

Some coastal provinces have multiple coasts (Spain, St. Petersburg, Bulgaria). When a fleet moves to one of these, it must specify which coast (e.g., `"coast": "nc"` or `"coast": "sc"`).

## Supply Centers

34 of the 75 provinces are supply centers (SCs). Each power starts with 3-4 home SCs. A power controls an SC if it has a unit in that province at the end of a Fall turn. The number of units a power may have equals the number of SCs it controls.

## Phase Sequence

Each game year has two seasons:

**Spring:**
1. Diplomacy — powers exchange messages
2. Orders — all powers submit orders simultaneously
3. Retreats — dislodged units retreat or disband (only if units were dislodged)

**Fall:**
1. Diplomacy — powers exchange messages
2. Orders — all powers submit orders simultaneously
3. Retreats — dislodged units retreat or disband (only if units were dislodged)
4. Builds — powers build new units or remove excess units (only after Fall)

## Order Types

### Hold
Unit stays in place. Default if no order is given or if an invalid order is submitted.
```json
{ "type": "Hold", "unit": "par" }
```

### Move
Unit attempts to move to an adjacent province.
```json
{ "type": "Move", "unit": "par", "destination": "bur" }
```
For fleet moves to multi-coast provinces, specify the coast:
```json
{ "type": "Move", "unit": "mao", "destination": "spa", "coast": "sc" }
```

### Support
Unit supports another unit's hold or move. The supporting unit must be able to move to the destination itself.

Support a hold:
```json
{ "type": "Support", "unit": "mar", "supportedUnit": "par" }
```

Support a move:
```json
{ "type": "Support", "unit": "mar", "supportedUnit": "gas", "destination": "bur" }
```

### Convoy
A fleet in a sea zone convoys an army across water. The army must also order a move with `viaConvoy: true`.

Fleet order:
```json
{ "type": "Convoy", "unit": "eng", "convoyedUnit": "lon", "destination": "bre" }
```

Army order:
```json
{ "type": "Move", "unit": "lon", "destination": "bre", "viaConvoy": true }
```

## Order Resolution

All orders are resolved simultaneously. Key rules:

- **Strength**: A move has strength 1 plus the number of successful supports.
- **Bounces**: If two units move to the same province with equal strength, both bounce and stay put.
- **Head-to-head**: If two units move into each other's provinces, the stronger one succeeds; equal strength means both bounce.
- **Support cutting**: If a supporting unit is attacked (even unsuccessfully), its support is cut. Exception: a unit cannot cut support being given against itself.
- **Dislodgement**: A unit is dislodged if an incoming move has greater strength than the unit's hold/support strength.
- **Invalid orders become Hold**: If you submit an order with a wrong province ID, unreachable destination, or illegal move, the unit Holds in place. The API accepts the submission without error.

## Retreats

Dislodged units must retreat to an adjacent province that is:
- Not occupied
- Not the province the attacker came from
- Not a province where a standoff occurred that turn

If no valid retreat destination exists, the unit is disbanded. The `retreatSituations` field in the game state provides `validDestinations` for each dislodged unit.

```json
{ "type": "RetreatMove", "unit": "par", "destination": "pic" }
```
or
```json
{ "type": "Disband", "unit": "par" }
```

## Builds

After each Fall turn, supply center ownership is updated. If a power controls more SCs than it has units, it may build new units. If it has more units than SCs, it must remove units.

- **Builds** can only happen in unoccupied home supply centers.
- **Removes** can disband any of your units.
- **Waive** forfeits a build if you cannot or choose not to build.

```json
{ "type": "Build", "unitType": "Army", "province": "par" }
```
```json
{ "type": "Build", "unitType": "Fleet", "province": "bre" }
```
For multi-coast home SCs (St. Petersburg):
```json
{ "type": "Build", "unitType": "Fleet", "province": "stp", "coast": "nc" }
```
```json
{ "type": "Remove", "unit": "par" }
```
```json
{ "type": "Waive" }
```

## Victory and Game End

A power wins by controlling **{{VICTORY_THRESHOLD}} or more supply centers**. If no power reaches the victory threshold by **{{END_YEAR}}** (the final year), the game ends in a draw among all surviving powers (those with at least one unit remaining). The game starts in **{{START_YEAR}}**.

**Phase deadline:** {{DEADLINE}}.

## Elimination

A power with zero units is eliminated from the game. Eliminated powers cannot issue orders or build units, even if they still control supply centers (ownership transfers when another power occupies the SC).
