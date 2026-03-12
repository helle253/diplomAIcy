import { COAST_OFFSETS, FLEET_OFFSETS } from '../constants/fleet-offsets';
import { UNIT_OFFSETS } from '../constants/unit-offsets';

// ============================================================================
// diplomAIcy — Spectator UI Main Module
// ============================================================================

// --- Types -------------------------------------------------------------------

interface Phase {
  year: number;
  season: string;
  type: string;
}

interface ProvinceState {
  type: string;
  supplyCenter: boolean;
  homeCenter: string | null;
  adjacent: string[];
  coasts: Record<string, string[]> | null;
  owner: string | null;
  unit: { type: 'Army' | 'Fleet'; power: string; coast: string | null } | null;
}

interface RetreatSituation {
  unit: { type: 'Army' | 'Fleet'; power: string; province: string; coast?: string };
  attackedFrom: string;
  validDestinations: string[];
}

interface GameState {
  phase: Phase;
  map: Record<string, ProvinceState>;
  retreatSituations: RetreatSituation[];
}

interface Message {
  id?: string;
  gameId?: string;
  from: string;
  to: string | string[] | 'Global';
  content: string;
  phase: Phase;
  timestamp: number;
}

interface PhaseSnapshot {
  phase: Phase;
  gameState: GameState;
  turnRecord?: unknown;
  messages: Message[];
}

type WSMessage =
  | { type: 'full_history'; snapshots: PhaseSnapshot[]; gameId: string }
  | { type: 'new_phase'; snapshotIndex: number; snapshot: PhaseSnapshot }
  | { type: 'message'; message: Message }
  | { type: 'game_end'; result: Record<string, unknown> };

interface LobbyInfo {
  id: string;
  name: string;
  status: 'waiting' | 'starting' | 'playing' | 'finished';
  createdAt: number;
  maxYears: number;
  victoryThreshold: number;
  startYear: number;
}

// --- Constants ---------------------------------------------------------------

const POWERS = ['England', 'France', 'Germany', 'Italy', 'Austria', 'Russia', 'Turkey'] as const;

const POWER_COLORS: Record<string, string> = {
  England: '#1976d2',
  France: '#64b5f6',
  Germany: '#795548',
  Italy: '#43a047',
  Austria: '#e53935',
  Russia: '#8e24aa',
  Turkey: '#ef6c00',
};

// --- State -------------------------------------------------------------------

let snapshots: PhaseSnapshot[] = [];
let currentIndex = 0;
let isLive = true;
let activeChannel = 'All';
let svgRoot: SVGSVGElement | null = null;
let arrowsLayer: SVGGElement | null = null;
let unitsLayer: SVGGElement | null = null;

let currentWs: WebSocket | null = null;
let lobbyPollTimer: ReturnType<typeof setInterval> | null = null;
let currentLobbyId: string | null = null;

const creatorTokens = new Map<string, string>(
  (() => {
    try {
      const stored = sessionStorage.getItem('creatorTokens');
      return stored ? (JSON.parse(stored) as [string, string][]) : [];
    } catch {
      return [];
    }
  })(),
);

function persistCreatorTokens(): void {
  sessionStorage.setItem('creatorTokens', JSON.stringify([...creatorTokens]));
}

// --- DOM refs ----------------------------------------------------------------

const $ = (sel: string) => document.querySelector(sel);

// Lobby view refs
const lobbyView = $('#lobby-view') as HTMLElement;
const lobbyList = $('#lobby-list') as HTMLElement;
const btnCreateLobby = $('#btn-create-lobby') as HTMLButtonElement;
const createLobbyModal = $('#create-lobby-modal') as HTMLElement;
const createLobbyForm = $('#create-lobby-form') as HTMLFormElement;
const btnCancelCreate = $('#btn-cancel-create') as HTMLButtonElement;

