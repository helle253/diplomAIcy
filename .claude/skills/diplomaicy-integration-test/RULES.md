# Diplomacy Rules for Agents

Quick reference for how orders work in this engine. These follow standard Diplomacy rules.

## Order Resolution

- **Invalid orders become Hold.** If you submit an order with a wrong province ID, unreachable destination, or illegal move, the unit Holds in place. The API returns `{"ok":true}` regardless — there is no error. Double-check province IDs before submitting.
- **Bounced moves become Hold.** If two units try to move to the same province with equal strength, both bounce and stay put. Bounced units retain a defensive strength of 1 in their starting province. If there is a unit already in a province where a bounce occurred, it is not dislodged.
- **Head-to-head bounces.** Units ordered to each other's province with equal force bounce and do not swap — unless one is being convoyed. Three or more units can rotate positions.
- **Support is cut by attack — with one exception.** Support is cut if the supporting unit is attacked from any province **except** the one where support is being given. For example, if A supports B into C, an attack on A from C does NOT cut the support.
- **You cannot dislodge or cut support of your own units.** Attacks against your own units have no effect.
- **Dislodged units cannot affect their origin province** — they cannot cut support or cause bounces there. However, a dislodged unit CAN still cut support or cause a bounce in a different province (one that is not the origin of the unit that dislodged it).
- **Dislodged units must retreat or disband.** A dislodged unit cannot retreat to: the province it came from, an occupied province, or a province where a bounce occurred that turn. If no legal retreat exists, the unit is automatically destroyed. If two units retreat to the same province, both are destroyed. Armies may not retreat via convoy.

## Phase Sequence

Each game year follows: **Diplomacy → Orders → Retreats (if needed) → Builds (if Winter)**

- **Spring**: Diplomacy → Orders → Retreats
- **Fall**: Diplomacy → Orders → Retreats → Builds

Build phase only happens after Fall. You build if you have more SCs than units, remove if fewer.

You gain control of a supply center by occupying it after the Fall retreat phase. It remains yours until another power occupies it after a Fall retreat phase.

## Order Validity

- **Armies** move to adjacent land provinces. They cannot move to sea zones (except via convoy).
- **Fleets** move to adjacent sea zones or coastal provinces. They cannot move inland.
- **Convoys** require: fleet in a **sea zone** (not coastal province) orders Convoy, army orders Move with `viaConvoy: true`. Convoys can chain through multiple fleets — each fleet must be adjacent to the next, with the first adjacent to the army and the last adjacent to the destination. You may convoy another power's armies. If a convoying fleet is dislodged, the convoy is disrupted and the army does not move (attacking without dislodging has no effect on the convoy).
- **Supports** require: the supporting unit could itself move to the destination. Support-hold: omit destination. You may support opponent units. **A unit ordered to move cannot be supported to hold** — only units ordered to hold, support, or convoy can be supported to hold.
- **Builds** can only happen in your **unoccupied home supply centers**.
- **Coast** is required when moving a fleet TO `stp`, `spa`, or `bul` (use `"coast":"nc"` or `"coast":"sc"`).

## Victory

- A power wins by controlling **18 supply centers**. If all remaining players agree, the game can end in a draw.

## Additional Rules

- **All units have equal strength** — a force of 1. Support adds additional force.

- **Province IDs must be exact.** The engine does not fuzzy-match. See the province ID list in SKILL.md.
- **Armies cannot enter sea zones** (except via convoy). Such orders become Hold.
- **Fleets cannot move inland.** They may only occupy coastal provinces and sea zones.
- **Convoy moves require `viaConvoy: true`** on the army's Move order.
- **Support requires adjacency.** The supporting unit must be able to move to the destination itself.
- **Builds require an unoccupied home supply center.** You cannot build elsewhere or in an occupied home SC.
- **Fleet moves to `stp`, `spa`, or `bul` require a coast** (`"coast":"nc"` or `"coast":"sc"`). Omitting it may cause the order to fail. A fleet on a split-coast province occupies the entire province for all purposes (e.g. it can receive support from a fleet adjacent to the province even if not adjacent to the specific coast). A fleet cannot swap coasts with another fleet on a different coast of the same province.
- **Inland waterways.** Constantinople (`con`), Denmark (`den`), and Kiel (`kie`) have inland waterways — fleets may move through them but **cannot convoy through them** (or any other coastal province).
- **Non-adjacent provinces.** Baltic Sea is NOT adjacent to Helgoland Bight, North Sea, or Skagerrak. Aegean Sea is NOT adjacent to Black Sea. North Africa is NOT adjacent to Spain.
