import './style.css';
import { loadApps, loadSolutions, downloadFirmware, type Solution, type SolutionApp } from './api.ts';
import { Board, bluetoothAvailable } from './ble.ts';
import { findAppImage, verifyImageHash, type FirmwarePart } from './image.ts';
import { sendImage } from './ota.ts';

const SOLUTION_BUILDER = 'https://solutions.carenuity.com';

type Step = 'download' | 'check' | 'send' | 'restart';
const STEPS: { id: Step; label: string }[] = [
  { id: 'download', label: 'Get the app' },
  { id: 'check', label: 'Check that it fits the C3-Mini' },
  { id: 'send', label: 'Send it to the board' },
  { id: 'restart', label: 'Start the app' },
];

interface Job {
  title: string;
  step: Step;
  state: 'running' | 'done' | 'failed';
  message: string;
  abort: AbortController;
}

const state = {
  solutions: [] as Solution[],
  loading: true,
  loadError: '',
  query: '',
  openId: '',
  showEmpty: false,
  board: null as Board | null,
  connecting: false,
  boardError: '',
  job: null as Job | null,
};

const root = document.getElementById('app')!;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const kb = (n: number) => `${Math.round(n / 1024).toLocaleString('en')} KB`;

// ------------------------------------------------------------------ render

function boardCard(): string {
  const b = state.board;
  if (!bluetoothAvailable()) {
    return `<section class="card board">
      <div class="note">This browser cannot use Bluetooth. On Android, open this page in Chrome.
      On an iPhone, open it in the free Bluefy browser or use the Carenuity Flasher app.</div>
    </section>`;
  }
  if (!b) {
    return `<section class="card board">
      <div class="board-row"><span class="dot ${state.connecting ? 'busy' : ''}"></span>
        <div><div class="board-name">${state.connecting ? 'Connecting…' : 'No board connected'}</div>
        <div class="board-sub">Press RESET on the C3-Mini, then tap Connect. The board is visible for 8 seconds after a reset.</div></div>
      </div>
      ${state.boardError ? `<div class="note bad">${esc(state.boardError)}</div>` : ''}
      <div class="actions"><button class="btn primary" data-action="connect" ${state.connecting ? 'disabled' : ''}>Connect board</button></div>
    </section>`;
  }
  const i = b.info;
  const installed = i?.app ? `Running now: ${esc(i.app)}${i.ver ? ` ${esc(i.ver)}` : ''}` : 'No app installed yet';
  return `<section class="card board">
    <div class="board-row"><span class="dot on"></span>
      <div><div class="board-name">${esc(b.name)}</div>
      <div class="board-sub">${installed}${i ? ` · room for ${kb(i.slot)}` : ''}</div></div>
    </div>
    <div class="actions">
      ${i?.app ? '<button class="btn" data-action="boot">Start installed app</button>' : ''}
      <button class="btn" data-action="disconnect">Disconnect</button>
    </div>
  </section>`;
}

function appRow(a: SolutionApp): string {
  const meta = [a.type, a.ecosystem, a.createdAt.slice(0, 10)].filter(Boolean).map(esc).join(' · ');
  const source = /^https?:\/\//.test(a.repository)
    ? ` · <a href="${esc(a.repository)}" target="_blank" rel="noopener">Source</a>`
    : '';
  return `<div class="app">
    <div class="app-tag">${esc(a.tag)}</div>
    <div class="app-meta">${meta}${source}</div>
    <button class="btn primary small" data-action="flash" data-solution="${esc(a.solutionId)}" data-app="${esc(a.id)}">Flash</button>
  </div>`;
}

function solutionList(): string {
  if (state.loading) return '<p class="quiet">Loading solutions from the Solution Builder…</p>';
  if (state.loadError) {
    return `<div class="note bad">${esc(state.loadError)}</div>
      <button class="linkish" data-action="reload">Try again</button>`;
  }
  const q = state.query.trim().toLowerCase();
  const matches = state.solutions.filter(
    (s) => !q || `${s.name} ${s.sensor} ${s.actuator}`.toLowerCase().includes(q),
  );
  const visible = matches.filter((s) => state.showEmpty || s.apps === undefined || s.apps.length > 0);
  const hidden = matches.length - visible.length;

  const rows = visible.map((s) => {
    const open = s.id === state.openId;
    const n = s.apps?.length;
    const count = n === undefined ? '' : n ? `<span class="count">${n} ${n === 1 ? 'app' : 'apps'}</span>` : '<span class="count none">no apps</span>';
    const parts = [s.sensor, s.actuator].filter((x) => x && !/^no /i.test(x)).map(esc).join(' + ');
    const body = !open
      ? ''
      : `<div class="apps">${
          s.apps === undefined
            ? '<p class="quiet">Loading apps…</p>'
            : s.apps.length
              ? s.apps.map(appRow).join('')
              : '<p class="quiet">Nobody has shared an app for this solution yet.</p>'
        }</div>`;
    return `<div class="sol">
      <button class="sol-head" data-action="toggle" data-id="${esc(s.id)}" aria-expanded="${open}">
        <span class="sol-name">${esc(s.name)}</span>${count}
        <span class="sol-meta">${parts || 'C3-Mini only'}</span>
      </button>${body}</div>`;
  });

  return `${rows.join('') || '<p class="quiet">No solution matches your search.</p>'}
    ${hidden ? `<button class="linkish" data-action="show-empty">Show ${hidden} more without apps</button>` : ''}`;
}