// Game view refs
const gameView = $('#game-view') as HTMLElement;
const mapContainer = $('#map-container') as HTMLElement;
const phaseDisplay = $('#phase-display') as HTMLElement;
const scSummary = $('#sc-summary') as HTMLElement;
const messagesList = $('#messages-list') as HTMLElement;
const chatTabs = $('#chat-tabs') as HTMLElement;
const tooltip = $('#tooltip') as HTMLElement;
const slider = $('#phase-slider') as HTMLInputElement;
const sliderLabel = $('#slider-phase-label') as HTMLElement;
const btnPrev = $('#btn-prev') as HTMLButtonElement;
const btnNext = $('#btn-next') as HTMLButtonElement;
const btnLive = $('#btn-live') as HTMLButtonElement;
const statusDot = $('#status-dot') as HTMLElement;
const statusText = $('#status-text') as HTMLElement;
const btnNewGame = $('#btn-new-game') as HTMLButtonElement;
const btnBackToLobbies = $('#btn-back-to-lobbies') as HTMLButtonElement;

// --- Helpers -----------------------------------------------------------------

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function phaseLabel(p: Phase): string {
  return `${p.season} ${p.year} - ${p.type}`;
}

function currentSnapshot(): PhaseSnapshot | undefined {
  return snapshots[currentIndex];
}

// --- SVG Loading & Setup -----------------------------------------------------

let svgLoaded = false;

async function loadSVG(): Promise<void> {
  if (svgLoaded) return;
  const resp = await fetch('/Diplomacy.svg');
  const text = await resp.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) return;

  svgRoot = svg;
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Walk all <g> elements, annotate those with a <text id="...">
  const groups = svg.querySelectorAll('g');
  groups.forEach((g) => {
    const textEl = g.querySelector(':scope > text[id]');
    if (textEl) {
      const id = textEl.getAttribute('id')!;
      g.classList.add('province-group');
      g.setAttribute('data-province', id.toLowerCase());

      // Hover handlers
      g.addEventListener('mouseenter', (e) => showTooltip(e as MouseEvent, id.toLowerCase()));
      g.addEventListener('mousemove', (e) => moveTooltip(e as MouseEvent));
      g.addEventListener('mouseleave', hideTooltip);
    }
  });

  // Create arrow defs for markers
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.setAttribute('id', 'arrow-defs');
  svg.appendChild(defs);

  // Create units layer
  unitsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  unitsLayer.setAttribute('id', 'units-layer');
  svg.appendChild(unitsLayer);

  // Create arrows layer (above units so arrows are visible over tokens)
  arrowsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  arrowsLayer.setAttribute('id', 'arrows-layer');
  arrowsLayer.setAttribute('pointer-events', 'none');
  svg.appendChild(arrowsLayer);

  mapContainer.innerHTML = '';
  mapContainer.appendChild(svg);
  svgLoaded = true;
}

// --- Tooltip -----------------------------------------------------------------

function showTooltip(e: MouseEvent, provinceId: string): void {
  const snap = currentSnapshot();
  if (!snap) return;

  const ttName = tooltip.querySelector('.tt-name') as HTMLElement;
  const ttOwner = tooltip.querySelector('.tt-owner') as HTMLElement;
  const ttUnit = tooltip.querySelector('.tt-unit') as HTMLElement;

  ttName.textContent = provinceId.toUpperCase();

  const prov = snap.gameState.map[provinceId];
  const owner = prov?.owner;
  ttOwner.textContent = owner ? `Owner: ${owner}` : '';

  const unit = prov?.unit;
  if (unit) {
    ttUnit.textContent = `${unit.power} ${unit.type}${unit.coast ? ` (${unit.coast})` : ''}`;
  } else {
    ttUnit.textContent = '';
  }

  tooltip.classList.remove('hidden');
  moveTooltip(e);
}

function moveTooltip(e: MouseEvent): void {
  tooltip.style.left = e.clientX + 12 + 'px';
  tooltip.style.top = e.clientY + 12 + 'px';
}

function hideTooltip(): void {
  tooltip.classList.add('hidden');
}

// --- Display Updates ---------------------------------------------------------

function updateAll(): void {
  updatePhaseDisplay();
  updateSlider();
  updateProvinceColors();
  updateArrows();
  updateUnits();
  updateSCSummary();
  renderChatTabs();
  updateMessages();
}

function updatePhaseDisplay(): void {
  const snap = currentSnapshot();
  if (!snap) {
    phaseDisplay.textContent = '-- waiting --';
    return;
  }
  phaseDisplay.textContent = phaseLabel(snap.phase);
}

function updateSlider(): void {
  const max = Math.max(0, snapshots.length - 1);
  slider.max = String(max);
  slider.value = String(currentIndex);

  const snap = currentSnapshot();
  sliderLabel.textContent = snap ? phaseLabel(snap.phase) : '--';

  btnLive.classList.toggle('active', isLive);
}

