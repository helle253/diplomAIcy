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
  | { type: 'game_restarting'; delayMs: number }
  | { type: 'game_waiting' };

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
// Positioned to avoid covering supply center dots and region labels where possible.
const UNIT_OFFSETS: Record<string, { dx: number; dy: number }> = {
  alb: { dx: 7, dy: 11 },
  ank: { dx: -10, dy: -7 },
  apu: { dx: 0, dy: -10 },
  arm: { dx: -12, dy: -17 },
  bel: { dx: 8, dy: -4 },
  ber: { dx: 7, dy: -12 },
  boh: { dx: 10, dy: -12 },
  bre: { dx: 4, dy: 0 },
  bud: { dx: -4, dy: -23 },
  bul: { dx: -3, dy: 8 },
  bur: { dx: 10, dy: -22 },
  cly: { dx: 13, dy: -21 },
  con: { dx: -10, dy: -8 },
  den: { dx: 5, dy: 10 },
  edi: { dx: 8, dy: 10 },
  fin: { dx: -3, dy: 16 },
  gal: { dx: 24, dy: 5 },
  gas: { dx: 10, dy: -20 },
  gre: { dx: 8, dy: 15 },
  hol: { dx: -8, dy: 4 },
  kie: { dx: 3, dy: 12 },
  lon: { dx: 6, dy: 2 },
  lvn: { dx: -10, dy: -20 },
  lvp: { dx: 6, dy: 12 },
  mar: { dx: 18, dy: -20 },
  mos: { dx: 34, dy: -41 },
  mun: { dx: 14, dy: -22 },
  naf: { dx: -28, dy: -9 },
  nap: { dx: -2, dy: -25 },
  nor: { dx: 30, dy: -25 },
  par: { dx: -3, dy: 12 },
  pic: { dx: 2, dy: -20 },
  pie: { dx: 9, dy: -20 },
  por: { dx: 13, dy: -25 },
  pru: { dx: -15, dy: -13 },
  rom: { dx: 8, dy: -19 },
  ruh: { dx: 9, dy: -20 },
  rum: { dx: -8, dy: -21 },
  ser: { dx: 4, dy: 10 },
  sev: { dx: -24, dy: 5 },
  sil: { dx: -6, dy: -20 },
  smy: { dx: 30, dy: -25 },
  spa: { dx: 8, dy: 10 },
  stp: { dx: 29, dy: -34 },
  swe: { dx: 19, dy: -35 },
  syr: { dx: -10, dy: -25 },
  tri: { dx: 1, dy: -25 },
  tun: { dx: -5, dy: -25 },
  tus: { dx: 8, dy: -20 },
  tyr: { dx: -10, dy: -5 },
  ukr: { dx: 7, dy: -22 },
  ven: { dx: 5, dy: 0 },
  vie: { dx: 8, dy: -23 },
  wal: { dx: -10, dy: 8 },
  war: { dx: 5, dy: 5 },
  yor: { dx: 5, dy: -21 },
};