function sheet(): string {
  const j = state.job;
  if (!j) return '';
  const at = STEPS.findIndex((s) => s.id === j.step);
  const steps = STEPS.map((s, i) => {
    const cls = j.state === 'done' || i < at ? 'done' : i === at ? (j.state === 'failed' ? 'failed' : 'active') : '';
    const mark = cls === 'done' ? '✓' : cls === 'failed' ? '!' : '';
    return `<li class="${cls}"><span class="mark">${mark}</span><span>${s.label}</span></li>`;
  }).join('');
  const result =
    j.state === 'done'
      ? `<p class="result">${esc(j.message)}</p>`
      : j.state === 'failed'
        ? `<div class="note bad">${esc(j.message)}</div>`
        : '';
  return `<div class="sheet-back"><div class="sheet" role="dialog" aria-modal="true" aria-label="Flashing">
    <h3>${esc(j.title)}</h3>
    <ol class="steps">${steps}</ol>
    <div class="bar"><i id="bar" style="width:${j.state === 'done' ? 100 : 0}%"></i></div>
    <div class="stats" id="stats"></div>
    ${result}
    <div class="actions">${
      j.state === 'running'
        ? '<button class="btn" data-action="cancel">Cancel</button>'
        : '<button class="btn primary" data-action="close">Close</button>'
    }</div>
  </div></div>`;
}

function render() {
  root.innerHTML = `
    <header class="top">
      <div class="kicker">Carenuity · C3-Mini</div>
      <h1>Wireless Flasher</h1>
      <p>Pick an app from the Solution Builder and send it to your board over Bluetooth. No cable, no computer.</p>
    </header>
    <main>
      <div id="board">${boardCard()}</div>
      <section class="card">
        <h2>Solutions for the C3-Mini</h2>
        <input class="search" id="search" type="search" placeholder="Search by name, sensor or display" value="${esc(state.query)}" aria-label="Search solutions" />
        <div class="list" id="list">${solutionList()}</div>
      </section>
      <details class="card">
        <summary>Flash a file from this phone</summary>
        <p class="quiet">Choose a .bin file built for the ESP32-C3: a merged file from the Arduino IDE or a plain app image.</p>
        <input class="file" id="file" type="file" accept=".bin,application/octet-stream" />
      </details>
      <details class="card">
        <summary>First time? Prepare the board once</summary>
        <ol class="steps-help">
          <li>On a computer, open the <a href="${SOLUTION_BUILDER}" target="_blank" rel="noopener">Solution Builder</a> and install
            <b>Carenuity-BLE-OTA-Loader</b> on the C3-Mini with a USB cable. You only do this once.</li>
          <li>From then on the board waits for this app for 8 seconds after every reset or power-up, then starts its own app.</li>
          <li>Need more time? Press RESET, then hold the BOOT button for a moment. The board stays in update mode until the next reset.</li>
        </ol>
      </details>
    </main>
    ${sheet()}`;
}

const refresh = (id: 'board' | 'list') => {
  const el = document.getElementById(id);
  if (el) el.innerHTML = id === 'board' ? boardCard() : solutionList();
};

// ------------------------------------------------------------------ catalog

async function loadCatalog() {
  state.loading = true;
  state.loadError = '';
  refresh('list');
  try {
    state.solutions = await loadSolutions();
  } catch (e) {
    state.loadError = `Could not reach the Solution Builder. Check your internet connection. (${(e as Error).message})`;
  }
  state.loading = false;
  refresh('list');

  // Fetch the app lists in the background so that empty solutions can be hidden.
  const queue = [...state.solutions];
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        if (s.apps) continue;
        try {
          s.apps = await loadApps(s.id);
        } catch {
          /* stays unknown; loaded again when opened */
        }
        refresh('list');
      }
    }),
  );
}