function updateProvinceColors(): void {
  if (!svgRoot) return;
  const snap = currentSnapshot();
  const groups = svgRoot.querySelectorAll('.province-group');

  groups.forEach((g) => {
    // Remove all power-* classes
    POWERS.forEach((p) => g.classList.remove(`power-${p}`));

    if (snap) {
      const prov = g.getAttribute('data-province')!;
      const owner = snap.gameState.map[prov]?.owner;
      if (owner) {
        g.classList.add(`power-${owner}`);
      }
    }
  });
}

function getTextPosition(group: Element): { x: number; y: number } | null {
  const textEl = group.querySelector(':scope > text[id]') as SVGTextElement | null;
  if (!textEl) return null;

  const style = textEl.getAttribute('style') || '';
  // Look for transform: matrix(a,b,c,d,X,Y)
  const matrixMatch = style.match(
    /matrix\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([^,]+),\s*([^)]+)\)/,
  );
  if (matrixMatch) {
    return { x: parseFloat(matrixMatch[1]), y: parseFloat(matrixMatch[2]) };
  }

  // Fallback: try x/y attributes
  const x = parseFloat(textEl.getAttribute('x') || '0');
  const y = parseFloat(textEl.getAttribute('y') || '0');
  return { x, y };
}

/** Compute the pixel position for a unit token given the province text position. */
function unitPosition(
  pos: { x: number; y: number },
  province: string,
  unitType: 'Army' | 'Fleet',
  coast?: string,
): { cx: number; cy: number } {
  // 1. Coast-specific fleets use COAST_OFFSETS from raw text position.
  // 2. Otherwise fall back to text + UNIT_OFFSETS.
  const coastKey = coast ? `${province}/${coast}` : '';
  const coastOffset = COAST_OFFSETS[coastKey];
  if (coastOffset) {
    return { cx: pos.x + coastOffset.dx, cy: pos.y + coastOffset.dy };
  }
  const fleetOv = unitType === 'Fleet' ? FLEET_OFFSETS[province] : undefined;
  const provOffset = fleetOv ?? UNIT_OFFSETS[province];
  return {
    cx: pos.x + (provOffset?.dx ?? 0),
    cy: pos.y + (provOffset?.dy ?? 0),
  };
}

function updateUnits(): void {
  if (!unitsLayer) return;
  unitsLayer.innerHTML = '';

  const snap = currentSnapshot();
  if (!snap) return;

  const ns = 'http://www.w3.org/2000/svg';

  for (const [province, prov] of Object.entries(snap.gameState.map)) {
    if (!prov.unit) continue;
    const unit = prov.unit;

    const group = svgRoot?.querySelector(`.province-group[data-province="${province}"]`);
    if (!group) continue;

    const pos = getTextPosition(group);
    if (!pos) continue;

    const color = POWER_COLORS[unit.power] || '#888';

    const { cx, cy } = unitPosition(pos, province, unit.type, unit.coast ?? undefined);

    const g = document.createElementNS(ns, 'g');
    g.classList.add('unit-marker');

    if (unit.type === 'Army') {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(cx - 7));
      rect.setAttribute('y', String(cy - 7));
      rect.setAttribute('width', '14');
      rect.setAttribute('height', '14');
      rect.setAttribute('rx', '2');
      rect.setAttribute('fill', color);
      g.appendChild(rect);
    } else {
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', '8');
      circle.setAttribute('fill', color);
      g.appendChild(circle);
    }

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', String(cx));
    label.setAttribute('y', String(cy + 3));
    label.setAttribute('text-anchor', 'middle');
    label.textContent = unit.type === 'Army' ? 'A' : 'F';
    g.appendChild(label);

    unitsLayer.appendChild(g);
  }
}

// --- Movement Arrows ---------------------------------------------------------

/** Get or create an arrowhead marker for a given color, returning its url(#id). */
function ensureArrowMarker(color: string): string {
  const id = `arrow-${color.replace('#', '')}`;
  if (svgRoot?.querySelector(`#${id}`)) return `url(#${id})`;

  const ns = 'http://www.w3.org/2000/svg';
  const defs = svgRoot?.querySelector('#arrow-defs');
  if (!defs) return '';

  const marker = document.createElementNS(ns, 'marker');
  marker.setAttribute('id', id);
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto-start-reverse');

  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  path.setAttribute('fill', color);
  marker.appendChild(path);
  defs.appendChild(marker);

  return `url(#${id})`;
}

