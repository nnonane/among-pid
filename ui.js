/* mafia v0.9 | ui.js | 30 Sep 2026 */
/*
  Rendering and admin controls. Talks to store.js and engine.js only.
  Contains NO game rules — anything that decides an outcome lives in engine.js.

  v0.4 added live player submissions. The console READS what players submitted
  from player.html instead of only taking dictation. Three things are
  deliberately unchanged:

    1. engine.js. Submissions are folded into currentActions and
       currentBallots in exactly the shape it already consumed.
    2. The manual path. Every dropdown still works, for the player whose
       laptop died, and an admin edit always outranks a later sync.
    3. Offline mode. With no cloud there is no sync, and the console runs
       precisely as it did in v0.2.3.

  v0.5 fixes the Rewards race that lost the Doctor's token.

  The winner checkbox called store.commit() WITHOUT awaiting it, while the
  5-second poll re-rendered the whole Rewards view underneath it. A poll
  landing mid-commit rebuilt the winners table from state that had not yet
  been written, so the tick silently disappeared and that player was never
  paid. The fix is an `editing` latch: the poll refuses to redraw while a
  commit from a form control is in flight, and the handler now awaits its
  own write. Nothing about the award logic itself changed - it was correct.

  v0.6 fixes restarting a game online, and adds a Reset button. Reset keeps
  the same player rows (so logins survive) and wipes only the game data.
  Adding a player checks the live database first, so the same name can no
  longer create a duplicate.

  v0.7 retires the Doctor and Sheriff. Everyone who is not Mafia is a
  Civilian, the only night action is the Mafia kill, and Temporary Immunity
  is the only thing that blocks it. Old saves convert automatically.

  v0.8 merges Discussion and Voting into one "Discuss & vote" phase on a
  shared timer (5 minutes by default, in Settings). Ballots are public: a
  vote board on every screen shows who voted for whom. Online, the ballots
  table is the single source of truth - admin corrections are written to it
  too, so every screen and the tally always agree.

  v0.9 reveals the voted-out player's role to every player's screen (via
  reveal_role.sql). The console already showed it; the final vote board now
  also tags the eliminated player with their role.
*/

import * as E from './engine.js';
import { Store, LocalAdapter, newPlayer, newInventoryItem, retireRole } from './store.js';
import { chooseAdapter, mountStorageButton } from './cloud.js';
import { Live, SOURCE, mergeActions, mergeBallots } from './live.js';
import {
  GAME_TITLE, GAME_SUBTITLE, MINIGAMES,
  PHASE_LABEL, PHASE_HINT, ROLE_LABEL, ITEM_LABEL, ITEM_HINT, SETTING_LABEL
} from './content.js';

const { adapter, mode, sb } = await chooseAdapter();
const store = new Store(adapter);

/* Null in offline mode. Every call site checks. */
const live = mode === 'cloud' && sb ? new Live(sb) : null;

/* Pending purchase requests for the current week, refreshed by pollNow(). */
let pendingPurchases = [];

/* One poll timer for the whole app, cleared at the top of every render so a
   phase change can never leave two of them running. */
let pollTimer = null;

/* Raised while a form control is mid-commit. The poll will not re-render
   while this is set, so a checkbox cannot be redrawn from stale state
   between the click and the write landing. */
let editing = false;

/* ---------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = () => store.get();
const settings = () => ({ ...E.DEFAULT_SETTINGS, ...(S().game.settings || {}) });
const byId = (id) => S().players.find((p) => p.id === id);
const nameOf = (id) => byId(id)?.displayName ?? 'Unknown';
const roleLabel = (r) => ROLE_LABEL[r] ?? r;

/** Deterministic per-round, per-purpose seed so reruns are reproducible. */
const rngFor = (purpose) => {
  const g = S().game;
  let h = 0;
  for (const ch of purpose) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return E.makeRng((g.rngSeed + g.currentRound * 7919 + h) >>> 0);
};

