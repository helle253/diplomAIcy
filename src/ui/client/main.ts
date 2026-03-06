// ============================================================================
// diplomAIcy — Spectator UI Main Module
// ============================================================================

// --- Types -------------------------------------------------------------------

interface Phase {
  year: number;
  season: string;
  type: string;
}

interface UnitInfo {
  type: 'Army' | 'Fleet';
  power: string;
  province: string;
  coast?: string;
}

interface GameState {
  phase: Phase;
  units: UnitInfo[];
  supplyCenters: Record<string, string>;
  retreatSituations: unknown[];
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
  | { type: 'game_end'; result: Record<string, unknown> }
  | { type: 'game_restarting'; delayMs: number };

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

// Per-province unit position offsets (dx, dy) relative to the default text-based position.
// Used to nudge units into province centers when the text label is near an edge.
const UNIT_OFFSETS: Record<string, { dx: number; dy: number }> = {
  // British Isles — small, tightly packed provinces
  cly: { dx: -5, dy: 10 },
  edi: { dx: 5, dy: 10 },
  lvp: { dx: -5, dy: 5 },
  yor: { dx: 5, dy: 0 },
  wal: { dx: -5, dy: 5 },
  lon: { dx: 0, dy: 5 },
  // France
  pic: { dx: 0, dy: 5 },
  bre: { dx: 0, dy: 5 },
  par: { dx: 5, dy: 0 },
  gas: { dx: 5, dy: 5 },
  bur: { dx: 5, dy: 0 },
  // Low Countries / Germany
  bel: { dx: 0, dy: 5 },
  hol: { dx: 0, dy: 5 },
  ruh: { dx: 5, dy: 0 },
  kie: { dx: 5, dy: 0 },
  ber: { dx: 0, dy: 0 },
  // Northern Italy — tight cluster
  pie: { dx: 0, dy: 5 },
  ven: { dx: 5, dy: -5 },
  tus: { dx: -5, dy: 5 },
  rom: { dx: 0, dy: 5 },
  apu: { dx: 0, dy: 5 },
  // Balkans
  alb: { dx: 0, dy: 5 },
  ser: { dx: 5, dy: 0 },
  tri: { dx: 0, dy: 5 },
  // Scandinavia
  den: { dx: 0, dy: 5 },
  swe: { dx: 0, dy: 5 },
  nor: { dx: 0, dy: 5 },
  // Eastern
  stp: { dx: -10, dy: 10 },
  arm: { dx: -10, dy: 0 },
  sev: { dx: -10, dy: 5 },
  con: { dx: 0, dy: 5 },
};

// Pixel offsets for fleet placement on multi-coast provinces.
// Keys are "province/coast", values are {dx, dy} relative to the province text label.
const COAST_OFFSETS: Record<string, { dx: number; dy: number }> = {
  'stp/nc': { dx: 40, dy: -25 }, // toward Barents Sea (northeast)
  'stp/sc': { dx: -30, dy: 20 }, // toward Gulf of Bothnia (southwest)
  'spa/nc': { dx: -15, dy: -25 }, // toward Bay of Biscay (north)
  'spa/sc': { dx: 25, dy: 30 }, // toward Western Med (south/east)
  'bul/nc': { dx: 40, dy: -20 }, // east coast toward Black Sea (northeast)
  'bul/sc': { dx: -20, dy: 30 }, // south coast toward Aegean (south)
};

// --- State -------------------------------------------------------------------

let snapshots: PhaseSnapshot[] = [];
let currentIndex = 0;
let isLive = true;
let activeChannel = 'All';
let svgRoot: SVGSVGElement | null = null;
let unitsLayer: SVGGElement | null = null;

// --- DOM refs ----------------------------------------------------------------

const $ = (sel: string) => document.querySelector(sel)!;
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

async function loadSVG(): Promise<void> {
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

  // Create units layer at the end of the SVG
  unitsLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  unitsLayer.setAttribute('id', 'units-layer');
  svg.appendChild(unitsLayer);

  mapContainer.innerHTML = '';
  mapContainer.appendChild(svg);
}

// --- Tooltip -----------------------------------------------------------------

function showTooltip(e: MouseEvent, provinceId: string): void {
  const snap = currentSnapshot();
  if (!snap) return;

  const ttName = tooltip.querySelector('.tt-name') as HTMLElement;
  const ttOwner = tooltip.querySelector('.tt-owner') as HTMLElement;
  const ttUnit = tooltip.querySelector('.tt-unit') as HTMLElement;

  ttName.textContent = provinceId.toUpperCase();

  const owner = snap.gameState.supplyCenters[provinceId];
  ttOwner.textContent = owner ? `Owner: ${owner}` : '';

  const unit = snap.gameState.units.find((u) => u.province === provinceId);
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
      const owner = snap.gameState.supplyCenters[prov];
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

function updateUnits(): void {
  if (!unitsLayer) return;
  unitsLayer.innerHTML = '';

  const snap = currentSnapshot();
  if (!snap) return;

  const ns = 'http://www.w3.org/2000/svg';

  for (const unit of snap.gameState.units) {
    const group = svgRoot?.querySelector(`.province-group[data-province="${unit.province}"]`);
    if (!group) continue;

    const pos = getTextPosition(group);
    if (!pos) continue;

    const color = POWER_COLORS[unit.power] || '#888';

    // Coast-specific fleets use COAST_OFFSETS from raw text position;
    // all other units use UNIT_OFFSETS for province-center nudging.
    const coastKey = unit.coast ? `${unit.province}/${unit.coast}` : '';
    const coastOffset = COAST_OFFSETS[coastKey];
    let cx: number, cy: number;
    if (coastOffset) {
      cx = pos.x + coastOffset.dx;
      cy = pos.y - 15 + coastOffset.dy;
    } else {
      const provOffset = UNIT_OFFSETS[unit.province];
      cx = pos.x + (provOffset?.dx ?? 0);
      cy = pos.y - 15 + (provOffset?.dy ?? 0);
    }

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

function updateSCSummary(): void {
  const snap = currentSnapshot();
  if (!snap) {
    scSummary.innerHTML = '';
    return;
  }

  const counts: Record<string, number> = {};
  POWERS.forEach((p) => (counts[p] = 0));
  for (const owner of Object.values(snap.gameState.supplyCenters)) {
    if (counts[owner] !== undefined) counts[owner]++;
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

function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('open', () => setStatus(true));

  ws.addEventListener('close', () => {
    setStatus(false);
    setTimeout(connect, 3000);
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
        break;
      }

      case 'game_restarting': {
        phaseDisplay.textContent = `Restarting in ${Math.round(data.delayMs / 1000)}s...`;
        break;
      }
    }
  });
}

// --- Init --------------------------------------------------------------------

async function init(): Promise<void> {
  await loadSVG();
  buildChatTabs();
  connect();
}

init();