/** Resolve the SVG pixel position for a province (using text position + unit offsets). */
function provincePosition(
  province: string,
  unitType: 'Army' | 'Fleet' = 'Army',
  coast?: string,
): { cx: number; cy: number } | null {
  const group = svgRoot?.querySelector(`.province-group[data-province="${province}"]`);
  if (!group) return null;
  const pos = getTextPosition(group);
  if (!pos) return null;
  return unitPosition(pos, province, unitType, coast);
}

interface OrderResolutionWire {
  order: {
    type: string;
    unit: string;
    destination?: string;
    coast?: string;
    supportedUnit?: string;
    viaConvoy?: boolean;
  };
  power: string;
  status: string;
  reason?: string;
}

function updateArrows(): void {
  if (!arrowsLayer) return;
  arrowsLayer.innerHTML = '';

  const snap = currentSnapshot();
  if (!snap?.turnRecord) return;

  // turnRecord is typed as unknown — cast to the wire format
  const record = snap.turnRecord as { orders?: OrderResolutionWire[] };
  if (!record.orders || !Array.isArray(record.orders)) return;

  const ns = 'http://www.w3.org/2000/svg';

  // We need to know unit types for position lookups.
  // Build a map from the *previous* snapshot's units (since orders reference origin provinces).
  const prevSnap = currentIndex > 0 ? snapshots[currentIndex - 1] : snap;
  const unitTypeMap = new Map<string, { type: 'Army' | 'Fleet'; coast?: string }>();
  if (prevSnap) {
    for (const [province, prov] of Object.entries(prevSnap.gameState.map)) {
      if (!prov.unit) continue;
      unitTypeMap.set(province, { type: prov.unit.type, coast: prov.unit.coast ?? undefined });
    }
  }

  const blackMarkerUrl = ensureArrowMarker('#000000');
  const redMarkerUrl = ensureArrowMarker('#cc0000');

  for (const res of record.orders) {
    const { order, status } = res;
    const unitInfo = unitTypeMap.get(order.unit);
    const unitType = unitInfo?.type ?? 'Army';

    if (order.type === 'Move' && order.destination) {
      const from = provincePosition(order.unit, unitType, unitInfo?.coast);
      const to = provincePosition(order.destination, unitType, order.coast);
      if (!from || !to) continue;

      const dx = to.cx - from.cx;
      const dy = to.cy - from.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const shorten = dist > 0 ? 10 : 0;
      const startX = from.cx + (dx / dist) * shorten;
      const startY = from.cy + (dy / dist) * shorten;
      const endX = to.cx - (dx / dist) * shorten;
      const endY = to.cy - (dy / dist) * shorten;

      if (status === 'Succeeds') {
        // Solid black arrow
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', String(startX));
        line.setAttribute('y1', String(startY));
        line.setAttribute('x2', String(endX));
        line.setAttribute('y2', String(endY));
        line.setAttribute('stroke', '#000000');
        line.setAttribute('stroke-width', '2.5');
        line.setAttribute('stroke-opacity', '0.85');
        line.setAttribute('marker-end', blackMarkerUrl);
        arrowsLayer.appendChild(line);
      } else {
        // Bounced move: single solid red arrow
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', String(startX));
        line.setAttribute('y1', String(startY));
        line.setAttribute('x2', String(endX));
        line.setAttribute('y2', String(endY));
        line.setAttribute('stroke', '#cc0000');
        line.setAttribute('stroke-width', '2.5');
        line.setAttribute('stroke-opacity', '0.75');
        line.setAttribute('marker-end', redMarkerUrl);
        arrowsLayer.appendChild(line);
      }
    } else if (order.type === 'Support' && order.supportedUnit) {
      const from = provincePosition(order.unit, unitType, unitInfo?.coast);
      const supportedInfo = unitTypeMap.get(order.supportedUnit);
      const supportedPos = provincePosition(
        order.supportedUnit,
        supportedInfo?.type ?? 'Army',
        supportedInfo?.coast,
      );
      if (!from || !supportedPos) continue;

      const supportColor = status === 'Succeeds' ? '#000000' : '#cc0000';
      const opacity = '0.7';

      if (order.destination) {
        // Support-to-move: line to midpoint of movement, then tween toward destination
        const destPos = provincePosition(
          order.destination,
          supportedInfo?.type ?? 'Army',
          order.coast,
        );
        if (!destPos) continue;

        const midX = (supportedPos.cx + destPos.cx) / 2;
        const midY = (supportedPos.cy + destPos.cy) / 2;

        // End point: 3/4 of the way from origin to destination
        const endX = supportedPos.cx + (destPos.cx - supportedPos.cx) * 0.75;
        const endY = supportedPos.cy + (destPos.cy - supportedPos.cy) * 0.75;

        const supportPath = document.createElementNS(ns, 'path');
        supportPath.setAttribute(
          'd',
          `M ${from.cx} ${from.cy} L ${midX} ${midY} L ${endX} ${endY}`,
        );
        supportPath.setAttribute('stroke', supportColor);
        supportPath.setAttribute('stroke-width', '2');
        supportPath.setAttribute('stroke-opacity', opacity);
        supportPath.setAttribute('stroke-dasharray', '6,4');
        supportPath.setAttribute('fill', 'none');
        arrowsLayer.appendChild(supportPath);

        // Circle at the end
        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', String(endX));
        circle.setAttribute('cy', String(endY));
        circle.setAttribute('r', '8');
        circle.setAttribute('stroke', supportColor);
        circle.setAttribute('stroke-width', '2');
        circle.setAttribute('stroke-opacity', opacity);
        circle.setAttribute('fill', 'none');
        arrowsLayer.appendChild(circle);
      } else {
        // Support-to-hold: straight dotted line + circle at supported unit
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', String(from.cx));
        line.setAttribute('y1', String(from.cy));
        line.setAttribute('x2', String(supportedPos.cx));
        line.setAttribute('y2', String(supportedPos.cy));
        line.setAttribute('stroke', supportColor);
        line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-opacity', opacity);
        line.setAttribute('stroke-dasharray', '6,4');
        arrowsLayer.appendChild(line);

        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', String(supportedPos.cx));
        circle.setAttribute('cy', String(supportedPos.cy));
        circle.setAttribute('r', '8');
        circle.setAttribute('stroke', supportColor);
        circle.setAttribute('stroke-width', '2');
        circle.setAttribute('stroke-opacity', opacity);
        circle.setAttribute('fill', 'none');
        arrowsLayer.appendChild(circle);
      }
    }
    // Hold and Convoy orders — no arrows for now
  }
}