async function toggle(id: string) {
  state.openId = state.openId === id ? '' : id;
  refresh('list');
  const s = state.solutions.find((x) => x.id === id);
  if (s && s.apps === undefined && state.openId === id) {
    try {
      s.apps = await loadApps(id);
    } catch {
      s.apps = [];
    }
    refresh('list');
  }
}

// -------------------------------------------------------------------- board

async function connect(): Promise<Board | null> {
  if (state.board) return state.board;
  state.connecting = true;
  state.boardError = '';
  refresh('board');
  try {
    state.board = await Board.connect(() => {
      state.board = null;
      refresh('board');
    });
  } catch (e) {
    const msg = (e as Error).message ?? '';
    // Closing the device picker is not an error worth showing.
    state.boardError = /cancel/i.test(msg)
      ? ''
      : `Could not connect. Press RESET on the board and try again. (${msg})`;
  }
  state.connecting = false;
  refresh('board');
  return state.board;
}

// -------------------------------------------------------------------- flash

function progress(fraction: number, text: string) {
  const bar = document.getElementById('bar');
  const stats = document.getElementById('stats');
  if (bar) bar.style.width = `${Math.min(100, fraction * 100).toFixed(1)}%`;
  if (stats) stats.textContent = text;
}

async function flash(title: string, getParts: (onProgress: (got: number, total: number) => void) => Promise<FirmwarePart[]>) {
  // Connect first: the device picker needs the tap that started this.
  const board = await connect();
  if (!board) return;

  const job: Job = { title, step: 'download', state: 'running', message: '', abort: new AbortController() };
  state.job = job;
  const go = (step: Step) => {
    job.step = step;
    render();
  };
  render();

  let wake: { release(): Promise<void> } | null = null;
  try {
    wake = (await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null;
  } catch {
    /* optional */
  }

  try {
    const parts = await getParts((got, total) => progress(got / total, `${kb(got)} of ${kb(total)} downloaded`));

    go('check');
    const app = findAppImage(parts);
    if (!(await verifyImageHash(app))) throw new Error('The downloaded app is damaged. Please try again.');

    go('send');
    await sendImage(board, app.image, {
      signal: job.abort.signal,
      onProgress: (p) => {
        const left = Math.max(0, Math.round((p.total - p.sent) / Math.max(1, p.bytesPerSecond)));
        progress(p.sent / p.total, `${kb(p.sent)} of ${kb(p.total)} · ${(p.bytesPerSecond / 1024).toFixed(0)} KB/s · about ${left} s left`);
      },
    });

    job.step = 'restart';
    job.state = 'done';
    job.message = `Done. ${app.projectName || 'The app'} is now starting on your C3-Mini. To flash something else, press RESET on the board and connect again.`;
  } catch (e) {
    job.state = 'failed';
    job.message = (e as Error).message || 'Something went wrong.';
  } finally {
    await wake?.release().catch(() => {});
  }
  render();
}

function flashApp(solutionId: string, appId: string) {
  const app = state.solutions.find((s) => s.id === solutionId)?.apps?.find((a) => a.id === appId);
  if (app) void flash(app.tag, (onProgress) => downloadFirmware(app, onProgress));
}

// ------------------------------------------------------------------- events

root.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'connect':
      void connect();
      break;
    case 'disconnect':
      void state.board?.disconnect();
      state.board = null;
      refresh('board');
      break;
    case 'boot':
      void state.board?.startInstalledApp().catch(() => {});
      break;
    case 'toggle':
      void toggle(el.dataset.id!);
      break;
    case 'show-empty':
      state.showEmpty = true;
      refresh('list');
      break;
    case 'reload':
      void loadCatalog();
      break;
    case 'flash':
      flashApp(el.dataset.solution!, el.dataset.app!);
      break;
    case 'cancel':
      state.job?.abort.abort();
      break;
    case 'close':
      state.job = null;
      render();
      break;
  }
});

root.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement;
  if (el.id === 'search') {
    state.query = el.value;
    refresh('list');
  }
});

root.addEventListener('change', (ev) => {
  const el = ev.target as HTMLInputElement;
  const file = el.id === 'file' ? el.files?.[0] : undefined;
  if (file) {
    void flash(file.name, async () => [{ offset: 0, data: new Uint8Array(await file.arrayBuffer()) }]);
    el.value = '';
  }
});

render();
void loadCatalog();