// Per-province fleet position overrides. Falls back to UNIT_OFFSETS if not specified.
// Used to place fleets near coastlines while armies stay inland.
const FLEET_OFFSETS: Record<string, { dx: number; dy: number }> = {
  // Coastal provinces where fleet should differ from army
  ank: { dx: 1, dy: -20 }, // near BLA coast
  apu: { dx: 3, dy: -16 }, // near ADR coast
  arm: { dx: -22, dy: -33 }, // near BLA coast (northwest edge)
  bel: { dx: -14, dy: -18 }, // near ENG coast
  bre: { dx: -5, dy: -20 },
  con: { dx: 15, dy: -10 }, // near AEG/BLA coast
  den: { dx: -5, dy: 5 }, // near SKA/HEL coast
  fin: { dx: -10, dy: -35 }, // near BOT coast
  gre: { dx: 15, dy: 10 }, // near ION/AEG coast
  hol: { dx: -5, dy: -20 }, // near NTH coast
  kie: { dx: 10, dy: -20 }, // near HEL/BAL coast
  lvn: { dx: -15, dy: -25 }, // near BAL coast
  mar: { dx: -8, dy: 8 },
  naf: { dx: -15, dy: -20 }, // near WES/MAO coast
  nor: { dx: 15, dy: -30 }, // near NWG coast
  pru: { dx: -10, dy: -20 }, // near BAL coast
  rum: { dx: 5, dy: -5 }, // near BLA coast
  sev: { dx: -24, dy: 10 }, // near BLA coast
  swe: { dx: 10, dy: -40 }, // near BOT/SKA coast
  tri: { dx: 10, dy: -10 }, // near ADR coast
  ven: { dx: 10, dy: 10 }, // near ADR coast
  // Sea zones (fleet-only provinces)
  adr: { dx: -16, dy: -22 },
  aeg: { dx: 10, dy: 12 },
  bal: { dx: 12, dy: -20 },
  bar: { dx: 11, dy: 15 },
  ber: { dx: 7, dy: -20 },
  bla: { dx: -25, dy: -3 },
  bot: { dx: 15, dy: 20 },
  eas: { dx: -16, dy: -3 },
  eng: { dx: -16, dy: 1 },
  hel: { dx: 8, dy: -15 },
  ion: { dx: -10, dy: 10 },
  iri: { dx: 4, dy: 11 },
  lyo: { dx: 4, dy: -21 },
  mao: { dx: 14, dy: 42 },
  nat: { dx: 9, dy: 17 },
  nth: { dx: 4, dy: 11 },
  nwg: { dx: 35, dy: 29 },
  ska: { dx: 12, dy: -8 },
  tys: { dx: 11, dy: -22 },
  wes: { dx: -32, dy: 3 },
};

// Pixel offsets for fleet placement on multi-coast provinces.
// Keys are "province/coast", values are {dx, dy} relative to the province text label.
// Positions are chosen near the relevant coastline rather than at the province center.
const COAST_OFFSETS: Record<string, { dx: number; dy: number }> = {
  'stp/nc': { dx: 0, dy: -42 }, // toward Barents Sea (bottom of bay)
  'stp/sc': { dx: -65, dy: 46 }, // toward Gulf of Bothnia (south coast)
  'spa/nc': { dx: 15, dy: -52 }, // toward Bay of Biscay / Gascony (north coast)
  'spa/sc': { dx: 32, dy: 0 }, // toward Western Med (south coast)
  'bul/nc': { dx: 30, dy: -3 }, // northeast corner toward Black Sea
  'bul/sc': { dx: 4, dy: 28 }, // southern edge toward Aegean
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
const btnNewGame = $('#btn-new-game') as HTMLButtonElement;

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

  for (const unit of snap.gameState.units) {
    const group = svgRoot?.querySelector(`.province-group[data-province="${unit.province}"]`);
    if (!group) continue;

    const pos = getTextPosition(group);
    if (!pos) continue;

    const color = POWER_COLORS[unit.power] || '#888';

    const { cx, cy } = unitPosition(pos, unit.province, unit.type, unit.coast);

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

      case 'game_restarting': {
        phaseDisplay.textContent = `Restarting in ${Math.round(data.delayMs / 1000)}s...`;
        break;
      }

      case 'game_waiting': {
        phaseDisplay.textContent = 'GAME OVER';
        btnNewGame.classList.remove('hidden');
        break;
      }
    }
  });
}

// --- New Game Button ---------------------------------------------------------

btnNewGame.addEventListener('click', async () => {
  if (!confirm('Start a new game? The current game results will be preserved.')) return;
  btnNewGame.disabled = true;
  btnNewGame.textContent = 'Starting…';
  try {
    const resp = await fetch('/api/new-game', { method: 'POST' });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: 'Unknown error' }));
      alert(`Failed to start game: ${body.error ?? resp.statusText}`);
    }
  } catch (err) {
    alert(`Network error: ${err}`);
  }
  btnNewGame.disabled = false;
  btnNewGame.textContent = 'New Game';
  btnNewGame.classList.add('hidden');
});

// --- Init --------------------------------------------------------------------

async function init(): Promise<void> {
  await loadSVG();
  buildChatTabs();
  connect();
}

init();