function updateSCSummary(): void {
  const snap = currentSnapshot();
  if (!snap) {
    scSummary.innerHTML = '';
    return;
  }

  const counts: Record<string, number> = {};
  POWERS.forEach((p) => (counts[p] = 0));
  for (const prov of Object.values(snap.gameState.map)) {
    if (prov.owner && counts[prov.owner] !== undefined) counts[prov.owner]++;
  }

  scSummary.innerHTML = POWERS.map(
    (p) =>
      `<span class="flex items-center gap-1 text-xs">` +
      `<span class="inline-block h-2.5 w-2.5 rounded-sm" style="background:${POWER_COLORS[p]}"></span>` +
      `<span class="text-gray-300">${p}</span>` +
      `<span class="font-bold text-white">${counts[p]}</span>` +
      `</span>`,
  ).join('');
}

// --- Messages ----------------------------------------------------------------

/** Derive a stable channel key from a message's participants (sorted, joined). */
function channelKey(m: Message): string {
  if (m.to === 'Global') return 'Global';
  const recipients = Array.isArray(m.to) ? m.to : [m.to];
  const parties = Array.from(new Set([m.from, ...recipients]));
  parties.sort();
  return parties.join(',');
}

/** Human-readable channel label: "England ↔ France" or "Global". */
function channelLabel(key: string): string {
  if (key === 'Global') return 'Global';
  return key.split(',').join(' ↔ ');
}

/** Short channel label using 3-letter abbreviations. */
function channelLabelShort(key: string): string {
  if (key === 'Global') return 'Global';
  return key
    .split(',')
    .map((p) => p.slice(0, 3).toUpperCase())
    .join('↔');
}