let toastTimer;
function toast(msg, warn = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (warn ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

function confirmAction(question, detail = '') {
  return new Promise((resolve) => {
    openModal(`
      <h2>${esc(question)}</h2>
      ${detail ? `<p class="hint">${esc(detail)}</p>` : ''}
      <div class="btn-row">
        <button class="btn primary" data-yes>Confirm</button>
        <button class="btn ghost" data-no>Cancel</button>
      </div>`, (root, close) => {
      root.querySelector('[data-yes]').onclick = () => { close(); resolve(true); };
      root.querySelector('[data-no]').onclick = () => { close(); resolve(false); };
    });
  });
}

function openModal(html, wire) {
  const host = $('modalHost');
  host.innerHTML = '';
  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal', html);
  backdrop.appendChild(modal);
  host.appendChild(backdrop);
  const close = () => { host.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  if (wire) wire(modal, close);
  const first = modal.querySelector('input, select, button');
  if (first) first.focus();
  return close;
}

/** Every mutation goes through here so audit is never forgotten. */
async function commit(mutator, audit) {
  await store.commit(mutator, audit);
  render();
}

/**
 * A commit raised by a form control the admin is actively using.
 *
 * Holds the `editing` latch for the duration of the write, so the poll
 * cannot redraw the surrounding view from state the commit has not reached
 * yet. Does NOT re-render on its own: the control is already showing the
 * value the admin chose, and repainting underneath their cursor is the
 * behaviour this exists to prevent.
 */
async function commitQuiet(mutator, audit) {
  editing = true;
  try {
    await store.commit(mutator, audit);
  } finally {
    editing = false;
  }
}

/* ==================================================== LIVE SUBMISSIONS == */
/*
  The console polls rather than subscribing. Polling is boring, survives a
  dropped socket without anyone noticing, and five seconds is far faster than
  anyone can type. A realtime channel would be neater and would also need a
  reconnect story on a night when the wifi is unreliable.
*/

/**
 * Pulls this week's submissions and folds them into state.
 * Returns true only if something actually changed, so an admin halfway
 * through a dropdown is not interrupted by a pointless re-render.
 */
async function pollNow({ silent = true } = {}) {
  if (!live) return false;
  const round = S().game.currentRound;
  if (!round) return false;

  const phase = S().game.status;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let changed = false;

  if (phase === E.PHASE.HIDDEN_ACTIONS) {
    const merged = mergeActions(S().currentActions || [], await live.fetchActions(round));
    if (!same(merged, S().currentActions || [])) {
      await store.commit((d) => { d.currentActions = merged; });
      changed = true;
    }
  }

  if (phase === E.PHASE.VOTING) {
    /* Online, the ballots table IS the vote. Admin corrections are written
       there as well (setBallot), so there is nothing to merge - just mirror
       it. A failed read keeps what we have rather than wiping the board. */
    const incoming = await live.fetchBallots(round);
    const merged = live.lastError ? (S().currentBallots || []) : incoming;
    if (!same(merged, S().currentBallots || [])) {
      await store.commit((d) => { d.currentBallots = merged; });
      changed = true;
    }
  }

  if (phase === E.PHASE.REWARDS) {
    const next = await live.fetchPendingPurchases(round);
    if (!same(next, pendingPurchases)) {
      pendingPurchases = next;
      changed = true;
    }
  }

  if (live.lastError && !silent) toast('Sync problem: ' + live.lastError, true);
  return changed;
}

/** Only the three phases that have anything to collect are polled. */
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!live) return;
  const collecting = [E.PHASE.HIDDEN_ACTIONS, E.PHASE.VOTING, E.PHASE.REWARDS];
  if (!collecting.includes(S().game.status)) return;
  pollTimer = setInterval(async () => {
    /* Never redraw while the admin is mid-edit. A tick that vanishes
       because a poll landed is indistinguishable from one that was never
       registered, and it cost the Doctor a token. */
    if (editing) return;
    if (await pollNow()) render();
  }, S().game.status === E.PHASE.VOTING ? 3000 : 5000);
}

/**
 * The waiting-on banner. This is the thing that actually saves time on the
 * night: it names who has not submitted, so nobody has to ask the room
 * "has everyone done theirs?" and give away that someone is missing.
 */
function liveBanner(expected, haveIds, noun) {
  const wrap = el('div', 'card');

  if (!live) {
    wrap.innerHTML = `
      <h2>Player submissions</h2>
      <div class="warnbox">Offline mode — players cannot submit anything.
        Enter every ${esc(noun)} by hand below.</div>`;
    return wrap;
  }

  const waiting = expected.filter((p) => !haveIds.has(p.id));
  wrap.innerHTML = `
    <h2>Player submissions
      <span class="badge ${waiting.length ? 'dormant' : 'alive'}">${expected.length - waiting.length} of ${expected.length}</span>
    </h2>
    <p class="hint">Refreshing automatically every few seconds.</p>
    ${waiting.length
      ? `<div class="warnbox">Waiting on ${waiting.map((p) => esc(p.displayName)).join(', ')}.
          Chase them, or enter the ${esc(noun)} yourself below — anything you set by hand
          outranks a later submission.</div>`
      : '<div class="okbox">Everyone is in.</div>'}
    <div class="btn-row" style="margin-top:0">
      <button class="btn sm" id="syncNow">Refresh now</button>
    </div>`;

  wrap.querySelector('#syncNow').onclick = async () => {
    await pollNow({ silent: false });
    render();
  };
  return wrap;
}

/* ------------------------------------------------------------- selectors */

const living = () => S().players.filter(E.isAlive);
const present = () => S().players.filter(E.isPresent);
const spirits = () => S().players.filter(E.isSpirit);
const activeRoster = () => S().players.filter(E.isProfileActive);

const actionsOf = (type) => (S().currentActions || []).filter((a) => a.type === type);
const actionBy = (actorId) => (S().currentActions || []).find((a) => a.actorId === actorId);

const isStaged = (p, type) =>
  (p.inventory || []).some(
    (i) => i.rewardType === type && i.status === 'STAGED' && i.stagedRound === S().game.currentRound
  );

const ownsUsable = (p, type) =>
  (p.inventory || []).some(
    (i) =>
      i.rewardType === type && i.status === 'OWNED' &&
      (i.eligibleFromRound == null || i.eligibleFromRound <= S().game.currentRound)
  );

/**
 * Distinguishes a submission the player made themselves from one the admin
 * typed in. Worth showing: if a row says Admin when you did not touch it,
 * something has gone wrong and you want to know before you resolve.
 */
function sourceLabel(entry, doneWord = 'Submitted') {
  if (!entry || (!entry.targetId && doneWord === 'Submitted')) return 'Waiting';
  if (!entry) return 'Waiting';
  return entry.source === SOURCE.ADMIN ? 'Admin entry' : doneWord;
}

function playerOption(p, selected) {
  return `<option value="${p.id}"${selected === p.id ? ' selected' : ''}>${esc(p.displayName)}</option>`;
}

function targetSelect(name, current, { exclude = [], pool = present(), blank = '— none —' } = {}) {
  const opts = pool
    .filter((p) => !exclude.includes(p.id))
    .map((p) => playerOption(p, current))
    .join('');
  return `<select data-field="${name}"><option value="">${blank}</option>${opts}</select>`;
}

/* ============================================================ CHROME ==== */

function renderChrome() {
  const g = S().game;
  $('brandTitle').textContent = GAME_TITLE;
  $('brandSub').textContent = GAME_SUBTITLE;
  $('roundNum').textContent = g.currentRound || '—';
  $('phaseName').textContent = PHASE_LABEL[g.status] ?? g.status;

  const cd = $('countdownChip');
  cd.hidden = !g.countdownEnabled;
  if (g.countdownEnabled) $('countdownNum').textContent = g.roundsRemaining ?? '—';

  // Phase rail
  const rail = $('phaseRail');
  rail.innerHTML = '';
  const idx = E.PHASE_ORDER.indexOf(g.status);
  E.PHASE_ORDER.forEach((ph, i) => {
    const cls = g.status === E.PHASE.FINISHED ? 'done'
      : i === idx ? 'active' : i < idx ? 'done' : '';
    rail.appendChild(el('li', cls, `<span class="dot"></span>${esc(PHASE_LABEL[ph])}`));
  });

  $('btnBack').disabled = g.status === E.PHASE.CLOSED || g.status === E.PHASE.FINISHED;
  $('btnNext').disabled = g.status === E.PHASE.FINISHED;
  $('btnNext').textContent =
    g.status === E.PHASE.CLOSED ? 'Open session →'
    : g.status === E.PHASE.RESULTS ? 'Close session →'
    : 'Advance phase →';
  $('railNote').textContent = PHASE_HINT[g.status] ?? '';

  renderRoster();
  renderFeed();
}

function renderRoster() {
  const list = $('roster');
  list.innerHTML = '';
  const all = activeRoster();
  $('rosterCount').textContent = `${living().length} alive · ${spirits().length} spirit`;

  if (!all.length) {
    list.appendChild(el('li', '', '<span class="faint">No players yet.</span>'));
    return;
  }

  const order = { ALIVE: 0, SPIRIT: 1 };
  [...all]
    .sort((a, b) =>
      (order[a.lifeStatus] - order[b.lifeStatus]) ||
      a.displayName.localeCompare(b.displayName))
    .forEach((p) => {
      const dead = p.lifeStatus === E.LIFE.SPIRIT;
      const dormant = !dead && p.attendanceStatus === E.ATTENDANCE.DORMANT;
      const status = dead ? '<span class="badge spirit">Spirit</span>'
        : dormant ? '<span class="badge dormant">Dormant</span>'
        : '<span class="badge alive">Alive</span>';
      const li = el('li', dead ? 'is-dead' : '', `
        <span class="nm">${esc(p.displayName)}</span>
        <span class="badge role">${esc(roleLabel(p.role))}</span>
        ${status}`);
      li.title = 'Click to inspect or override';
      li.onclick = () => openPlayerModal(p.id);
      list.appendChild(li);
    });
}

function renderFeed() {
  const feed = $('feed');
  feed.innerHTML = '';
  const events = [...(S().audit || [])].reverse().slice(0, 14);
  if (!events.length) {
    feed.appendChild(el('li', '', '<span class="faint">Nothing yet.</span>'));
    return;
  }
  for (const e of events) {
    const when = new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    feed.appendChild(el('li', '',
      `${esc(e.summary || e.eventType)}<span class="when">Week ${e.round} · ${when}</span>`));
  }
}

/* ====================================================== ROSTER SYNC ==== */
/** Pulls in player rows that exist in the database but not in this console.
    Does nothing offline. Never removes anyone. */
async function syncRosterFromDatabase() {
  if (typeof adapter.loadPlayers !== 'function') return;
  let fresh;
  try { fresh = await adapter.loadPlayers(); } catch { return; }
  const known = new Set(S().players.map((p) => p.id));
  const missing = fresh.filter((p) => !known.has(p.id)).map(retireRole);
  if (!missing.length) return;
  await store.commit((d) => { d.players = [...d.players, ...missing]; },
    { eventType: 'ROSTER_SYNCED',
      summary: `${missing.length} player(s) loaded from the database` });
}

/* ============================================================ RESET ===== */
function downloadBackup() {
  const blob = new Blob([store.exportJson()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = store.backupFilename();
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

function openResetPanel() {
  openModal(`
    <h2>Reset the game</h2>
    <p class="hint">Takes the game back to week 0. Pick how much to clear.</p>
    <div class="warnbox">This cannot be undone. Download a backup first if you might want this game back.</div>
    <div class="btn-row" style="margin-top:0">
      <button class="btn" id="rBackup">Download backup</button>
    </div>
    <h3>New game, same players</h3>
    <p class="faint">Keeps everyone on the roster <strong>and their logins</strong>.
      Wipes roles, tokens, Spirit Points, items, history and every player
      submission. Deal roles again afterwards. Settings are kept.</p>
    <div class="btn-row" style="margin-top:8px">
      <button class="btn primary" id="rKeep">Reset - keep players</button>
    </div>
    <h3>Wipe everything</h3>
    <p class="faint">Also deletes every player.${live
      ? ' Online, every login email has to be set up again.' : ''}
      Type <strong>RESET</strong> to enable.</p>
    <div class="inline">
      <label class="field" style="margin:0"><span>Confirm</span>
        <input type="text" id="rType" autocomplete="off" placeholder="RESET"></label>
      <button class="btn danger" id="rAll" disabled>Wipe everything</button>
    </div>
    <div class="btn-row"><button class="btn ghost" id="rCancel">Cancel</button></div>
    <div id="rMsg"></div>`,
  (root, close) => {
    const allBtn = root.querySelector('#rAll');
    root.querySelector('#rCancel').onclick = close;
    root.querySelector('#rType').oninput = (e) => {
      allBtn.disabled = e.target.value.trim() !== 'RESET';
    };
    root.querySelector('#rBackup').onclick = () => {
      try {
        downloadBackup();
        root.querySelector('#rMsg').innerHTML =
          '<div class="okbox">Backup downloaded - check your Downloads folder.</div>';
      } catch (err) {
        root.querySelector('#rMsg').innerHTML =
          `<div class="warnbox">Download failed: ${esc(err.message)}. Use Backup, then Show text.</div>`;
      }
    };
    const run = async (keepPlayers) => {
      root.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      root.querySelector('#rMsg').innerHTML = '<div class="okbox">Resetting…</div>';
      await resetGame(keepPlayers);
      close();
    };
    root.querySelector('#rKeep').onclick = () => run(true);
    allBtn.onclick = () => run(false);
  });
}

/** Stop polling, re-read roster, clear submissions, write the new game.
    Same player ids = same rows = same logins. */
async function resetGame(keepPlayers) {
  clearInterval(pollTimer);
  pollTimer = null;
  editing = true;
  try {
    let roster = S().players;
    if (keepPlayers && typeof adapter.loadPlayers === 'function') {
      try {
        roster = await adapter.loadPlayers();
      } catch (err) {
        return toast('Reset stopped - could not read the players: ' + err.message, true);
      }
    }
    if (typeof adapter.resetSubmissions === 'function') {
      const cleared = await adapter.resetSubmissions(S().game.currentRound);
      if (!cleared.ok) toast(cleared.reason, true);
    }
    if (!keepPlayers && typeof adapter.clear === 'function' && live) {
      await adapter.clear();
    }
    await store.newGame(keepPlayers ? roster : []);
    pendingPurchases = [];
  } finally {
    editing = false;
  }
  render();
  toast(keepPlayers
    ? `New game ready - ${S().players.length} player(s) kept. Deal roles when ready.`
    : 'Everything wiped. Add players to start.');
}

/* ========================================================== PHASES ====== */

function render() {
  clearInterval(clockHandle);
  clockHandle = null;
  renderChrome();
  startPolling();
  const main = $('main');
  main.innerHTML = '';
  const g = S().game;
  const view = {
    [E.PHASE.CLOSED]: viewClosed,
    [E.PHASE.ATTENDANCE]: viewAttendance,
    [E.PHASE.HIDDEN_ACTIONS]: viewHiddenActions,
    [E.PHASE.MINIGAME]: viewMinigame,
    [E.PHASE.REWARDS]: viewRewards,
    [E.PHASE.RESOLUTION]: viewResolution,
    [E.PHASE.MASTER]: viewMaster,
    [E.PHASE.VOTING]: viewVoting,
    [E.PHASE.RESULTS]: viewResults,
    [E.PHASE.FINISHED]: viewFinished
  }[g.status] || viewClosed;
  view(main);
}

/* ------------------------------------------------------------- CLOSED --- */

function viewClosed(main) {
  const g = S().game;
  const started = g.currentRound > 0;

  const card = el('div', 'card accent');
  card.innerHTML = `
    <h2>${started ? 'Between sessions' : 'Set up the game'}</h2>
    <p class="hint">${esc(PHASE_HINT.CLOSED)}</p>
    <h3>Add players</h3>
    <div class="inline">
      <label class="field" style="margin:0">
        <span>Name</span>
        <input type="text" id="newName" placeholder="e.g. Michelle Cao" autocomplete="off">
      </label>
      <button class="btn" id="btnAdd">Add player</button>
    </div>
    <p class="faint" id="balanceNote"></p>`;
  main.appendChild(card);

  const note = card.querySelector('#balanceNote');
  const count = activeRoster().length;
  if (!started) {
    const b = E.startingBalance(Math.max(count, 1));
    note.textContent = count
      ? `${count} players → ${b.mafia} Mafia, ${b.civilian} Civilian.`
      : 'Add at least 10 players for the documented balance.';
  } else {
    note.textContent = 'New players joining mid-game receive a balance-based role on their first session.';
  }

  const addPlayer = async () => {
    const input = card.querySelector('#newName');
    const name = input.value.trim().replace(/\s+/g, ' ');
    if (!name) return;
    /* Online, check the database rather than this browser's copy. A stale
       copy is exactly how duplicate rows were made. */
    await syncRosterFromDatabase();
    const key = name.toLowerCase();
    const match = S().players.find(
      (p) => p.displayName.trim().replace(/\s+/g, ' ').toLowerCase() === key);
    if (match) {
      input.value = '';
      if (match.attendanceStatus !== E.ATTENDANCE.INACTIVE) {
        render();
        return toast(`${match.displayName} is already on the roster.`, true);
      }
      await commit((d) => {
        d.players = d.players.map((p) => p.id === match.id
          ? { ...p, attendanceStatus: E.ATTENDANCE.PRESENT } : p);
      }, { eventType: 'PLAYER_REJOINED', summary: `${match.displayName} rejoined the roster` });
      return toast(`${match.displayName} was already set up, so they have been brought back - same login.`);
    }
    await commit((d) => { d.players.push(newPlayer(name, d.game.currentRound)); },
      { eventType: 'PLAYER_ADDED', summary: `${name} added to the roster` });
    input.value = '';
    input.focus();
  };
  card.querySelector('#btnAdd').onclick = addPlayer;
  card.querySelector('#newName').onkeydown = (e) => { if (e.key === 'Enter') addPlayer(); };

  // --- roles -------------------------------------------------------------
  if (!started && activeRoster().length >= 3) {
    const roles = el('div', 'card');
    const assigned = S().players.some((p) => p.role !== E.ROLE.CIVILIAN);
    roles.innerHTML = `
      <h2>Assign starting roles</h2>
      <p class="hint">Roles are dealt randomly using the documented balance. You can override any
        individual afterwards from the roster.</p>
      ${assigned ? '<div class="okbox">Roles have been dealt. Re-dealing replaces every current role.</div>' : ''}
      <div class="btn-row">
        <button class="btn primary" id="btnDeal">${assigned ? 'Re-deal all roles' : 'Deal roles'}</button>
      </div>`;
    main.appendChild(roles);

    roles.querySelector('#btnDeal').onclick = async () => {
      if (assigned && !(await confirmAction('Re-deal every role?',
        'All current role assignments are replaced. Tokens, points and inventory are kept.'))) return;
      const rng = rngFor('deal');
      await commit((d) => {
        const dealt = E.assignStartingRoles(d.players.filter(E.isProfileActive), rng);
        const map = new Map(dealt.map((p) => [p.id, p]));
        d.players = d.players.map((p) => map.get(p.id) ?? p);
      }, { eventType: 'ROLES_DEALT', summary: 'Starting roles dealt', trackDiff: true });
      toast('Roles dealt privately. Tell each player individually.');
    };
  }

  // --- last week ---------------------------------------------------------
  const lastRound = [...(S().rounds || [])].reverse()[0];
  if (lastRound) {
    const recap = el('div', 'card');
    recap.innerHTML = `
      <h2>Last session — week ${lastRound.number}</h2>
      <p class="hint">${esc(lastRound.publicSummary || 'No public summary recorded.')}</p>`;
    main.appendChild(recap);
  }

  if (started) {
    const note2 = el('div', 'card');
    note2.innerHTML = `
      <h2>Skipped weeks are safe</h2>
      <p class="hint">Nothing expires and no state changes while the session is closed.
        The next session resumes exactly from here.</p>`;
    main.appendChild(note2);
  }
}

/* --------------------------------------------------------- ATTENDANCE --- */

function viewAttendance(main) {
  const card = el('div', 'card accent');
  card.innerHTML = `
    <h2>Who is here?</h2>
    <p class="hint">${esc(PHASE_HINT.ATTENDANCE)}</p>
    <div class="btn-row" style="margin:0 0 14px">
      <button class="btn sm" id="allIn">Mark everyone present</button>
      <button class="btn sm ghost" id="allOut">Mark everyone dormant</button>
    </div>
    <table><thead><tr><th>Player</th><th>State</th><th style="width:210px">Attendance</th></tr></thead>
    <tbody id="attBody"></tbody></table>`;
  main.appendChild(card);

  const body = card.querySelector('#attBody');
  for (const p of activeRoster()) {
    const dead = p.lifeStatus === E.LIFE.SPIRIT;
    const tr = el('tr', p.attendanceStatus === E.ATTENDANCE.DORMANT ? 'dim' : '');
    tr.innerHTML = `
      <td>${esc(p.displayName)}</td>
      <td>${dead ? '<span class="badge spirit">Spirit</span>' : '<span class="badge alive">Alive</span>'}</td>
      <td>
        <button class="btn sm ${p.attendanceStatus === E.ATTENDANCE.PRESENT ? 'primary' : 'ghost'}" data-in>Present</button>
        <button class="btn sm ${p.attendanceStatus === E.ATTENDANCE.DORMANT ? 'danger' : 'ghost'}" data-out>Dormant</button>
      </td>`;
    tr.querySelector('[data-in]').onclick = () => setAttendance(p.id, E.ATTENDANCE.PRESENT);
    tr.querySelector('[data-out]').onclick = () => setAttendance(p.id, E.ATTENDANCE.DORMANT);
    body.appendChild(tr);
  }

  card.querySelector('#allIn').onclick = () => setAllAttendance(E.ATTENDANCE.PRESENT);
  card.querySelector('#allOut').onclick = () => setAllAttendance(E.ATTENDANCE.DORMANT);

  // --- resurrection ------------------------------------------------------
  const candidates = spirits().filter((p) => p.attendanceStatus === E.ATTENDANCE.PRESENT);
  const res = el('div', 'card private');
  res.innerHTML = `
    <h2>Resurrection requests</h2>
    <p class="hint">Resolved now, before hidden actions. Everyone returns as a Civilian.</p>`;
  if (!candidates.length) {
    res.appendChild(el('p', 'empty', 'No spirits present.'));
  } else {
    const t = el('table', '', `<thead><tr><th>Spirit</th><th class="num">Points</th>
      <th class="num">Cost</th><th style="width:130px"></th></tr></thead><tbody></tbody>`);
    const tb = t.querySelector('tbody');
    for (const p of candidates) {
      const cost = E.resurrectionCost(p, settings());
      const can = p.spiritPoints >= cost;
      const tr = el('tr');
      tr.innerHTML = `
        <td>${esc(p.displayName)}</td>
        <td class="num tokens">${p.spiritPoints}</td>
        <td class="num">${cost}${cost < settings().resurrectionCost ? ' <span class="faint">(discount)</span>' : ''}</td>
        <td><button class="btn sm ${can ? 'primary' : ''}" ${can ? '' : 'disabled'}>Resurrect</button></td>`;
      tr.querySelector('button').onclick = async () => {
        const r = E.resurrect(S(), p.id);
        if (!r.ok) return toast(r.reason, true);
        await commit((d) => { d.players = r.players; },
          { eventType: 'RESURRECTION', actorId: p.id,
            summary: `${p.displayName} resurrected as a Civilian for ${r.cost} points`, trackDiff: true });
        toast(`${p.displayName} is alive again — as a Civilian.`);
      };
      tb.appendChild(tr);
    }
    res.appendChild(t);
  }
  main.appendChild(res);

  // --- late joiners ------------------------------------------------------
  const joiners = S().players.filter(
    (p) => E.isProfileActive(p) && p.joinedRound === S().game.currentRound && p.role === E.ROLE.CIVILIAN
  );
  if (joiners.length && S().game.currentRound > 1) {
    const lj = el('div', 'card');
    lj.innerHTML = `<h2>Late joiners</h2>
      <p class="hint">Suggest a balance-based role. Preview it, then override if you prefer.</p>`;
    for (const p of joiners) {
      const row = el('div', 'rowsplit', `<span>${esc(p.displayName)}</span>`);
      const btn = el('button', 'btn sm', 'Suggest role');
      btn.onclick = async () => {
        const suggested = E.suggestLateJoinerRole(S().players, rngFor('joiner' + p.id), settings());
        if (await confirmAction(`Assign ${roleLabel(suggested)} to ${p.displayName}?`,
          'Balance-based suggestion. You can override from the roster at any time.')) {
          await commit((d) => {
            d.players = d.players.map((x) => x.id === p.id
              ? { ...x, role: suggested, alignment: E.alignmentOf(suggested) } : x);
          }, { eventType: 'LATE_JOINER_ROLE', summary: `${p.displayName} joined as ${roleLabel(suggested)}` });
        }
      };
      row.appendChild(btn);
      lj.appendChild(row);
    }
    main.appendChild(lj);
  }
}

async function setAttendance(id, status) {
  await commit((d) => {
    d.players = d.players.map((p) => (p.id === id ? { ...p, attendanceStatus: status } : p));
    if (status === E.ATTENDANCE.DORMANT) {
      d.currentActions = (d.currentActions || []).filter(
        (a) => a.actorId !== id && a.targetId !== id && a.secondaryTargetId !== id);
      d.currentBallots = (d.currentBallots || []).filter(
        (b) => b.voterId !== id && b.targetId !== id);
    }
  });
}

async function setAllAttendance(status) {
  await commit((d) => {
    d.players = d.players.map((p) =>
      E.isProfileActive(p) ? { ...p, attendanceStatus: status } : p);
    if (status === E.ATTENDANCE.DORMANT) { d.currentActions = []; d.currentBallots = []; }
  }, { eventType: 'ATTENDANCE_BULK', summary: `Everyone marked ${status.toLowerCase()}` });
}

/* ---------------------------------------------------- HIDDEN ACTIONS --- */

function viewHiddenActions(main) {
  const intro = el('div', 'card accent');
  intro.innerHTML = `
    <h2>Collect hidden actions</h2>
    <p class="hint">${esc(PHASE_HINT.HIDDEN_ACTIONS)}</p>
    <div class="warnbox">Mafia submit from their own screen; Civilians have no night action.
      Anything below is a fallback — use it for anyone who cannot log in, and take it privately.</div>`;
  main.appendChild(intro);

  // Who is expected to submit something tonight.
  const actors = present().filter((p) => p.role === E.ROLE.MAFIA);
  const haveActions = new Set(
    (S().currentActions || []).filter((a) => a.targetId).map((a) => a.actorId));
  main.appendChild(liveBanner(actors, haveActions, 'action'));

  // --- Mafia -------------------------------------------------------------
  const mafia = present().filter((p) => p.role === E.ROLE.MAFIA);
  const mCard = el('div', 'card private');
  mCard.innerHTML = `<h2>Mafia kill ballots</h2>
    <p class="hint">Each active Mafia picks a target. Majority wins; a tie is broken randomly and logged.</p>`;
  if (!mafia.length) {
    mCard.appendChild(el('div', 'warnbox', 'No Mafia present this week — there will be no kill.'));
  } else {
    const grid = el('div', 'action-grid');
    for (const m of mafia) {
      const cur = actionBy(m.id);
      const row = el('div', 'action-row' + (cur?.targetId ? ' submitted' : ''));
      row.innerHTML = `
        <div class="who">${esc(m.displayName)}<small>Mafia</small></div>
        ${targetSelect('t', cur?.targetId, { exclude: [m.id], blank: '— no ballot —' })}
        <span class="badge ${cur?.targetId ? 'alive' : 'out'}">${sourceLabel(cur)}</span>`;
      row.querySelector('select').onchange = (e) =>
        setAction(m.id, E.ACTION.MAFIA_KILL_VOTE, e.target.value);
      grid.appendChild(row);
    }
    mCard.appendChild(grid);

    const tally = {};
    for (const a of actionsOf(E.ACTION.MAFIA_KILL_VOTE)) if (a.targetId) tally[a.targetId] = (tally[a.targetId] || 0) + 1;
    const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    if (entries.length) {
      mCard.appendChild(el('p', 'faint',
        'Current tally: ' + entries.map(([id, n]) => `${esc(nameOf(id))} ${n}`).join(' · ')));
    }
  }
  main.appendChild(mCard);
}

function stageToggle(player, itemType) {
  const on = isStaged(player, itemType);
  const wrap = el('div', 'checkline');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = on;
  cb.id = `stage_${player.id}_${itemType}`;
  cb.onchange = () => toggleStage(player.id, itemType, cb.checked);
  const lab = el('label', '', `Use <strong>${esc(ITEM_LABEL[itemType])}</strong> this week
    <span class="faint">— ${esc(ITEM_HINT[itemType])}</span>`);
  lab.setAttribute('for', cb.id);
  wrap.append(cb, lab);
  return wrap;
}

/* Uses commitQuiet: this is a checkbox the admin is actively clicking, and a
   poll landing mid-write must not redraw it from state the write has not
   reached yet. Same class of bug as the winners table. */
async function toggleStage(playerId, itemType, on) {
  const round = S().game.currentRound;
  await commitQuiet((d) => {
    d.players = d.players.map((p) => {
      if (p.id !== playerId) return p;
      const inv = [...(p.inventory || [])];
      if (on) {
        const i = inv.findIndex((x) => x.rewardType === itemType && x.status === 'OWNED');
        if (i >= 0) inv[i] = { ...inv[i], status: 'STAGED', stagedRound: round };
      } else {
        const i = inv.findIndex(
          (x) => x.rewardType === itemType && x.status === 'STAGED' && x.stagedRound === round);
        if (i >= 0) inv[i] = { ...inv[i], status: 'OWNED', stagedRound: null };
      }
      return { ...p, inventory: inv };
    });
  });
  render();
}

/*
  Anything the admin sets by hand is stamped ADMIN, and mergeActions() will
  not overwrite it. That matters for the very common case of correcting a
  misheard action over the phone: without the stamp, the player's own stale
  submission would silently undo the correction five seconds later.
*/
async function setAction(actorId, type, targetId, secondaryTargetId) {
  await commit((d) => {
    const list = (d.currentActions || []).filter((a) => a.actorId !== actorId);
    if (targetId || secondaryTargetId) {
      list.push({
        actorId, type,
        targetId: targetId || null,
        secondaryTargetId: secondaryTargetId || null,
        submittedAt: new Date().toISOString(),
        source: SOURCE.ADMIN
      });
    }
    d.currentActions = list;
  });
}

/* -------------------------------------------------------- MINIGAME ----- */

function viewMinigame(main) {
  const sel = S().currentMinigameId;
  const chosen = MINIGAMES.find((m) => m.id === sel);

  const card = el('div', 'card accent');
  card.innerHTML = `
    <h2>Minigame</h2>
    <p class="hint">${esc(PHASE_HINT.MINIGAME)}</p>
    ${chosen ? `<div class="okbox"><strong>${esc(chosen.name)}</strong> — ${esc(chosen.instructions)}</div>` : ''}
    <h3>Wheel</h3>
    <p class="faint">Spin to pick who chooses this week's game. Spirits take part; Dormant players do not.</p>
    <div class="btn-row" style="margin-top:8px">
      <button class="btn" id="spin">Spin the wheel</button>
      <span id="spinResult" class="badge out">No spin yet</span>
    </div>`;
  main.appendChild(card);

  card.querySelector('#spin').onclick = async () => {
    const pool = present().concat(spirits().filter((p) => p.attendanceStatus === E.ATTENDANCE.PRESENT));
    if (!pool.length) return toast('Nobody is present to spin for.', true);
    const rng = E.makeRng(Date.now() >>> 0);
    const pick = rng.pick(pool.map((p) => p.id), 'minigame wheel');
    card.querySelector('#spinResult').textContent = nameOf(pick) + ' chooses';
    card.querySelector('#spinResult').className = 'badge alive';
    await commit(() => {}, {
      eventType: 'WHEEL_SPIN', summary: `Wheel selected ${nameOf(pick)} to choose the game`
    });
  };

  const lib = el('div', 'card');
  lib.innerHTML = `<h2>Library</h2>
    <p class="hint">Backup games are quick to start when you are running short on time.</p>`;
  const table = el('table', '', `<thead><tr><th>Game</th><th>Format</th><th class="num">Mins</th>
    <th></th><th style="width:100px"></th></tr></thead><tbody></tbody>`);
  const tb = table.querySelector('tbody');
  for (const m of MINIGAMES) {
    const tr = el('tr', sel === m.id ? '' : '');
    tr.innerHTML = `
      <td><strong>${esc(m.name)}</strong><br><span class="faint">${esc(m.instructions)}</span></td>
      <td><span class="badge">${m.format === 'TEAM' ? 'Team' : 'Individual'}</span></td>
      <td class="num">${m.minutes}</td>
      <td>${m.backup ? '<span class="badge dormant">Backup</span>' : ''}</td>
      <td><button class="btn sm ${sel === m.id ? 'primary' : ''}">${sel === m.id ? 'Selected' : 'Launch'}</button></td>`;
    tr.querySelector('button').onclick = async () => {
      await commit((d) => { d.currentMinigameId = m.id; },
        { eventType: 'MINIGAME_LAUNCHED', summary: `Launched ${m.name}` });
    };
    tb.appendChild(tr);
  }
  lib.appendChild(table);
  main.appendChild(lib);
}

/* --------------------------------------------------------- REWARDS ----- */

function viewRewards(main) {
  const winners = new Set(S().currentWinners || []);

  const card = el('div', 'card accent');
  card.innerHTML = `
    <h2>Record minigame winners</h2>
    <p class="hint">${esc(PHASE_HINT.REWARDS)} Living winners take one Reward Token;
      spirits take ${settings().spiritPointsMinigameWin} Spirit Points instead.</p>
    <div class="warnbox">Anyone killed this week is still playing — they do not know yet.
      Award their token as normal.</div>
    <table><thead><tr><th>Player</th><th>State</th><th style="width:110px">Winner</th></tr></thead>
    <tbody id="wBody"></tbody></table>
    <div class="btn-row">
      <button class="btn primary" id="award">Award tokens &amp; points</button>
    </div>`;
  main.appendChild(card);

  const body = card.querySelector('#wBody');
  const pool = activeRoster().filter((p) => p.attendanceStatus === E.ATTENDANCE.PRESENT);
  for (const p of pool) {
    const dead = p.lifeStatus === E.LIFE.SPIRIT;
    const tr = el('tr');
    tr.innerHTML = `
      <td>${esc(p.displayName)}</td>
      <td>${dead ? '<span class="badge spirit">Spirit</span>' : '<span class="badge alive">Alive</span>'}</td>
      <td><input type="checkbox" ${winners.has(p.id) ? 'checked' : ''}></td>`;

    /*
      THE DOCTOR'S MISSING TOKEN.

      This handler used to fire store.commit() without awaiting it. The
      Rewards phase polls every 5 seconds, and a poll landing between the
      click and the write rebuilt this table from state the write had not
      reached - silently un-ticking the box. The admin saw a tick, pressed
      Award, and that player got nothing.

      commitQuiet() holds the `editing` latch for the duration of the write
      so the poll cannot redraw mid-flight, and the await means the state is
      committed before anything else can read it.
    */
    tr.querySelector('input').onchange = async (e) => {
      const checked = e.target.checked;
      const next = new Set(S().currentWinners || []);
      checked ? next.add(p.id) : next.delete(p.id);
      await commitQuiet((d) => { d.currentWinners = [...next]; });
    };
    body.appendChild(tr);
  }

  card.querySelector('#award').onclick = async () => {
    const ids = S().currentWinners || [];
    if (!ids.length) return toast('Select at least one winner.', true);
    if (S().currentRewardsPaid) return toast('Tokens already awarded this week.', true);

    /* Name everyone about to be paid. The failure mode here is silent - a
       missing tick pays nobody and says nothing - so the confirmation reads
       the list back before any token moves. */
    const names = ids.map(nameOf).join(', ');
    if (!(await confirmAction('Award tokens to these players?',
      `${names}. Anyone missing from that list gets nothing, and this can only be run once this week.`))) return;

    await commit((d) => {
      d.players = d.players.map((p) =>
        ids.includes(p.id) && p.lifeStatus === E.LIFE.ALIVE
          ? { ...p, rewardTokens: p.rewardTokens + 1 } : p);
      d.players = E.awardSpiritPoints(
        d.players,
        {
          attendedIds: d.players.filter((p) => p.attendanceStatus === E.ATTENDANCE.PRESENT).map((p) => p.id),
          minigameWinnerIds: ids
        },
        { ...E.DEFAULT_SETTINGS, ...(d.game.settings || {}) });
      d.currentRewardsPaid = true;
    }, {
      eventType: 'TOKENS_AWARDED',
      summary: `Tokens awarded to ${names}`,
      trackDiff: true
    });
    toast('Tokens and Spirit Points allocated.');
  };

  // --- purchases ---------------------------------------------------------
  const buy = el('div', 'card private');
  buy.innerHTML = `
    <h2>Private purchases</h2>
    <p class="hint">Every reward costs exactly one token. Take these privately and do not read them aloud.</p>
    <div class="inline">
      <label class="field" style="margin:0"><span>Player</span>
        <select id="buyWho"><option value="">— select —</option>${
          living().filter((p) => p.rewardTokens > 0).map((p) =>
            `<option value="${p.id}">${esc(p.displayName)} (${p.rewardTokens})</option>`).join('')
        }</select></label>
      <label class="field" style="margin:0"><span>Reward</span>
        <select id="buyWhat"><option value="">— select a player first —</option></select></label>
      <button class="btn" id="buyGo">Purchase</button>
    </div>
    <p class="faint" id="buyHint"></p>`;
  main.appendChild(buy);

  const who = buy.querySelector('#buyWho');
  const what = buy.querySelector('#buyWhat');
  const hint = buy.querySelector('#buyHint');
  who.onchange = () => {
    const p = byId(who.value);
    if (!p) { what.innerHTML = '<option value="">— select a player first —</option>'; hint.textContent = ''; return; }
    what.innerHTML = '<option value="">— select —</option>' +
      (E.STORE[p.role] || []).map((i) => `<option value="${i}">${esc(ITEM_LABEL[i])}</option>`).join('');
    hint.textContent = `${p.displayName} is a ${roleLabel(p.role)} with ${p.rewardTokens} token(s).`;
  };
  what.onchange = () => {
    const i = what.value;
    hint.textContent = i ? ITEM_HINT[i] : '';
  };
  buy.querySelector('#buyGo').onclick = () => purchase(who.value, what.value);

  purchaseQueue(main);
}

/*
  Requests players made from their own screen.

  A request is not a purchase. The design overview is explicit that a token is
  removed only after a valid purchase is accepted, so acceptance runs through
  the same engine.canPurchase and the same purchase() path as anything typed
  in above. That also keeps the console the single writer of tokens and
  inventory, which is what stops an admin save from trampling a purchase made
  while that save was in flight.
*/
function purchaseQueue(main) {
  if (!live) return;

  const card = el('div', 'card private');
  card.innerHTML = `
    <h2>Purchase requests
      ${pendingPurchases.length
        ? `<span class="badge dormant">${pendingPurchases.length} waiting</span>` : ''}</h2>
    <p class="hint">Sent privately from each player's screen. Nothing is charged until you
      accept, and the same rules are checked either way.</p>`;

  if (!pendingPurchases.length) {
    card.appendChild(el('p', 'empty', 'No requests waiting.'));
    main.appendChild(card);
    return;
  }

  const table = el('table', '', `<thead><tr>
    <th>Player</th><th>Reward</th><th class="num">Tokens</th><th style="width:180px"></th>
  </tr></thead><tbody></tbody>`);
  const tb = table.querySelector('tbody');

  for (const req of pendingPurchases) {
    const p = byId(req.playerId);
    const check = p
      ? E.canPurchase(p, req.rewardType, S().players, settings())
      : { ok: false, reason: 'No longer on the roster' };

    const tr = el('tr');
    tr.innerHTML = `
      <td>${esc(p ? p.displayName : 'Unknown')}</td>
      <td>${esc(ITEM_LABEL[req.rewardType] ?? req.rewardType)}
        ${check.ok ? '' : `<br><span class="faint">${esc(check.reason)}</span>`}</td>
      <td class="num tokens">${p ? p.rewardTokens : 0}</td>
      <td>
        <button class="btn sm ${check.ok ? 'primary' : ''}" ${check.ok ? '' : 'disabled'} data-yes>Accept</button>
        <button class="btn sm ghost" data-no>Reject</button>
      </td>`;

    tr.querySelector('[data-yes]').onclick = async () => {
      await purchase(req.playerId, req.rewardType);
      await live.decidePurchase(req.id, 'ACCEPTED');
      pendingPurchases = pendingPurchases.filter((x) => x.id !== req.id);
      render();
    };

    tr.querySelector('[data-no]').onclick = async () => {
      await live.decidePurchase(req.id, 'REJECTED',
        check.ok ? 'Declined by admin' : check.reason);
      pendingPurchases = pendingPurchases.filter((x) => x.id !== req.id);
      await commit(() => {}, {
        eventType: 'PURCHASE_REJECTED',
        actorId: req.playerId,
        summary: `${p ? p.displayName : 'Unknown'} was refused ${ITEM_LABEL[req.rewardType] ?? req.rewardType}`
      });
    };

    tb.appendChild(tr);
  }

  card.appendChild(table);
  main.appendChild(card);
}

async function purchase(playerId, itemType) {
  const p = byId(playerId);
  if (!p || !itemType) return toast('Select a player and a reward.', true);
  const check = E.canPurchase(p, itemType, S().players, settings());
  if (!check.ok) return toast(check.reason, true);
  const round = S().game.currentRound;

  if (itemType === E.ITEM.RECRUIT_NEW_MAFIA) {
    return openModal(`
      <h2>Recruit new Mafia</h2>
      <p class="hint">Pick the living non-Mafia player to convert, or leave blank for a random choice.
        Blocked above ${settings().maxActiveMafiaFromRecruit} active Mafia.</p>
      <label class="field"><span>Target</span>
        ${targetSelect('t', null, { pool: living().filter((x) => x.role !== E.ROLE.MAFIA), blank: '— random —' })}
      </label>
      <div class="btn-row"><button class="btn primary" data-go>Recruit</button>
      <button class="btn ghost" data-cancel>Cancel</button></div>`, (root, close) => {
      root.querySelector('[data-cancel]').onclick = close;
      root.querySelector('[data-go]').onclick = async () => {
        let target = root.querySelector('select').value;
        if (!target) {
          const pool = living().filter((x) => x.role !== E.ROLE.MAFIA).map((x) => x.id);
          target = rngFor('recruit').pick(pool, 'random recruit');
        }
        const r = E.recruitMafia(S(), target, settings());
        if (!r.ok) { close(); return toast(r.reason, true); }
        await commit((d) => {
          d.players = r.players.map((x) =>
            x.id === playerId ? { ...x, rewardTokens: x.rewardTokens - 1 } : x);
        }, { eventType: 'PURCHASE', actorId: playerId,
             summary: `${p.displayName} recruited ${nameOf(target)} into the Mafia`, trackDiff: true });
        close();
        toast(`${nameOf(target)} is now Mafia. Tell them privately.`);
      };
    });
  }

  await commit((d) => {
    d.players = d.players.map((x) => {
      if (x.id !== playerId) return x;
      const next = { ...x, rewardTokens: x.rewardTokens - 1 };
      next.inventory = [...(x.inventory || []), newInventoryItem(itemType, round)];
      return next;
    });
  }, { eventType: 'PURCHASE', actorId: playerId,
       summary: `${p.displayName} purchased ${ITEM_LABEL[itemType]}` });
  toast(`${ITEM_LABEL[itemType]} purchased. Usable from week ${round + 1}.`);
}

/* ------------------------------------------------------ RESOLUTION ----- */

function viewResolution(main) {
  const pending = S().pendingPublicEvent;

  if (!pending) {
    const card = el('div', 'card accent');
    card.innerHTML = `
      <h2>Preview the outcome</h2>
      <p class="hint">${esc(PHASE_HINT.RESOLUTION)}</p>
      <p class="faint">Nothing is committed until you publish. You can rewind and change actions first.</p>
      <div class="btn-row"><button class="btn primary" id="prev">Preview resolution</button></div>
      <div id="previewBox"></div>`;
    main.appendChild(card);

    card.querySelector('#prev').onclick = () => {
      const res = E.resolveHiddenActions(S(), rngFor('resolve'));
      const box = card.querySelector('#previewBox');
      box.innerHTML = `
        <h3>Preview — not yet published</h3>
        <div class="${res.death ? 'warnbox' : 'okbox'}">
          ${res.death
            ? `<strong>${esc(nameOf(res.death))}</strong> will be killed.`
            : res.blockedBy === 'IMMUNITY' ? 'No death — the target was immune.'
            : 'No death this week.'}
        </div>
        <div class="btn-row">
          <button class="btn primary" id="publish">Publish this outcome</button>
          <button class="btn ghost" id="redo">Discard preview</button>
        </div>`;
      box.querySelector('#redo').onclick = () => { box.innerHTML = ''; };
      box.querySelector('#publish').onclick = async () => {
        if (!(await confirmAction('Publish the outcome?',
          'The death or no-death result is announced now and cannot be quietly undone.'))) return;
        await publishResolution(res);
      };
    };
    return;
  }

  // Already published
  const card = el('div', 'card');
  card.innerHTML = `<h2>Published</h2>`;
  const rev = el('div', 'reveal ' + (pending.type === 'DEATH' ? 'death' : 'safe'), `
    <div class="kicker">Week ${S().game.currentRound}</div>
    <div class="headline">${esc(pending.text)}</div>
    ${pending.revealAlignment && pending.alignment
      ? `<div class="detail">Alignment revealed: ${esc(pending.alignment)}</div>` : ''}`);
  card.appendChild(rev);
  card.appendChild(el('p', 'faint',
    'Advance to the Master phase when ready.'));
  main.appendChild(card);
}

async function publishResolution(res) {
  await commit((d) => {
    d.pendingPublicEvent = res.publicEvent;
    d.privateEvents = [...(d.privateEvents || []), ...res.privateEvents];

    if (res.death) {
      d.players = E.killPlayer(d.players, res.death);
    }

    // Consume staged and expiring items.
    const round = d.game.currentRound;
    d.players = d.players.map((p) => ({
      ...p,
      inventory: (p.inventory || []).map((i) =>
        i.status === 'STAGED' && i.stagedRound === round
          ? { ...i, status: 'USED', usedRound: round } : i)
    }));
  }, {
    eventType: 'RESOLUTION_PUBLISHED',
    summary: res.death ? `${nameOf(res.death)} was killed` : 'No death this week',
    trackDiff: true
  });

  /* Delivers anything addressed to one player to their own screen. With the
     Sheriff retired the engine produces none, but the path is kept so a
     future private result needs no plumbing. */
  if (live && res.privateEvents?.length) {
    const sent = await live.pushPrivateEvents(S().game.currentRound, res.privateEvents);
    if (!sent.ok) {
      toast('Private results could not be delivered online — read them out instead.', true);
    }
  }

  // Legacy may fire if that death removed the last Mafia.
  await runLegacyAndEndgame();
}

async function runLegacyAndEndgame() {
  const legacy = E.checkMafiaLegacy(S(), rngFor('legacy'));
  if (legacy.triggered) {
    await commit((d) => { d.players = legacy.players; d.game = { ...d.game, legacyUsed: true }; },
      { eventType: 'MAFIA_LEGACY',
        summary: `Mafia Legacy triggered — a new Mafia was chosen`, trackDiff: true });
    openModal(`
      <h2>Mafia Legacy has triggered</h2>
      <p class="hint">The last Mafia was eliminated, so one Civilian has been converted.
        This can only ever happen once.</p>
      <div class="warnbox">Tell <strong>${esc(nameOf(legacy.chosenId))}</strong> privately
        that they are now Mafia. Announce nothing publicly.</div>
      <div class="btn-row"><button class="btn primary" data-ok>Understood</button></div>`,
      (root, close) => { root.querySelector('[data-ok]').onclick = close; });
  }

  const end = E.checkEndgame(S());
  if (end.finished) {
    await commit((d) => {
      d.game = { ...d.game, status: E.PHASE.FINISHED, winner: end.winner };
    }, { eventType: 'GAME_FINISHED', summary: `${end.winner} wins — ${end.reason}`, trackDiff: true });
  }
}

/* ---------------------------------------------------------- MASTER ----- */

function viewMaster(main) {
  if (!settings().masterEnabled) {
    main.appendChild(el('div', 'card', `<h2>Master not in play</h2>
      <p class="hint">Enable the Master role in Settings if you want to use it.</p>`));
    return;
  }

  const m = S().currentMaster || {};
  const card = el('div', 'card private');
  card.innerHTML = `
    <h2>Master intervention</h2>
    <p class="hint">${esc(PHASE_HINT.MASTER)} Both selections apply to this round's public vote only.</p>
    <label class="field"><span>Vote immunity — cannot be eliminated this vote</span>
      ${targetSelect('immune', m.immunePlayerId)}</label>
    <label class="field"><span>Double vote — their ballot counts twice</span>
      ${targetSelect('dbl', m.doubleVotePlayerId)}</label>
    <div class="okbox">Keep both selections private. The vote totals will not reveal them.</div>`;
  main.appendChild(card);

  const [a, b] = card.querySelectorAll('select');
  a.onchange = async () => {
    await commitQuiet((d) => {
      d.currentMaster = { ...(d.currentMaster || {}), immunePlayerId: a.value || null };
    });
    toast('Immunity recorded privately.');
  };
  b.onchange = async () => {
    await commitQuiet((d) => {
      d.currentMaster = { ...(d.currentMaster || {}), doubleVotePlayerId: b.value || null };
    });
    toast('Double vote recorded privately.');
  };
}

/* -------------------------------------------------- DISCUSS & VOTE ----- */
/*
  One phase, one clock. Everyone talks and votes whenever they are ready.
  The clock lives in state (voteTimer) and, online, in the vote_timer table
  so every player screen counts down to the same moment.
    running: { round, endsAt: ISO time, remaining }
    paused:  { round, endsAt: null,     remaining: seconds left }
*/

let clockHandle = null;

const voteSeconds = () => Math.max(60, Math.round((Number(settings().voteMinutes) || 5) * 60));

function timerLeft(t = S().voteTimer) {
  if (!t || t.round !== S().game.currentRound) return voteSeconds();
  if (t.endsAt) return Math.max(0, Math.ceil((Date.parse(t.endsAt) - Date.now()) / 1000));
  return Math.max(0, t.remaining ?? voteSeconds());
}

const fmtClock = (sec) =>
  `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

async function setVoteTimer({ endsAt = null, remaining }) {
  const round = S().game.currentRound;
  const t = { round, endsAt, remaining };
  await commitQuiet((d) => { d.voteTimer = t; });
  if (live) {
    const r = await live.pushVoteTimer(round, t);
    if (!r.ok) toast(`Timer not shared with players (${r.reason}). Run voting.sql in Supabase.`, true);
  }
}

const startVoteTimer = (secs = timerLeft()) =>
  setVoteTimer({ endsAt: new Date(Date.now() + secs * 1000).toISOString(), remaining: secs });
const pauseVoteTimer = () => setVoteTimer({ endsAt: null, remaining: timerLeft() });
const resetVoteTimer = () => setVoteTimer({ endsAt: null, remaining: voteSeconds() });
const addVoteTime = (secs) => {
  const t = S().voteTimer;
  const left = timerLeft() + secs;
  return t?.endsAt ? startVoteTimer(left) : setVoteTimer({ endsAt: null, remaining: left });
};

/** Weight a ballot really carries. Shown to the admin only. */
const ballotWeight = (voterId) => {
  const p = byId(voterId);
  return 1 + (p && isStaged(p, E.ITEM.EXTRA_VOTE) ? 1 : 0)
           + (S().currentMaster?.doubleVotePlayerId === voterId ? 1 : 0);
};

/**
 * The Among Us style board: one tile per player who can be voted for, with
 * the names of everyone voting for them stacked underneath. Players see the
 * same board on their own screens, minus the weight markers.
 */
function voteBoard(ballots, candidates, { title = 'Vote board', final = false, out = null } = {}) {
  const card = el('div', 'card');
  const byTarget = new Map();
  for (const b of ballots) {
    if (!b.targetId) continue;
    if (!byTarget.has(b.targetId)) byTarget.set(b.targetId, []);
    byTarget.get(b.targetId).push(b.voterId);
  }
  const voted = new Set(ballots.map((b) => b.voterId));
  const top = Math.max(0, ...[...byTarget.values()].map((v) => v.length));

  card.innerHTML = `
    <h2>${esc(title)}
      <span class="badge ${voted.size >= candidates.length ? 'alive' : 'dormant'}">${voted.size} of ${candidates.length} voted</span></h2>
    <p class="hint">${final
      ? 'Final ballots. The result above includes hidden weights, so it can differ from a simple count.'
      : 'This is what every player sees. The ×2 markers are hidden weights — only you can see them.'}</p>
    <div class="vote-board">${candidates.map((p) => {
      const vs = byTarget.get(p.id) || [];
      const lead = vs.length && vs.length === top;
      return `<div class="vote-tile${vs.length ? ' has-votes' : ''}${lead ? ' leading' : ''}">
        <div class="vote-head">
          <span class="vote-name">${esc(p.displayName)}</span>
          ${out && out.id === p.id
            ? `<span class="badge ${out.role === E.ROLE.MAFIA ? 'mafia' : 'good'}">Out · ${esc(roleLabel(out.role))}</span>` : ''}
          ${voted.has(p.id) ? '<span class="voted-tag">Voted</span>' : ''}
          <span class="vote-count">${vs.length || ''}</span>
        </div>
        <div class="vote-chips">${vs.length
          ? vs.map((v) => {
              const w = ballotWeight(v);
              return `<span class="vote-chip">${esc(nameOf(v))}${w > 1 ? ` <b>×${w}</b>` : ''}</span>`;
            }).join('')
          : '<span class="vote-none">No votes</span>'}</div>
      </div>`;
    }).join('')}</div>`;
  return card;
}

function viewVoting(main) {
  const ballots = S().currentBallots || [];
  const voters = present();
  const t = S().voteTimer?.round === S().game.currentRound ? S().voteTimer : null;
  const running = !!t?.endsAt;
  const left = timerLeft();

  // --- clock ---------------------------------------------------------------
  const clock = el('div', 'card accent');
  clock.innerHTML = `
    <h2>Discuss &amp; vote</h2>
    <p class="hint">${esc(PHASE_HINT.VOTING)}</p>
    <div class="timer${left === 0 ? ' done' : ''}" id="clock">${fmtClock(left)}</div>
    <p class="faint" style="text-align:center;margin:-6px 0 0">${
      running ? 'Running on every screen' : left === 0 ? "Time's up" : 'Paused'}</p>
    <div class="btn-row" style="justify-content:center">
      ${running
        ? '<button class="btn" id="tPause">Pause</button>'
        : `<button class="btn primary" id="tStart" ${left === 0 ? 'disabled' : ''}>${
            t && left < voteSeconds() ? 'Resume' : 'Start'}</button>`}
      <button class="btn" id="tAdd">+1 min</button>
      <button class="btn ghost" id="tReset">Reset to ${fmtClock(voteSeconds())}</button>
    </div>`;
  main.appendChild(clock);

  clock.querySelector('#tAdd').onclick = async () => { await addVoteTime(60); render(); };
  clock.querySelector('#tReset').onclick = async () => { await resetVoteTimer(); render(); };
  const startBtn = clock.querySelector('#tStart');
  if (startBtn) startBtn.onclick = async () => { await startVoteTimer(); render(); };
  const pauseBtn = clock.querySelector('#tPause');
  if (pauseBtn) pauseBtn.onclick = async () => { await pauseVoteTimer(); render(); };

  if (running) {
    let warned = left === 0;
    clockHandle = setInterval(() => {
      const c = document.getElementById('clock');
      if (!c) { clearInterval(clockHandle); clockHandle = null; return; }
      const l = timerLeft();
      c.textContent = fmtClock(l);
      c.classList.toggle('done', l === 0);
      if (l === 0 && !warned) {
        warned = true;
        toast("Time's up. Players can no longer vote from their screens — tally when ready.");
        render();
      }
    }, 500);
  }

  // --- who is still to vote, then the board -------------------------------
  main.appendChild(liveBanner(voters, new Set(ballots.map((b) => b.voterId)), 'vote'));
  main.appendChild(voteBoard(ballots, voters));

  // --- admin entry / correction -------------------------------------------
  const card = el('div', 'card private');
  card.innerHTML = `
    <h2>Enter or change a vote</h2>
    <p class="hint">For anyone with a technical issue. ${live
      ? 'Changes go straight to every screen. If the player votes again later, their new vote replaces yours.'
      : 'Offline mode — every vote is entered here.'}</p>
    <div class="action-grid" id="vGrid"></div>`;
  main.appendChild(card);

  const grid = card.querySelector('#vGrid');
  for (const v of voters) {
    const cur = ballots.find((b) => b.voterId === v.id);
    const extra = isStaged(v, E.ITEM.EXTRA_VOTE);
    const weight = ballotWeight(v.id);
    const row = el('div', 'action-row' + (cur ? ' submitted' : ''));
    row.innerHTML = `
      <div class="who">${esc(v.displayName)}<small>${weight > 1 ? `weight ${weight}` : 'weight 1'}</small></div>
      ${targetSelect('t', cur?.targetId, { exclude: [], blank: '— no vote —' })}
      <span class="badge ${cur ? 'alive' : 'out'}">${sourceLabel(cur, 'Cast')}</span>`;
    row.querySelector('select').onchange = (e) => setBallot(v.id, e.target.value);
    grid.appendChild(row);

    if (ownsUsable(v, E.ITEM.EXTRA_VOTE) || extra) {
      grid.appendChild(stageToggle(v, E.ITEM.EXTRA_VOTE));
    }
  }

  // --- vote manipulation (unchanged) --------------------------------------
  const mafiaWithVM = present().filter(
    (p) => p.role === E.ROLE.MAFIA && (ownsUsable(p, E.ITEM.VOTE_MANIPULATION) || isStaged(p, E.ITEM.VOTE_MANIPULATION)));
  if (mafiaWithVM.length) {
    const vm = S().currentManipulation;
    const mcard = el('div', 'card private');
    mcard.innerHTML = `
      <h2>Vote Manipulation</h2>
      <p class="hint">One anonymous adjustment. Never shown on the board — only in the final count.</p>
      <label class="field"><span>Target</span>${targetSelect('t', vm?.targetId)}</label>
      <label class="field"><span>Adjustment</span>
        <select data-field="d">
          <option value="1"${vm?.delta === 1 ? ' selected' : ''}>+1 vote</option>
          <option value="-1"${vm?.delta === -1 ? ' selected' : ''}>&minus;1 vote</option>
        </select></label>`;
    main.appendChild(mcard);
    const [t2, d] = mcard.querySelectorAll('select');
    const save = () => commitQuiet((st) => {
      st.currentManipulation = t2.value ? { targetId: t2.value, delta: Number(d.value) } : null;
    });
    t2.onchange = save; d.onchange = save;
  }

  // --- tally ---------------------------------------------------------------
  const go = el('div', 'card');
  go.innerHTML = `<div class="btn-row" style="margin:0">
    <button class="btn primary" id="tally">Tally the vote</button></div>
    <p class="faint" style="margin-top:10px">${ballots.length} of ${voters.length} votes in.
      Tallying ends the phase and applies hidden weights, immunity and manipulation.</p>`;
  main.appendChild(go);

  go.querySelector('#tally').onclick = async () => {
    /* One last sync before the tally. A vote cast between the last poll and
       this click would otherwise be left out of a count that cannot re-run. */
    if (live) await pollNow({ silent: false });
    const finalBallots = S().currentBallots || [];
    if (!finalBallots.length) return toast('No votes in yet.', true);
    const missing = voters.length - finalBallots.length;
    if (missing > 0 && !(await confirmAction(`Tally with ${missing} vote(s) missing?`,
      'Anyone who has not voted is counted as abstaining. You can rewind afterwards, but the result is recorded now.'))) return;

    const res = E.resolveVote(S(), finalBallots, S().currentMaster || {}, S().currentManipulation);
    await commit((d) => {
      d.currentVoteResult = res;
      d.game.status = E.PHASE.RESULTS;
      if (d.voteTimer) d.voteTimer = { ...d.voteTimer, endsAt: null, remaining: 0 };
    });
    if (live) live.pushVoteTimer(S().game.currentRound, { endsAt: null, remaining: 0 });
  };
}

/*
  Online, an admin vote is written to the ballots table like any other, so
  the board on every screen shows it and the tally counts it. Offline it
  lives in state only, exactly as before.
*/
async function setBallot(voterId, targetId) {
  if (live) {
    const r = await live.setBallot(S().game.currentRound, voterId, targetId || null);
    if (!r.ok) {
      render();
      return toast(`Could not save that vote online (${r.reason}). Run voting.sql in Supabase.`, true);
    }
    await pollNow();
    render();
    return;
  }
  await commit((d) => {
    const list = (d.currentBallots || []).filter((b) => b.voterId !== voterId);
    if (targetId) list.push({ voterId, targetId, source: SOURCE.ADMIN });
    d.currentBallots = list;
  });
}

/* --------------------------------------------------------- RESULTS ----- */

function viewResults(main) {
  const res = S().currentVoteResult;
  if (!res) {
    main.appendChild(el('div', 'card', `<h2>No vote recorded</h2>
      <p class="hint">Rewind to the voting phase to enter ballots.</p>`));
    return;
  }

  const card = el('div', 'card');
  card.innerHTML = '<h2>Vote result</h2>';
  const rev = el('div', 'reveal ' + (res.eliminated ? 'death' : 'safe'), `
    <div class="kicker">Week ${S().game.currentRound} · public vote</div>
    <div class="headline">${res.eliminated
      ? `${esc(nameOf(res.eliminated))} is eliminated`
      : 'No elimination'}</div>
    <div class="detail">${res.eliminated
      ? `They were <strong>${esc(roleLabel(res.revealedRole))}</strong> — every player's screen shows this now.`
      : res.tie ? 'The vote was tied.' : 'No eligible target.'}</div>`);
  card.appendChild(rev);

  const rows = Object.entries(res.totals).sort((a, b) => b[1] - a[1]);
  if (rows.length) {
    const t = el('table', '', `<thead><tr><th>Player</th><th class="num">Votes</th><th></th></tr></thead>
      <tbody>${rows.map(([id, n]) => `<tr>
        <td>${esc(nameOf(id))}</td><td class="num tokens">${n}</td>
        <td>${res.shielded.includes(id) ? '<span class="badge dormant">Immune</span>' : ''}</td>
      </tr>`).join('')}</tbody>`);
    card.appendChild(t);
  }
  main.appendChild(card);

  /* Keep the voted-out player on the board after Apply elimination turns them
     into a Spirit, so their tile and role tag do not vanish. */
  const outP = res.eliminated ? byId(res.eliminated) : null;
  const boardPlayers = outP && !present().some((p) => p.id === outP.id)
    ? [...present(), outP] : present();
  main.appendChild(voteBoard(S().currentBallots || [], boardPlayers,
    { title: 'Final votes', final: true,
      out: outP ? { id: outP.id, role: res.revealedRole } : null }));
  if (res.eliminated && byId(res.eliminated)?.lifeStatus === E.LIFE.ALIVE) {
    const apply = el('div', 'card accent');
    apply.innerHTML = `<h2>Apply the elimination</h2>
      <p class="hint">This commits the death and checks Legacy and victory.</p>
      <div class="btn-row"><button class="btn primary" id="applyEl">Apply elimination</button></div>`;
    main.appendChild(apply);

    apply.querySelector('#applyEl').onclick = async () => {
      await commit((d) => {
        d.players = E.killPlayer(d.players, res.eliminated);
      }, { eventType: 'ELIMINATION',
           summary: `${nameOf(res.eliminated)} was voted out (${roleLabel(res.revealedRole)})`,
           trackDiff: true });

      await runLegacyAndEndgame();
    };
  } else {
    main.appendChild(el('div', 'card', `<h2>Ready to close</h2>
      <p class="hint">Use <strong>Close session</strong> in the sidebar. Balances and roles persist.</p>`));
  }
}

/* -------------------------------------------------------- FINISHED ----- */

function viewFinished(main) {
  const g = S().game;
  const card = el('div', 'card');
  card.innerHTML = '<h2>Game over</h2>';
  card.appendChild(el('div', 'reveal ' + (g.winner === 'GOOD' ? 'safe' : 'death'), `
    <div class="kicker">Final result</div>
    <div class="headline">${g.winner === 'GOOD' ? 'The town wins' : 'The Mafia win'}</div>
    <div class="detail">After ${g.currentRound} week${g.currentRound === 1 ? '' : 's'}.</div>`));
  main.appendChild(card);

  const reveal = el('div', 'card');
  reveal.innerHTML = `<h2>Full reveal</h2>
    <table><thead><tr><th>Player</th><th>Final role</th><th>State</th>
    <th class="num">Tokens</th></tr></thead><tbody>${
      activeRoster().map((p) => `<tr>
        <td>${esc(p.displayName)}</td>
        <td><span class="badge ${p.role === E.ROLE.MAFIA ? 'mafia' : 'good'}">${esc(roleLabel(p.role))}</span></td>
        <td>${p.lifeStatus === E.LIFE.ALIVE ? 'Survived' : 'Spirit'}</td>
        <td class="num tokens">${p.rewardTokens}</td>
      </tr>`).join('')}</tbody></table>`;
  main.appendChild(reveal);

  const again = el('div', 'card danger');
  again.innerHTML = `<h2>Start a new game</h2>
    <p class="hint">Keep the same players and logins, or wipe everything.</p>
    <div class="btn-row"><button class="btn danger" id="reset">Reset…</button></div>`;
  main.appendChild(again);
  again.querySelector('#reset').onclick = openResetPanel;
}

/* ==================================================== PHASE CONTROL ==== */

async function advancePhase() {
  const g = S().game;

  if (g.status === E.PHASE.CLOSED) {
    if (activeRoster().length < 3) return toast('Add players before opening a session.', true);
    await commit((d) => {
      d.game.currentRound += 1;
      d.game.status = E.PHASE.ATTENDANCE;
      d.currentActions = [];
      d.currentBallots = [];
      d.currentMaster = { immunePlayerId: null, doubleVotePlayerId: null };
      d.currentManipulation = null;
      d.currentWinners = [];
      d.currentMinigameId = null;
      d.currentVoteResult = null;
      d.currentRewardsPaid = false;
      d.pendingPublicEvent = null;
      d.voteTimer = null;
      if (d.game.countdownEnabled && d.game.roundsRemaining != null) {
        d.game.roundsRemaining = Math.max(0, d.game.roundsRemaining - 1);
      }
    }, { eventType: 'SESSION_OPENED', summary: `Week ${g.currentRound + 1} opened` });

    /* Wipe any submissions sitting against this week number. Without this, a
       rewound-and-reopened week would read last week's choices as this week's
       intent — the quietest possible way to kill the wrong person. */
    if (live) {
      const cleared = await live.clearRound(S().game.currentRound);
      if (!cleared.ok) toast('Could not clear last week online: ' + cleared.reason, true);
    }
    return;
  }

  if (g.status === E.PHASE.RESULTS) {
    await closeSession();
    return;
  }

  // Guard rails — warn, but never block the admin.
  if (g.status === E.PHASE.RESOLUTION && !S().pendingPublicEvent) {
    if (!(await confirmAction('Advance without publishing?',
      'No resolution has been published this week. The death or no-death result will be skipped.'))) return;
  }

  if (g.status === E.PHASE.REWARDS && !S().currentRewardsPaid && (S().currentWinners || []).length) {
    if (!(await confirmAction('Advance without awarding tokens?',
      'Winners are ticked but Award tokens & points has not been pressed. Nobody has been paid.'))) return;
  }

  await commit((d) => { d.game.status = E.nextPhase(d.game.status); });

  /* Entering Discuss & vote starts the clock on every screen. Only the first
     time this week - rewinding and coming back leaves it as it was. */
  if (S().game.status === E.PHASE.VOTING &&
      S().voteTimer?.round !== S().game.currentRound) {
    await startVoteTimer(voteSeconds());
    render();
  }
}

async function closeSession() {
  const res = S().currentVoteResult;
  const pub = S().pendingPublicEvent;
  const summary = [
    pub ? pub.text : null,
    res?.eliminated ? `${nameOf(res.eliminated)} was voted out (${roleLabel(res.revealedRole)}).`
      : res ? 'The vote produced no elimination.' : null
  ].filter(Boolean).join(' ');

  await commit((d) => {
    d.rounds = [...(d.rounds || []), {
      number: d.game.currentRound,
      publicSummary: summary || 'No public result recorded.',
      closedAt: new Date().toISOString()
    }];
    d.game.status = E.PHASE.CLOSED;
    // Reactivate dormant players for next week; keep roles and balances.
    d.players = d.players.map((p) =>
      p.attendanceStatus === E.ATTENDANCE.DORMANT
        ? { ...p, attendanceStatus: E.ATTENDANCE.PRESENT } : p);
    d.currentActions = [];
    d.currentBallots = [];
    d.currentVoteResult = null;
    d.currentManipulation = null;
    d.voteTimer = null;
    d.currentMaster = { immunePlayerId: null, doubleVotePlayerId: null };
  }, { eventType: 'SESSION_CLOSED', summary: `Week ${S().game.currentRound} closed` });

  toast('Session closed. Nothing will change until you open the next one.');
}

async function rewindPhase() {
  if (!(await confirmAction('Rewind a phase?',
    'Data already entered is kept, but anything published stays published.'))) return;
  await commit((d) => { d.game.status = E.previousPhase(d.game.status); },
    { eventType: 'PHASE_REWIND', summary: 'Admin rewound a phase' });
}

/* ================================================ PLAYER OVERRIDES ===== */

function openPlayerModal(id) {
  const p = byId(id);
  if (!p) return;
  const inv = (p.inventory || []).filter((i) => i.status !== 'USED');

  openModal(`
    <h2>${esc(p.displayName)}</h2>
    <p class="hint">Manual override. A reason is recorded in the audit log.</p>
    <label class="field"><span>Role</span>
      <select id="mRole">${Object.values(E.ROLE).map((r) =>
        `<option value="${r}"${p.role === r ? ' selected' : ''}>${esc(roleLabel(r))}</option>`).join('')}</select></label>
    <label class="field"><span>Life status</span>
      <select id="mLife">
        <option value="ALIVE"${p.lifeStatus === 'ALIVE' ? ' selected' : ''}>Alive</option>
        <option value="SPIRIT"${p.lifeStatus === 'SPIRIT' ? ' selected' : ''}>Spirit</option>
      </select></label>
    <label class="field"><span>Attendance</span>
      <select id="mAtt">
        <option value="PRESENT"${p.attendanceStatus === 'PRESENT' ? ' selected' : ''}>Present</option>
        <option value="DORMANT"${p.attendanceStatus === 'DORMANT' ? ' selected' : ''}>Dormant</option>
        <option value="INACTIVE"${p.attendanceStatus === 'INACTIVE' ? ' selected' : ''}>Left permanently</option>
      </select></label>
    <div class="inline">
      <label class="field"><span>Reward tokens</span>
        <input type="number" id="mTok" min="0" value="${p.rewardTokens}"></label>
      <label class="field"><span>Spirit points</span>
        <input type="number" id="mSp" min="0" value="${p.spiritPoints}"></label>
    </div>
    <h3>Inventory</h3>
    ${inv.length ? `<ul class="feed">${inv.map((i) =>
      `<li>${esc(ITEM_LABEL[i.rewardType] || i.rewardType)}
        <span class="badge ${i.status === 'STAGED' ? 'dormant' : 'out'}">${i.status}</span></li>`).join('')}</ul>`
      : '<p class="empty">Nothing held.</p>'}
    ${p.flags?.revealAlignmentOnDeath ? '<p class="faint">Alignment will be revealed on death.</p>' : ''}
    <label class="field"><span>Reason for change</span>
      <input type="text" id="mWhy" placeholder="e.g. corrected a misheard action"></label>
    <div class="btn-row">
      <button class="btn primary" id="mSave">Save override</button>
      <button class="btn ghost" id="mCancel">Cancel</button>
    </div>
    <h3>Remove</h3>
    <p class="faint">For duplicates and mistakes only. Deletes the player and their
      login link. For someone who has stopped coming, use Attendance, then
      Left permanently instead.</p>
    <div class="btn-row" style="margin-top:6px">
      <button class="btn danger sm" id="mRemove">Remove ${esc(p.displayName)}</button>
    </div>`, (root, close) => {
    root.querySelector('#mCancel').onclick = close;
    root.querySelector('#mRemove').onclick = async () => {
      close();
      if (!(await confirmAction(`Remove ${p.displayName}?`,
        'Deletes this seat and its login link. This cannot be undone.'))) return;
      /* Database first, so a failed delete cannot leave an orphan row. */
      if (typeof adapter.removePlayer === 'function') {
        const r = await adapter.removePlayer(id);
        if (!r.ok) return toast('Could not remove: ' + r.reason, true);
      }
      await commit((d) => {
        d.players = d.players.filter((x) => x.id !== id);
        d.currentActions = (d.currentActions || []).filter(
          (a) => a.actorId !== id && a.targetId !== id && a.secondaryTargetId !== id);
        d.currentBallots = (d.currentBallots || []).filter(
          (b) => b.voterId !== id && b.targetId !== id);
        d.currentWinners = (d.currentWinners || []).filter((w) => w !== id);
      }, { eventType: 'PLAYER_REMOVED', summary: `${p.displayName} removed from the roster` });
      toast(`${p.displayName} removed.`);
    };
    root.querySelector('#mSave').onclick = async () => {
      const role = root.querySelector('#mRole').value;
      const life = root.querySelector('#mLife').value;
      const att = root.querySelector('#mAtt').value;
      const tok = Math.max(0, Number(root.querySelector('#mTok').value) || 0);
      const sp = Math.max(0, Number(root.querySelector('#mSp').value) || 0);
      const why = root.querySelector('#mWhy').value.trim();
      if (!why) return toast('Give a reason — it goes in the audit log.', true);

      await commit((d) => {
        d.players = d.players.map((x) => x.id === id ? {
          ...x, role, alignment: E.alignmentOf(role),
          lifeStatus: life, attendanceStatus: att,
          rewardTokens: tok, spiritPoints: sp
        } : x);
      }, { eventType: 'ADMIN_OVERRIDE', actorId: id,
           summary: `${p.displayName} edited — ${why}`, reason: why, trackDiff: true });
      close();
      toast('Override saved and logged.');
      await runLegacyAndEndgame();
    };
  });
}

/* ======================================================== SETTINGS ===== */

function openSettings() {
  const s = settings();
  const g = S().game;
  const numeric = ['spiritPointsAttendance',
    'spiritPointsMinigameWin', 'resurrectionCost', 'resurrectionDiscountedCost',
    'maxActiveMafiaFromRecruit', 'voteMinutes'];

  openModal(`
    <h2>Settings</h2>
    <p class="hint">Defaults follow the design document. Change these only deliberately.</p>
    ${numeric.map((k) => `<label class="field"><span>${esc(SETTING_LABEL[k])}</span>
      <input type="number" step="1"
        min="0" data-set="${k}" value="${s[k]}"></label>`).join('')}
    <label class="field"><span>${esc(SETTING_LABEL.voteManipulationDirection)}</span>
      <select data-set="voteManipulationDirection">
        <option value="1"${s.voteManipulationDirection === 1 ? ' selected' : ''}>Add a vote (+1)</option>
        <option value="-1"${s.voteManipulationDirection === -1 ? ' selected' : ''}>Remove a vote (&minus;1)</option>
      </select></label>
    <div class="checkline"><input type="checkbox" id="setImm" ${s.tempImmunityCoversVote ? 'checked' : ''}>
      <label for="setImm">${esc(SETTING_LABEL.tempImmunityCoversVote)}</label></div>
    <div class="checkline"><input type="checkbox" id="setMaster" ${s.masterEnabled ? 'checked' : ''}>
      <label for="setMaster">${esc(SETTING_LABEL.masterEnabled)}</label></div>
    <h3>Countdown mode</h3>
    <div class="checkline"><input type="checkbox" id="cdOn" ${g.countdownEnabled ? 'checked' : ''}>
      <label for="cdOn">Countdown active</label></div>
    <div class="inline">
      <label class="field"><span>Rounds remaining</span>
        <input type="number" id="cdN" min="0" value="${g.roundsRemaining ?? 3}"></label>
    </div>
    <div class="checkline"><input type="checkbox" id="cdLeg" ${g.countdownDisablesLegacy ? 'checked' : ''}>
      <label for="cdLeg">Countdown disables an unused Mafia Legacy</label></div>
    <div class="btn-row">
      <button class="btn primary" id="sSave">Save settings</button>
      <button class="btn ghost" id="sCancel">Cancel</button>
    </div>`, (root, close) => {
    root.querySelector('#sCancel').onclick = close;
    root.querySelector('#sSave').onclick = async () => {
      const next = {};
      root.querySelectorAll('[data-set]').forEach((n) => {
        next[n.dataset.set] = Number(n.value);
      });
      next.tempImmunityCoversVote = root.querySelector('#setImm').checked;
      next.masterEnabled = root.querySelector('#setMaster').checked;
      const cdOn = root.querySelector('#cdOn').checked;
      const cdN = Number(root.querySelector('#cdN').value) || 0;
      const cdLeg = root.querySelector('#cdLeg').checked;

      await commit((d) => {
        d.game.settings = { ...d.game.settings, ...next };
        d.game.countdownEnabled = cdOn;
        d.game.roundsRemaining = cdOn ? cdN : null;
        d.game.countdownDisablesLegacy = cdLeg;
      }, { eventType: 'SETTINGS_CHANGED', summary: 'Settings updated', trackDiff: true });
      close();
      toast('Settings saved.');
    };
  });
}

/* ========================================================== BACKUP ===== */

function openBackup() {
  openModal(`
    <h2>Backup &amp; restore</h2>
    <div class="warnbox">This file pairs real names with hidden roles.
      Save it to OneDrive — never commit it to the repository.</div>
    <h3>Back up</h3>
    <div class="btn-row" style="margin-top:0">
      <button class="btn primary" id="bDown">Download file</button>
      <button class="btn" id="bCopy">Copy to clipboard</button>
      <button class="btn ghost" id="bShow">Show text</button>
    </div>
    <div id="bOut"></div>
    <h3>Restore</h3>
    <p class="faint">Replaces the current game entirely. Back up first if in doubt.</p>
    <div class="btn-row" style="margin-top:0">
      <button class="btn" id="bPick">Choose a backup file…</button>
      <input type="file" id="bFile" accept=".json,application/json" hidden>
    </div>
    <p class="faint" style="margin:10px 0 6px">Or paste the backup text:</p>
    <textarea id="bPaste" rows="5" placeholder="Paste backup JSON here"></textarea>
    <div class="btn-row"><button class="btn danger" id="bRestore">Restore</button></div>
    <div id="bMsg"></div>`,
  (root, close) => {
    const out = root.querySelector('#bOut');
    const msg = root.querySelector('#bMsg');
    const say = (html, bad) => {
      msg.innerHTML = `<div class="${bad ? 'warnbox' : 'okbox'}">${html}</div>`;
    };

    /* Serialising the game is the one thing every backup path depends on, so
       it is done ONCE, up front, and its failure is reported plainly. A blank
       textarea with no explanation is what made this panel look like three
       separate broken buttons. */
    const dump = () => {
      const json = store.exportJson();
      if (!json) throw new Error('The game produced no data to export.');
      return json;
    };

    const showText = (reason) => {
      let json;
      try {
        json = dump();
      } catch (err) {
        out.innerHTML = `<div class="warnbox">
          <strong>The game could not be converted to a backup file.</strong><br>
          ${esc(err.message)}<br>
          Nothing has been lost — the session is still open. Report this message.
        </div>`;
        return;
      }
      out.innerHTML = `
        ${reason ? `<div class="warnbox">${esc(reason)} Copy everything below and save it
          as a .json file in OneDrive.</div>` : ''}
        <textarea id="bDump" rows="6" readonly></textarea>`;
      const ta = out.querySelector('#bDump');
      ta.value = json;
      ta.focus();
      ta.select();
    };

    // --- download --------------------------------------------------------
    root.querySelector('#bDown').onclick = () => {
      try {
        const blob = new Blob([dump()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = store.backupFilename();
        a.rel = 'noopener';
        // The anchor must be in the document for the click to register, and the
        // object URL must outlive the click — revoking immediately cancels it.
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          if (a.parentNode) a.parentNode.removeChild(a);
          URL.revokeObjectURL(url);
        }, 4000);
        out.innerHTML = `<div class="okbox">Saved as
          <strong>${esc(store.backupFilename())}</strong> — check your Downloads folder,
          then move it to OneDrive. Nothing there? Use <em>Show text</em> instead.</div>`;
      } catch (err) {
        showText(`Download failed — ${err.message}`);
      }
    };

    // --- clipboard -------------------------------------------------------
    root.querySelector('#bCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(dump());
        out.innerHTML = '<div class="okbox">Copied. Paste it into a .json file in OneDrive.</div>';
      } catch (err) {
        showText(`Clipboard copy failed — ${err.message}`);
      }
    };

    root.querySelector('#bShow').onclick = () => showText('');

    // --- restore from a file --------------------------------------------
    const fileInput = root.querySelector('#bFile');
    root.querySelector('#bPick').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => doRestore(String(reader.result), f.name);
      reader.onerror = () => say('Could not read that file.', true);
      reader.readAsText(f);
    };

    // --- restore from pasted text ---------------------------------------
    root.querySelector('#bRestore').onclick = () => {
      const text = root.querySelector('#bPaste').value.trim();
      if (!text) return say('Paste a backup, or choose a file above.', true);
      doRestore(text, 'pasted text');
    };

    /* Two-step inline confirm. A nested modal would wipe this one, which is
       what broke the original restore path. */
    let armed = null;
    async function doRestore(text, source) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return say('That is not valid JSON — check the whole file was copied.', true);
      }
      if (!parsed || !parsed.game || !Array.isArray(parsed.players)) {
        return say('Readable, but not a Weekly Mafia backup.', true);
      }

      const when = parsed.game.createdAt
        ? new Date(parsed.game.createdAt).toLocaleDateString() : 'unknown date';
      const label = `week ${parsed.game.currentRound ?? '?'}, ${parsed.players.length} players`;

      if (armed !== text) {
        armed = text;
        msg.innerHTML = `
          <div class="warnbox">
            Restore from <strong>${esc(source)}</strong> — ${esc(label)}, created ${esc(when)}.<br>
            This replaces the current game.
          </div>
          <div class="btn-row">
            <button class="btn danger" id="bYes">Yes, restore</button>
            <button class="btn ghost" id="bNo">Cancel</button>
          </div>`;
        msg.querySelector('#bYes').onclick = () => doRestore(text, source);
        msg.querySelector('#bNo').onclick = () => { armed = null; msg.innerHTML = ''; };
        return;
      }

      try {
        await store.importJson(parsed);
        close();
        render();
        toast(`Restored — ${label}.`);
      } catch (err) {
        armed = null;
        say('Restore failed: ' + esc(err.message), true);
      }
    }
  });
}

/* ============================================================ BOOT ===== */

$('btnNext').onclick = advancePhase;
$('btnBack').onclick = rewindPhase;
$('btnSettings').onclick = openSettings;
$('btnBackup').onclick = openBackup;
$('btnReset').onclick = openResetPanel;

/* A failed write used to be logged to the console and nowhere else, so the
   admin could keep running a session that was never reaching localStorage.
   Now it surfaces immediately. */
store.onError = (message) => toast(message, true);

mountStorageButton(mode, sb);

await store.init();
render();
