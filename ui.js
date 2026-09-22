/* mafia v0.2 | ui.js | 22 Sep 2026 */
/*
  Rendering and admin controls. Talks to store.js and engine.js only.
  Contains NO game rules — anything that decides an outcome lives in engine.js.
*/

import * as E from './engine.js';
import { Store, LocalAdapter, newPlayer, newInventoryItem } from './store.js';
import {
  GAME_TITLE, GAME_SUBTITLE, MINIGAMES,
  PHASE_LABEL, PHASE_HINT, ROLE_LABEL, ITEM_LABEL, ITEM_HINT, SETTING_LABEL
} from './content.js';

const store = new Store(new LocalAdapter());

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

/* ========================================================== PHASES ====== */

function render() {
  renderChrome();
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
    [E.PHASE.DISCUSSION]: viewDiscussion,
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
      ? `${count} players → ${b.mafia} Mafia, ${b.doctor} Doctor, ${b.sheriff} Sheriff, ${Math.max(count - b.mafia - b.doctor - b.sheriff, 0)} Civilian.`
      : 'Add at least 10 players for the documented balance.';
  } else {
    note.textContent = 'New players joining mid-game receive a balance-based role on their first session.';
  }

  const addPlayer = async () => {
    const input = card.querySelector('#newName');
    const name = input.value.trim();
    if (!name) return;
    if (activeRoster().some((p) => p.displayName.toLowerCase() === name.toLowerCase())) {
      return toast('That name is already on the roster.', true);
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
    <div class="warnbox">Take each action privately — a whisper, a DM or a turned screen.
      Nothing here is announced until resolution.</div>`;
  main.appendChild(intro);

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
        <span class="badge ${cur?.targetId ? 'alive' : 'out'}">${cur?.targetId ? 'Submitted' : 'Waiting'}</span>`;
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
    // Bypass staging
    for (const m of mafia) {
      if (ownsUsable(m, E.ITEM.BYPASS_DOCTOR_SAVE) || isStaged(m, E.ITEM.BYPASS_DOCTOR_SAVE)) {
        mCard.appendChild(stageToggle(m, E.ITEM.BYPASS_DOCTOR_SAVE));
      }
    }
  }
  main.appendChild(mCard);

  // --- Doctor ------------------------------------------------------------
  const doctors = present().filter((p) => p.role === E.ROLE.DOCTOR);
  const dCard = el('div', 'card private');
  dCard.innerHTML = `<h2>Doctor protection</h2>
    <p class="hint">Blocks the Mafia kill unless a Bypass is in play.</p>`;
  if (!doctors.length) {
    dCard.appendChild(el('div', 'warnbox', 'No Doctor present — the ability goes unused this week.'));
  } else {
    for (const doc of doctors) {
      const cur = actionBy(doc.id);
      const selfOk = isStaged(doc, E.ITEM.SELF_SAVE);
      const dbl = isStaged(doc, E.ITEM.DOUBLE_SAVE);
      const row = el('div', 'action-row' + (cur?.targetId ? ' submitted' : ''));
      row.innerHTML = `
        <div class="who">${esc(doc.displayName)}<small>Doctor</small></div>
        ${targetSelect('t', cur?.targetId, { exclude: selfOk ? [] : [doc.id], blank: '— no save —' })}
        <span class="badge ${cur?.targetId ? 'alive' : 'out'}">${cur?.targetId ? 'Submitted' : 'Waiting'}</span>`;
      row.querySelector('select').onchange = (e) =>
        setAction(doc.id, E.ACTION.DOCTOR_SAVE, e.target.value);
      dCard.appendChild(row);

      if (dbl) {
        const row2 = el('div', 'action-row', `
          <div class="who">Second save<small>Double Save</small></div>
          ${targetSelect('t2', cur?.secondaryTargetId, { exclude: [cur?.targetId] })}
          <span class="badge good">Active</span>`);
        row2.querySelector('select').onchange = (e) =>
          setAction(doc.id, E.ACTION.DOCTOR_SAVE, cur?.targetId, e.target.value);
        dCard.appendChild(row2);
      }
      for (const item of [E.ITEM.SELF_SAVE, E.ITEM.DOUBLE_SAVE]) {
        if (ownsUsable(doc, item) || isStaged(doc, item)) dCard.appendChild(stageToggle(doc, item));
      }
    }
  }
  main.appendChild(dCard);

  // --- Sheriff -----------------------------------------------------------
  const sheriffs = present().filter((p) => p.role === E.ROLE.SHERIFF);
  const sCard = el('div', 'card private');
  sCard.innerHTML = `<h2>Sheriff investigation</h2>
    <p class="hint">Innocent is always truthful. Suspicious proves nothing — say so when you deliver it.</p>`;
  if (!sheriffs.length) {
    sCard.appendChild(el('div', 'warnbox', 'No Sheriff present — the ability goes unused this week.'));
  } else {
    for (const sh of sheriffs) {
      const cur = actionBy(sh.id);
      const extra = isStaged(sh, E.ITEM.ADDITIONAL_INVESTIGATION);
      const row = el('div', 'action-row' + (cur?.targetId ? ' submitted' : ''));
      row.innerHTML = `
        <div class="who">${esc(sh.displayName)}<small>Sheriff</small></div>
        ${targetSelect('t', cur?.targetId, { exclude: [sh.id], blank: '— no investigation —' })}
        <span class="badge ${cur?.targetId ? 'alive' : 'out'}">${cur?.targetId ? 'Submitted' : 'Waiting'}</span>`;
      row.querySelector('select').onchange = (e) =>
        setAction(sh.id, E.ACTION.SHERIFF_INVESTIGATE, e.target.value);
      sCard.appendChild(row);

      if (extra) {
        const row2 = el('div', 'action-row', `
          <div class="who">Second target<small>Additional Investigation</small></div>
          ${targetSelect('t2', cur?.secondaryTargetId, { exclude: [sh.id, cur?.targetId] })}
          <span class="badge good">Active</span>`);
        row2.querySelector('select').onchange = (e) =>
          setAction(sh.id, E.ACTION.SHERIFF_INVESTIGATE, cur?.targetId, e.target.value);
        sCard.appendChild(row2);
      }
      if (ownsUsable(sh, E.ITEM.ADDITIONAL_INVESTIGATION) || isStaged(sh, E.ITEM.ADDITIONAL_INVESTIGATION)) {
        sCard.appendChild(stageToggle(sh, E.ITEM.ADDITIONAL_INVESTIGATION));
      }
    }
  }
  main.appendChild(sCard);
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

async function toggleStage(playerId, itemType, on) {
  const round = S().game.currentRound;
  await commit((d) => {
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
}

async function setAction(actorId, type, targetId, secondaryTargetId) {
  await commit((d) => {
    const list = (d.currentActions || []).filter((a) => a.actorId !== actorId);
    if (targetId || secondaryTargetId) {
      list.push({
        actorId, type,
        targetId: targetId || null,
        secondaryTargetId: secondaryTargetId || null,
        submittedAt: new Date().toISOString()
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
      <button class="btn primary" id="award">Award tokens & points</button>
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
    tr.querySelector('input').onchange = (e) => {
      const next = new Set(S().currentWinners || []);
      e.target.checked ? next.add(p.id) : next.delete(p.id);
      store.commit((d) => { d.currentWinners = [...next]; });
    };
    body.appendChild(tr);
  }

  card.querySelector('#award').onclick = async () => {
    const ids = S().currentWinners || [];
    if (!ids.length) return toast('Select at least one winner.', true);
    if (S().currentRewardsPaid) return toast('Tokens already awarded this week.', true);
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
      summary: `Tokens awarded to ${ids.map(nameOf).join(', ')}`,
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
      if (itemType === E.ITEM.REVEAL_ALIGNMENT_ON_DEATH) {
        next.flags = { ...(x.flags || {}), revealAlignmentOnDeath: true };
      } else {
        next.inventory = [...(x.inventory || []), newInventoryItem(itemType, round)];
      }
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
            : res.blockedBy === 'DOCTOR' ? 'No death — the Doctor saved the target.'
            : res.blockedBy === 'IMMUNITY' ? 'No death — the target was immune.'
            : 'No death this week.'}
        </div>
        ${res.sheriffResults.length ? `<h3>Sheriff results — deliver privately</h3>
          <table><tbody>${res.sheriffResults.map((r) => `<tr>
            <td>${esc(nameOf(r.sheriffId))} investigated <strong>${esc(nameOf(r.targetId))}</strong></td>
            <td><span class="badge ${r.verdict === 'INNOCENT' ? 'good' : 'mafia'}">${r.verdict}</span></td>
          </tr>`).join('')}</tbody></table>` : ''}
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
    'Deliver any Sheriff results privately now, then advance to the Master phase.'));
  main.appendChild(card);
}

async function publishResolution(res) {
  const rngSucc = rngFor('succession');
  await commit((d) => {
    d.pendingPublicEvent = res.publicEvent;
    d.privateEvents = [...(d.privateEvents || []), ...res.privateEvents];

    if (res.death) {
      d.players = E.killPlayer(d.players, res.death);
      const dead = d.players.find((p) => p.id === res.death);
      if (dead?.role === E.ROLE.DOCTOR) {
        const succ = E.applyDoctorSuccession(d.players, res.death, rngSucc);
        d.players = succ.players;
        if (succ.successorId) d.pendingSuccessorId = succ.successorId;
      }
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

  // Legacy may fire if that death removed the last Mafia.
  await runLegacyAndEndgame();

  const succ = S().pendingSuccessorId;
  if (succ) {
    toast(`${nameOf(succ)} has inherited the Doctor role — tell them privately.`);
    await store.commit((d) => { d.pendingSuccessorId = null; });
  }
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
  a.onchange = () => store.commit((d) => {
    d.currentMaster = { ...(d.currentMaster || {}), immunePlayerId: a.value || null };
  }).then(() => toast('Immunity recorded privately.'));
  b.onchange = () => store.commit((d) => {
    d.currentMaster = { ...(d.currentMaster || {}), doubleVotePlayerId: b.value || null };
  }).then(() => toast('Double vote recorded privately.'));
}

/* ------------------------------------------------------ DISCUSSION ----- */

let timerHandle = null;
function viewDiscussion(main) {
  const card = el('div', 'card accent');
  card.innerHTML = `
    <h2>Discussion</h2>
    <p class="hint">${esc(PHASE_HINT.DISCUSSION)}</p>
    <div class="timer" id="clock">07:00</div>
    <div class="btn-row" style="justify-content:center">
      <button class="btn primary" id="startT">Start</button>
      <button class="btn" id="pauseT">Pause</button>
      <button class="btn ghost" id="resetT">Reset</button>
      <select id="mins" style="width:auto">
        <option value="6">6 min</option><option value="7" selected>7 min</option>
        <option value="8">8 min</option><option value="10">10 min</option>
      </select>
    </div>`;
  main.appendChild(card);

  let remaining = 7 * 60;
  const clock = card.querySelector('#clock');
  const paint = () => {
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    clock.textContent = `${m}:${s}`;
  };
  const stop = () => { clearInterval(timerHandle); timerHandle = null; };
  card.querySelector('#startT').onclick = () => {
    if (timerHandle) return;
    timerHandle = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      paint();
      if (remaining === 0) { stop(); toast('Discussion time is up.'); }
    }, 1000);
  };
  card.querySelector('#pauseT').onclick = stop;
  card.querySelector('#resetT').onclick = () => {
    stop(); remaining = Number(card.querySelector('#mins').value) * 60; paint();
  };
  card.querySelector('#mins').onchange = (e) => {
    stop(); remaining = Number(e.target.value) * 60; paint();
  };
  paint();

  const summary = S().pendingPublicEvent;
  if (summary) {
    main.appendChild(el('div', 'card',
      `<h2>This week's public result</h2><p class="hint">${esc(summary.text)}</p>`));
  }
}

/* ---------------------------------------------------------- VOTING ----- */

function viewVoting(main) {
  const ballots = S().currentBallots || [];
  const voters = present();

  const card = el('div', 'card accent');
  card.innerHTML = `
    <h2>Anonymous ballots</h2>
    <p class="hint">${esc(PHASE_HINT.VOTING)}</p>
    <div class="warnbox">Collect ballots privately. Totals are public; who voted for whom never is.</div>
    <div class="action-grid" id="vGrid"></div>`;
  main.appendChild(card);

  const grid = card.querySelector('#vGrid');
  for (const v of voters) {
    const cur = ballots.find((b) => b.voterId === v.id);
    const extra = isStaged(v, E.ITEM.EXTRA_VOTE);
    const dbl = S().currentMaster?.doubleVotePlayerId === v.id;
    const weight = 1 + (extra ? 1 : 0) + (dbl ? 1 : 0);
    const row = el('div', 'action-row' + (cur ? ' submitted' : ''));
    row.innerHTML = `
      <div class="who">${esc(v.displayName)}<small>${weight > 1 ? `weight ${weight}` : 'weight 1'}</small></div>
      ${targetSelect('t', cur?.targetId, { exclude: [], blank: '— abstain —' })}
      <span class="badge ${cur ? 'alive' : 'out'}">${cur ? 'Cast' : 'Waiting'}</span>`;
    row.querySelector('select').onchange = (e) => setBallot(v.id, e.target.value);
    grid.appendChild(row);

    if (ownsUsable(v, E.ITEM.EXTRA_VOTE) || extra) {
      grid.appendChild(stageToggle(v, E.ITEM.EXTRA_VOTE));
    }
  }

  // Vote manipulation
  const mafiaWithVM = present().filter(
    (p) => p.role === E.ROLE.MAFIA && (ownsUsable(p, E.ITEM.VOTE_MANIPULATION) || isStaged(p, E.ITEM.VOTE_MANIPULATION)));
  if (mafiaWithVM.length) {
    const vm = S().currentManipulation;
    const mcard = el('div', 'card private');
    mcard.innerHTML = `
      <h2>Vote Manipulation</h2>
      <p class="hint">One anonymous adjustment. The source is never shown in the totals.</p>
      <label class="field"><span>Target</span>${targetSelect('t', vm?.targetId)}</label>
      <label class="field"><span>Adjustment</span>
        <select data-field="d">
          <option value="1"${vm?.delta === 1 ? ' selected' : ''}>+1 vote</option>
          <option value="-1"${vm?.delta === -1 ? ' selected' : ''}>−1 vote</option>
        </select></label>`;
    main.appendChild(mcard);
    const [t, d] = mcard.querySelectorAll('select');
    const save = () => store.commit((st) => {
      st.currentManipulation = t.value ? { targetId: t.value, delta: Number(d.value) } : null;
    });
    t.onchange = save; d.onchange = save;
  }

  const go = el('div', 'card');
  go.innerHTML = `<div class="btn-row" style="margin:0">
    <button class="btn primary" id="tally">Tally the vote</button></div>
    <p class="faint" style="margin-top:10px">${ballots.length} of ${voters.length} ballots entered.</p>`;
  main.appendChild(go);
  go.querySelector('#tally').onclick = async () => {
    if (!ballots.length) return toast('No ballots entered.', true);
    const res = E.resolveVote(S(), ballots, S().currentMaster || {}, S().currentManipulation);
    await commit((d) => { d.currentVoteResult = res; d.game.status = E.PHASE.RESULTS; });
  };
}

async function setBallot(voterId, targetId) {
  await commit((d) => {
    const list = (d.currentBallots || []).filter((b) => b.voterId !== voterId);
    if (targetId) list.push({ voterId, targetId });
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
      ? `They were a <strong>${esc(roleLabel(res.revealedRole))}</strong>.`
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

  if (res.eliminated && byId(res.eliminated)?.lifeStatus === E.LIFE.ALIVE) {
    const apply = el('div', 'card accent');
    apply.innerHTML = `<h2>Apply the elimination</h2>
      <p class="hint">This commits the death, runs Doctor succession and checks Legacy and victory.</p>
      <div class="btn-row"><button class="btn primary" id="applyEl">Apply elimination</button></div>`;
    main.appendChild(apply);
    apply.querySelector('#applyEl').onclick = async () => {
      const rngSucc = rngFor('vote-succession');
      await commit((d) => {
        d.players = E.killPlayer(d.players, res.eliminated);
        const dead = d.players.find((p) => p.id === res.eliminated);
        if (dead?.role === E.ROLE.DOCTOR) {
          const s = E.applyDoctorSuccession(d.players, res.eliminated, rngSucc);
          d.players = s.players;
          if (s.successorId) d.pendingSuccessorId = s.successorId;
        }
      }, { eventType: 'ELIMINATION',
           summary: `${nameOf(res.eliminated)} was voted out (${roleLabel(res.revealedRole)})`,
           trackDiff: true });
      await runLegacyAndEndgame();
      const succ = S().pendingSuccessorId;
      if (succ) {
        toast(`${nameOf(succ)} has inherited the Doctor role — tell them privately.`);
        await store.commit((d) => { d.pendingSuccessorId = null; });
      }
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
    <p class="hint">Export a backup first if you want to keep this one.</p>
    <div class="btn-row"><button class="btn danger" id="reset">Reset everything</button></div>`;
  main.appendChild(again);
  again.querySelector('#reset').onclick = async () => {
    if (await confirmAction('Erase this game and start fresh?',
      'Players, roles, tokens and history are all cleared. This cannot be undone.')) {
      await store.reset(); render(); toast('New game ready.');
    }
  };
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
      if (d.game.countdownEnabled && d.game.roundsRemaining != null) {
        d.game.roundsRemaining = Math.max(0, d.game.roundsRemaining - 1);
      }
    }, { eventType: 'SESSION_OPENED', summary: `Week ${g.currentRound + 1} opened` });
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

  await commit((d) => { d.game.status = E.nextPhase(d.game.status); });
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
    </div>`, (root, close) => {
    root.querySelector('#mCancel').onclick = close;
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
  const numeric = ['suspiciousFalsePositiveChance', 'spiritPointsAttendance',
    'spiritPointsMinigameWin', 'resurrectionCost', 'resurrectionDiscountedCost',
    'maxActiveMafiaFromRecruit'];

  openModal(`
    <h2>Settings</h2>
    <p class="hint">Defaults follow the design document. Change these only deliberately.</p>
    ${numeric.map((k) => `<label class="field"><span>${esc(SETTING_LABEL[k])}</span>
      <input type="number" step="${k === 'suspiciousFalsePositiveChance' ? '0.05' : '1'}"
        min="0" data-set="${k}" value="${s[k]}"></label>`).join('')}

    <label class="field"><span>${esc(SETTING_LABEL.voteManipulationDirection)}</span>
      <select data-set="voteManipulationDirection">
        <option value="1"${s.voteManipulationDirection === 1 ? ' selected' : ''}>Add a vote (+1)</option>
        <option value="-1"${s.voteManipulationDirection === -1 ? ' selected' : ''}>Remove a vote (−1)</option>
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
    <h2>Backup & restore</h2>
    <div class="warnbox">This file contains real names alongside hidden roles.
      Save it to OneDrive — never commit it to the repository.</div>
    <div class="btn-row">
      <button class="btn primary" id="bDown">Download backup</button>
      <button class="btn" id="bCopy">Copy to clipboard</button>
    </div>
    <h3>Restore</h3>
    <p class="faint">Paste a previous backup to replace the current game entirely.</p>
    <textarea id="bPaste" rows="6" placeholder="Paste backup JSON here"></textarea>
    <div class="btn-row"><button class="btn danger" id="bRestore">Restore from paste</button></div>`,
  (root, close) => {
    root.querySelector('#bDown').onclick = () => {
      const blob = new Blob([store.exportJson()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = store.backupFilename();
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Backup downloaded.');
    };
    root.querySelector('#bCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(store.exportJson());
        toast('Backup copied to the clipboard.');
      } catch { toast('Clipboard blocked — use Download instead.', true); }
    };
    root.querySelector('#bRestore').onclick = async () => {
      const text = root.querySelector('#bPaste').value.trim();
      if (!text) return toast('Paste a backup first.', true);
      if (!(await confirmAction('Replace the current game?',
        'Everything currently stored is overwritten.'))) return;
      try {
        await store.importJson(text);
        close(); render(); toast('Game restored.');
      } catch (err) { toast('That is not a valid backup file.', true); }
    };
  });
}

/* ============================================================ BOOT ===== */

$('btnNext').onclick = advancePhase;
$('btnBack').onclick = rewindPhase;
$('btnSettings').onclick = openSettings;
$('btnBackup').onclick = openBackup;

await store.init();
render();