/** Detect all channels present across ALL snapshots. */
function detectChannels(): string[] {
  const keys = new Set<string>();
  for (const snap of snapshots) {
    if (!snap) continue;
    for (const m of snap.messages) {
      keys.add(channelKey(m));
    }
  }
  // Sort: Global first, then by number of parties (fewer first), then alphabetically
  return Array.from(keys).sort((a, b) => {
    if (a === 'Global') return -1;
    if (b === 'Global') return 1;
    const aParts = a.split(',').length;
    const bParts = b.split(',').length;
    if (aParts !== bParts) return aParts - bParts;
    return a.localeCompare(b);
  });
}

function buildChatTabs(): void {
  renderChatTabs();

  chatTabs.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.chat-tab') as HTMLElement | null;
    if (!btn) return;
    activeChannel = btn.dataset.tab!;
    chatTabs.querySelectorAll('.chat-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    updateMessages();
  });
}

function renderChatTabs(): void {
  const channels = detectChannels();
  const tabs = ['All', ...channels];

  // Preserve selection if channel still exists, otherwise reset
  if (activeChannel !== 'All' && !channels.includes(activeChannel)) {
    activeChannel = 'All';
  }

  chatTabs.innerHTML = tabs
    .map((t) => {
      const label = t === 'All' ? 'All' : channelLabelShort(t);
      const title = t === 'All' ? 'All messages' : channelLabel(t);
      const active = t === activeChannel ? ' active' : '';
      return `<button class="chat-tab${active}" data-tab="${escapeHtml(t)}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
    })
    .join('');
}

function updateMessages(): void {
  const snap = currentSnapshot();
  if (!snap || snap.messages.length === 0) {
    messagesList.innerHTML =
      '<div class="py-5 text-center text-sm italic text-gray-600">No messages yet</div>';
    return;
  }

  let msgs = snap.messages;

  // Filter by selected channel
  if (activeChannel !== 'All') {
    msgs = msgs.filter((m) => channelKey(m) === activeChannel);
  }

  // Most recent first
  const reversed = [...msgs].reverse();

  messagesList.innerHTML = reversed
    .map((m) => {
      const toStr = Array.isArray(m.to) ? m.to.join(', ') : m.to;
      const fromColor = POWER_COLORS[m.from] || '#888';
      return (
        `<div class="msg-entry msg-from-${m.from}">` +
        `<div class="mb-0.5 flex items-center gap-1 text-[10px] text-gray-400">` +
        `<span style="color:${fromColor};font-weight:600">${escapeHtml(m.from)}</span>` +
        `<span>&rarr;</span>` +
        `<span>${escapeHtml(toStr)}</span>` +
        `<span class="ml-auto rounded bg-[#0a0f1a] px-1 py-0.5 text-[9px] text-gray-500">${m.phase.season} ${m.phase.year}</span>` +
        `</div>` +
        `<div class="text-gray-300">${escapeHtml(m.content)}</div>` +
        `</div>`
      );
    })
    .join('');
}

// --- Slider Controls ---------------------------------------------------------

slider.addEventListener('input', () => {
  isLive = false;
  currentIndex = parseInt(slider.value, 10);
  updateAll();
});

btnPrev.addEventListener('click', () => {
  if (currentIndex > 0) {
    isLive = false;
    currentIndex--;
    updateAll();
  }
});

btnNext.addEventListener('click', () => {
  if (currentIndex < snapshots.length - 1) {
    isLive = false;
    currentIndex++;
    updateAll();
  }
});

btnLive.addEventListener('click', () => {
  isLive = true;
  currentIndex = Math.max(0, snapshots.length - 1);
  updateAll();
});

// --- Connection Status -------------------------------------------------------

function setStatus(connected: boolean): void {
  statusDot.style.backgroundColor = connected ? '#22c55e' : '#6b7280';
  statusText.textContent = connected ? 'connected' : 'disconnected';
}

// --- WebSocket ---------------------------------------------------------------

function connect(lobbyId: string): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws/${lobbyId}`);
  currentWs = ws;

  ws.addEventListener('open', () => setStatus(true));

  ws.addEventListener('close', () => {
    setStatus(false);
    // Only reconnect if this is still the active WebSocket
    if (currentWs === ws) {
      setTimeout(() => {
        if (currentWs === ws) connect(lobbyId);
      }, 3000);
    }
  });

  ws.addEventListener('error', () => {
    setStatus(false);
  });

  ws.addEventListener('message', (ev) => {
    const data = JSON.parse(ev.data) as WSMessage;

    switch (data.type) {
      case 'full_history': {
        snapshots = data.snapshots;
        currentIndex = Math.max(0, snapshots.length - 1);
        isLive = true;
        btnNewGame.classList.add('hidden');
        updateAll();
        break;
      }

      case 'new_phase': {
        // Ensure array is big enough and place snapshot
        while (snapshots.length <= data.snapshotIndex) {
          snapshots.push(undefined as unknown as PhaseSnapshot);
        }
        snapshots[data.snapshotIndex] = data.snapshot;

        if (isLive) {
          currentIndex = data.snapshotIndex;
          updateAll();
        } else {
          // Just update the slider range
          updateSlider();
        }
        break;
      }

      case 'message': {
        // Append real-time message to the latest snapshot's messages array
        if (snapshots.length > 0) {
          const latest = snapshots[snapshots.length - 1];
          if (latest) {
            latest.messages.push(data.message);
            // Refresh tabs (new channel may have appeared) and messages
            if (currentIndex === snapshots.length - 1) {
              renderChatTabs();
              updateMessages();
            }
          }
        }
        break;
      }

      case 'game_end': {
        phaseDisplay.textContent = 'GAME OVER';
        btnNewGame.classList.remove('hidden');
        break;
      }
    }
  });
}

// --- New Game Button ---------------------------------------------------------

btnNewGame.addEventListener('click', () => {
  location.hash = '#/';
});

// --- Back to Lobbies ---------------------------------------------------------

btnBackToLobbies.addEventListener('click', () => {
  location.hash = '#/';
});

// --- Lobby Browser -----------------------------------------------------------

async function fetchLobbies(): Promise<void> {
  try {
    const resp = await fetch('/trpc/lobby.list');
    const json = await resp.json();
    const lobbies: LobbyInfo[] = json.result?.data ?? [];
    renderLobbies(lobbies);
  } catch {
    lobbyList.innerHTML =
      '<div class="py-10 text-center text-sm text-red-400">Failed to load lobbies</div>';
  }
}

function statusBadge(status: string): string {
  const colors: Record<string, { bg: string; text: string }> = {
    waiting: { bg: 'bg-yellow-900/50', text: 'text-yellow-400' },
    playing: { bg: 'bg-green-900/50', text: 'text-green-400' },
    finished: { bg: 'bg-gray-700/50', text: 'text-gray-400' },
  };
  const c = colors[status] ?? colors.finished;
  return `<span class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${c.bg} ${c.text}">${escapeHtml(status)}</span>`;
}

function renderLobbies(lobbies: LobbyInfo[]): void {
  if (lobbies.length === 0) {
    lobbyList.innerHTML =
      '<div class="py-10 text-center text-sm text-gray-600 italic">No lobbies yet. Create one to get started.</div>';
    return;
  }

  lobbyList.innerHTML = `<div class="lobby-grid">${lobbies
    .map((l) => {
      const clickable = l.status === 'playing' || l.status === 'finished';
      const cardClass = clickable ? 'lobby-card lobby-card-clickable' : 'lobby-card';
      const onClick = clickable ? `data-lobby-navigate="${escapeHtml(l.id)}"` : '';
      return (
        `<div class="${cardClass}" ${onClick}>` +
        `<div class="flex items-center justify-between mb-2">` +
        `<h3 class="text-sm font-semibold text-gray-200 truncate">${escapeHtml(l.name)}</h3>` +
        statusBadge(l.status) +
        `</div>` +
        `<div class="text-[11px] text-gray-500 space-y-0.5">` +
        `<div>Start: ${l.startYear} &middot; Max years: ${l.maxYears} &middot; Victory: ${l.victoryThreshold}</div>` +
        `</div>` +
        (l.status === 'waiting'
          ? `<button class="lobby-start-btn mt-2" data-lobby-start="${escapeHtml(l.id)}">Start Game</button>`
          : '') +
        `</div>`
      );
    })
    .join('')}</div>`;
}

// Lobby list event delegation
lobbyList.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;

  // Handle start button
  const startBtn = target.closest('[data-lobby-start]') as HTMLElement | null;
  if (startBtn) {
    const id = startBtn.dataset.lobbyStart!;
    startBtn.textContent = 'Starting...';
    (startBtn as HTMLButtonElement).disabled = true;
    try {
      const token = creatorTokens.get(id);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const resp = await fetch('/trpc/lobby.start?batch=1', {
        method: 'POST',
        headers,
        body: JSON.stringify({ 0: { json: undefined } }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: 'Unknown error' }));
        alert(`Failed to start lobby: ${JSON.stringify(body)}`);
        startBtn.textContent = 'Start Game';
        (startBtn as HTMLButtonElement).disabled = false;
        return;
      }
      location.hash = `#/game/${id}`;
    } catch (err) {
      alert(`Network error: ${err}`);
      startBtn.textContent = 'Start Game';
      (startBtn as HTMLButtonElement).disabled = false;
    }
    return;
  }

  // Handle card click to navigate
  const card = target.closest('[data-lobby-navigate]') as HTMLElement | null;
  if (card) {
    const id = card.dataset.lobbyNavigate!;
    location.hash = `#/game/${id}`;
  }
});

// --- Create Lobby Modal ------------------------------------------------------

btnCreateLobby.addEventListener('click', () => {
  createLobbyModal.classList.remove('hidden');
});

btnCancelCreate.addEventListener('click', () => {
  createLobbyModal.classList.add('hidden');
});

createLobbyModal.addEventListener('click', (e) => {
  // Close on backdrop click
  if (e.target === createLobbyModal) {
    createLobbyModal.classList.add('hidden');
  }
});

createLobbyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(createLobbyForm);

  const payload = {
    name: fd.get('name') as string,
    maxYears: Number(fd.get('maxYears')),
    victoryThreshold: Number(fd.get('victoryThreshold')),
    startYear: Number(fd.get('startYear')),
    phaseDelayMs: Number(fd.get('phaseDelayMs')),
    agentConfig: {
      defaultAgent: {
        type: fd.get('agentType') as string,
      },
    },
  };

  try {
    const resp = await fetch('/trpc/lobby.create?batch=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 0: { json: payload } }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: 'Unknown error' }));
      alert(`Failed to create lobby: ${JSON.stringify(body)}`);
      return;
    }
    const body = await resp.json();
    const lobbyId = body[0]?.result?.data?.json?.lobbyId;
    const creatorToken = body[0]?.result?.data?.json?.creatorToken;
    if (lobbyId && creatorToken) {
      creatorTokens.set(lobbyId, creatorToken);
      persistCreatorTokens();
    }
    createLobbyModal.classList.add('hidden');
    createLobbyForm.reset();
    await fetchLobbies();
  } catch (err) {
    alert(`Network error: ${err}`);
  }
});

// --- Routing -----------------------------------------------------------------

function showLobbyView(): void {
  gameView.classList.add('hidden');
  lobbyView.classList.remove('hidden');

  // Close existing WebSocket
  if (currentWs) {
    currentWs.close();
    currentWs = null;
  }
  currentLobbyId = null;

  // Reset game state
  snapshots = [];
  currentIndex = 0;
  isLive = true;

  // Start polling lobbies
  if (lobbyPollTimer) clearInterval(lobbyPollTimer);
  lobbyPollTimer = setInterval(fetchLobbies, 3000);
  fetchLobbies();
}

async function showGameView(lobbyId: string): Promise<void> {
  lobbyView.classList.add('hidden');
  gameView.classList.remove('hidden');

  // Stop lobby polling
  if (lobbyPollTimer) {
    clearInterval(lobbyPollTimer);
    lobbyPollTimer = null;
  }

  // Load SVG if not yet loaded
  await loadSVG();

  // Reconnect if switching to a different lobby
  if (lobbyId !== currentLobbyId) {
    if (currentWs) {
      currentWs.close();
      currentWs = null;
    }
    snapshots = [];
    currentIndex = 0;
    isLive = true;
    currentLobbyId = lobbyId;
    updateAll();
    connect(lobbyId);
  }
}

function route(): void {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/game/')) {
    const lobbyId = hash.slice(7);
    showGameView(lobbyId);
  } else {
    showLobbyView();
  }
}

window.addEventListener('hashchange', route);

// --- Init --------------------------------------------------------------------

async function init(): Promise<void> {
  buildChatTabs();
  route();
}

init();
