/* mafia v0.3.1 | cloud.js | 22 Sep 2026 */
/*
  ONLINE STORAGE + ADMIN LOGIN + PLAYER LOGIN LINKS.

  Everything Supabase-specific lives in this file. engine.js and store.js are
  untouched, so the 72 engine tests keep running in Node with no network.

  The console runs in one of two modes, chosen by the admin:

    local  - localStorage, exactly as before. No login, no network.
    cloud  - Supabase. Requires an admin login. Players see their own roles.

  The mode is remembered in this browser. If the cloud misbehaves mid-session,
  switch back to local and finish the night.
*/

import { LocalAdapter, migrate, blankState } from './store.js';

/* ------------------------------------------------------------- settings - */

export const SB_URL = 'https://ashjitdpilxwcfhxamni.supabase.co';
export const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzaGppdGRwaWx4d2NmaHhhbW5pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwNDAxOTEsImV4cCI6MjEwNTYxNjE5MX0.wWTdrocCPlOWWN5CwTVi--OgWuVBEc99zWxWfVE_Gqk';

const MODE_KEY = 'amongpid:mode';
const GAME_ID = 'current';

export const getMode = () => {
  try { return localStorage.getItem(MODE_KEY) === 'cloud' ? 'cloud' : 'local'; }
  catch { return 'local'; }
};

const setMode = (mode) => {
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
};

/* -------------------------------------------------------- row conversion - */
/*
  Players are real database rows so that row-level security can hide them from
  each other. Everything else - settings, rounds, actions, ballots, the audit
  log - is only ever read by the admin, so it stays as one JSON blob in a
  single admin-only row.

  TWO COLUMNS ARE DELIBERATELY ABSENT FROM toRow:

    auth_user_id   which login owns this seat
    claim_email    which email is allowed to claim it

  Both are managed by the database alone, never by the console. The reason is
  a real race: the admin loads the game at 7:00, a player claims their seat at
  7:05, the admin marks attendance at 7:10. The admin's browser still holds the
  old state, where the link is null. Sending that column would overwrite the
  claim with null and lock the player out of their own game.

  Because these keys are absent from the payload, an upsert leaves whatever is
  already in the database untouched.
*/

const toRow = (p) => ({
  id: p.id,
  display_name: p.displayName,
  role: p.role,
  alignment: p.alignment,
  life_status: p.lifeStatus,
  attendance_status: p.attendanceStatus,
  reward_tokens: p.rewardTokens ?? 0,
  spirit_points: p.spiritPoints ?? 0,
  inventory: p.inventory ?? [],
  flags: p.flags ?? {},
  joined_round: p.joinedRound ?? 0
});

const fromRow = (r) => ({
  id: r.id,
  authUserId: r.auth_user_id ?? null,
  claimEmail: r.claim_email ?? null,
  displayName: r.display_name,
  role: r.role,
  alignment: r.alignment,
  lifeStatus: r.life_status,
  attendanceStatus: r.attendance_status,
  rewardTokens: r.reward_tokens ?? 0,
  spiritPoints: r.spirit_points ?? 0,
  inventory: r.inventory ?? [],
  flags: r.flags ?? {},
  joinedRound: r.joined_round ?? 0,
  passkeyHash: null,
  accessType: 'PLAYER'
});

/* ------------------------------------------------------------- adapter -- */

export class SupabaseAdapter {
  constructor(client, gameId = GAME_ID) {
    this.sb = client;
    this.gameId = gameId;
  }

  async load() {
    const [gameRes, playerRes] = await Promise.all([
      this.sb.from('games').select('blob').eq('id', this.gameId).maybeSingle(),
      this.sb.from('players').select('*')
    ]);

    if (gameRes.error) throw new Error('Could not load the game: ' + gameRes.error.message);
    if (playerRes.error) throw new Error('Could not load the players: ' + playerRes.error.message);

    const blob = gameRes.data?.blob;
    const players = (playerRes.data || []).map(fromRow);

    /*
      The games blob is missing or empty, but player rows exist.

      This used to return null, which told Store.init() to build a blank game
      with an EMPTY roster. The console then showed no players, and the next
      save computed "everyone in the database who is not in my empty local
      roster" and deleted the lot.

      A missing blob is not evidence that the roster is gone. Keep the players
      and rebuild only the parts that are actually absent.
    */
    if (!blob || !blob.game) {
      if (!players.length) return null;   // genuinely a fresh, empty game
      return migrate({ ...blankState(), players });
    }

    return migrate({ ...blob, players });
  }

  /**
   * Re-reads just the player rows.
   *
   * The console's copy of the roster goes stale the moment anything else
   * touches the table - a second tab, a seat claimed from player.html, or a
   * row added directly in Supabase. Anything that needs to be certain it is
   * looking at the current roster calls this first.
   */
  async loadPlayers() {
    const { data, error } = await this.sb.from('players').select('*');
    if (error) throw new Error('Could not load the players: ' + error.message);
    return (data || []).map(fromRow);
  }

  async save(state) {
    try {
      const { players, ...rest } = state;

      // 1. Players as rows.
      const rows = players.map(toRow);
      if (rows.length) {
        const up = await this.sb.from('players').upsert(rows);
        if (up.error) throw new Error(up.error.message);
      }

      /*
        2. NO IMPLICIT DELETES. This step used to remove "everyone in the
           database who is not in my local roster", and that is what kept
           eating players.

        The reasoning was that a removed player should not keep a row they
        could log in against. The flaw is the premise: the console's roster is
        a SNAPSHOT taken at load, and the players table has other writers -
        a second tab, a seat claimed from player.html, a row added straight
        into Supabase. The moment the snapshot is stale, "not in my roster"
        stops meaning "removed" and starts meaning "added while I was not
        looking" - and a routine save silently deletes a real player.

        That is precisely the failure that lost a linked seat: the console
        held one player, the database held two, and saving deleted the second.
        An all-or-nothing guard cannot catch it, because deleting one of two
        rows looks exactly like a legitimate removal.

        Removal is now explicit and rare, through removePlayer() below. The
        cost of keeping a stale row is a name on a list; the cost of deleting
        a live one is somebody's game. Marking a player "Left permanently"
        (INACTIVE) in the roster already removes them from play without
        touching the row, which is the safer path in every case anyway.
      */

      // 3. Everything else as one blob.
      const blob = await this.sb.from('games').upsert({
        id: this.gameId,
        blob: rest,
        updated_at: new Date().toISOString()
      });
      if (blob.error) throw new Error(blob.error.message);

      return { ok: true };
    } catch (err) {
      console.error('[cloud] save failed', err);
      return {
        ok: false,
        reason: `Could not save to the database: ${err.message}. ` +
                'Your game is still open in this browser - take a backup before refreshing.'
      };
    }
  }

  /**
   * The only path that deletes a player row. Deliberate, one at a time, and
   * never triggered by a routine save.
   */
  async removePlayer(playerId) {
    const { error } = await this.sb.from('players').delete().eq('id', playerId);
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  }

  async clear() {
    await this.sb.from('players').delete().neq('id', '');
    await this.sb.from('games').upsert({ id: this.gameId, blob: {} });
  }
}

/* --------------------------------------------------------------- screens - */

function overlay(html, wire) {
  const host = document.createElement('div');
  host.className = 'modal-backdrop';
  host.innerHTML = `<div class="modal" style="max-width:520px">${html}</div>`;
  document.body.appendChild(host);
  const close = () => host.remove();
  if (wire) wire(host.querySelector('.modal'), close);
  const first = host.querySelector('input, button');
  if (first) first.focus();
  return close;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Blocks until an admin signs in. */
function askForLogin(sb, note = '') {
  return new Promise((resolve) => {
    overlay(`
      <h2>Admin sign in</h2>
      <p class="hint">The console is running online. Sign in to load the game.</p>
      ${note ? `<div class="warnbox">${esc(note)}</div>` : ''}
      <div id="cErr"></div>
      <label class="field"><span>Email</span>
        <input type="email" id="cEmail" autocomplete="username"></label>
      <label class="field"><span>Password</span>
        <input type="password" id="cPw" autocomplete="current-password"></label>
      <div class="btn-row">
        <button class="btn primary" id="cGo">Sign in</button>
        <button class="btn ghost" id="cLocal">Use this browser instead</button>
      </div>
      <p class="faint" style="margin-top:12px">Offline mode keeps the game in this
        browser only. Players will not see anything.</p>`,
    (root, close) => {
      const err = root.querySelector('#cErr');
      const go = async () => {
        err.innerHTML = '';
        const email = root.querySelector('#cEmail').value.trim();
        const pw = root.querySelector('#cPw').value;
        if (!email || !pw) return;
        root.querySelector('#cGo').disabled = true;
        const { error } = await sb.auth.signInWithPassword({ email, password: pw });
        root.querySelector('#cGo').disabled = false;
        if (error) {
          err.innerHTML = `<div class="warnbox">${esc(error.message)}</div>`;
          return;
        }
        close();
        resolve(true);
      };
      root.querySelector('#cGo').onclick = go;
      root.querySelector('#cPw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
      root.querySelector('#cLocal').onclick = () => { setMode('local'); location.reload(); };
    });
  });
}

/** The account is real but is not on the admins table. */
function blockNonAdmin(sb) {
  return new Promise(() => {
    overlay(`
      <h2>That account is not an admin</h2>
      <p class="hint">Only accounts listed in the <code>admins</code> table can run a
        game. Player accounts use the player page instead.</p>
      <div class="btn-row">
        <button class="btn primary" id="cOut">Sign in as someone else</button>
        <button class="btn ghost" id="cLocal">Use this browser instead</button>
      </div>`,
    (root) => {
      root.querySelector('#cOut').onclick = async () => {
        await sb.auth.signOut();
        location.reload();
      };
      root.querySelector('#cLocal').onclick = () => { setMode('local'); location.reload(); };
    });
  });
}

/** Supabase cannot be reached. Never strand the admin on game night. */
function blockUnreachable(message) {
  return new Promise(() => {
    overlay(`
      <h2>Cannot reach the database</h2>
      <div class="warnbox">${esc(message)}</div>
      <p class="hint">Game night does not have to stop. Offline mode runs the console
        from this browser exactly as it did before.</p>
      <div class="btn-row">
        <button class="btn primary" id="cLocal">Switch to this browser</button>
        <button class="btn ghost" id="cRetry">Try again</button>
      </div>`,
    (root) => {
      root.querySelector('#cLocal').onclick = () => { setMode('local'); location.reload(); };
      root.querySelector('#cRetry').onclick = () => location.reload();
    });
  });
}

/* ------------------------------------------------------------ selection - */

/**
 * Decides where the game is stored, signing in first if needed.
 * Returns { adapter, mode, sb } - sb is null in local mode.
 */
export async function chooseAdapter() {
  if (getMode() !== 'cloud') {
    return { adapter: new LocalAdapter(), mode: 'local', sb: null };
  }

  let createClient;
  try {
    ({ createClient } = await import('https://esm.sh/@supabase/supabase-js@2'));
  } catch (err) {
    await blockUnreachable('The Supabase library could not be downloaded. ' + err.message);
    return;
  }

  const sb = createClient(SB_URL, SB_KEY);

  let session;
  try {
    ({ data: { session } } = await sb.auth.getSession());
  } catch (err) {
    await blockUnreachable(err.message);
    return;
  }

  if (!session) await askForLogin(sb);

  // Confirm admin rights before handing over a writable adapter. The database
  // enforces this too - this check exists so the failure is explained rather
  // than appearing later as an unexplained save error.
  const { data: adminRows, error: adminErr } = await sb.from('admins').select('auth_user_id');
  if (adminErr) {
    await blockUnreachable(adminErr.message);
    return;
  }
  if (!adminRows || !adminRows.length) {
    await blockNonAdmin(sb);
    return;
  }

  return { adapter: new SupabaseAdapter(sb), mode: 'cloud', sb };
}

/* --------------------------------------------------------- storage panel - */

/** Adds an Online / This browser button to the top bar. */
export function mountStorageButton(mode, sb) {
  const bar = document.querySelector('.topbar');
  const before = document.getElementById('btnSettings');
  if (!bar || !before) return;

  const btn = document.createElement('button');
  btn.className = 'btn sm ghost';
  btn.id = 'btnStorage';
  btn.textContent = mode === 'cloud' ? 'Online' : 'This browser';
  btn.title = 'Where this game is saved, and who can log in';
  bar.insertBefore(btn, before);

  btn.onclick = () => openStoragePanel(mode, sb);
}

function openStoragePanel(mode, sb) {
  const cloud = mode === 'cloud';
  overlay(`
    <h2>Where this game is saved</h2>
    <div class="${cloud ? 'okbox' : 'warnbox'}">
      ${cloud
        ? 'Online. Players can log in and see their own roles.'
        : 'This browser only. Players cannot see anything yet.'}
    </div>

    ${cloud ? `
      <h3>Player logins</h3>
      <p class="faint">Give each player the email address of the account you made
        for them. They log in at <code>player.html</code> and the seat links itself.</p>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn primary" id="sLinks">Manage player logins</button>
      </div>` : ''}

    <h3>Switch</h3>
    <p class="faint">The two are separate games. Switching does not copy anything
      across - use Backup to move a game between them.</p>
    <div class="btn-row" style="margin-top:8px">
      ${cloud
        ? '<button class="btn" id="sLocal">Switch to this browser</button>'
        : '<button class="btn primary" id="sCloud">Switch to online</button>'}
      ${cloud ? '<button class="btn ghost" id="sOut">Sign out</button>' : ''}
    </div>

    <div class="btn-row"><button class="btn ghost" id="sClose">Close</button></div>`,
  (root, close) => {
    root.querySelector('#sClose').onclick = close;
    const local = root.querySelector('#sLocal');
    const toCloud = root.querySelector('#sCloud');
    const out = root.querySelector('#sOut');
    const links = root.querySelector('#sLinks');

    if (local) local.onclick = () => { setMode('local'); location.reload(); };
    if (toCloud) toCloud.onclick = () => { setMode('cloud'); location.reload(); };
    if (out) out.onclick = async () => { await sb.auth.signOut(); location.reload(); };
    if (links) links.onclick = () => { close(); openLinksPanel(sb); };
  });
}

/* ---------------------------------------------------------- login links - */
/*
  Linking a login to a seat is done by EMAIL, not by pasting user ids.

  The admin types the email of the account they created for a player. When that
  player signs in, the database matches their verified email to the seat and
  links it. The console never handles the link itself, which is what keeps the
  race described at the top of this file impossible.
*/

async function openLinksPanel(sb) {
  const close = overlay(`
    <h2>Player logins</h2>
    <p class="hint">Type the email of the account you created for each player.
      They claim their own seat when they first sign in.</p>
    <div id="lMsg"></div>
    <div id="lBody"><p class="empty">Loading…</p></div>
    <div class="btn-row"><button class="btn ghost" id="lClose">Close</button></div>`,
  (root) => {
    root.querySelector('#lClose').onclick = () => root.closest('.modal-backdrop').remove();
  });

  const host = document.querySelector('.modal-backdrop:last-of-type .modal');
  if (!host) return;

  const body = host.querySelector('#lBody');
  const msg = host.querySelector('#lMsg');

  const say = (html, bad) => {
    msg.innerHTML = `<div class="${bad ? 'warnbox' : 'okbox'}">${html}</div>`;
  };

  const { data, error } = await sb
    .from('players')
    .select('id, display_name, claim_email, auth_user_id')
    .order('display_name');

  if (error) {
    body.innerHTML = `<div class="warnbox">Could not load players: ${esc(error.message)}</div>`;
    return;
  }
  if (!data.length) {
    body.innerHTML = '<p class="empty">No players yet. Add them on the main screen first.</p>';
    return;
  }

  body.innerHTML = `
    <table><thead><tr>
      <th>Player</th><th>Login email</th><th style="width:110px">Status</th>
    </tr></thead><tbody></tbody></table>`;
  const tb = body.querySelector('tbody');

  for (const p of data) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(p.display_name)}</td>
      <td><input type="text" value="${esc(p.claim_email ?? '')}"
            placeholder="name@example.com" autocomplete="off"></td>
      <td>${p.auth_user_id
        ? '<span class="badge alive">Linked</span>'
        : p.claim_email
          ? '<span class="badge dormant">Waiting</span>'
          : '<span class="badge out">Not set</span>'}</td>`;

    const input = tr.querySelector('input');
    let last = p.claim_email ?? '';

    input.onchange = async () => {
      const email = input.value.trim().toLowerCase();
      if (email === last) return;

      const { error: upErr } = await sb
        .from('players')
        .update({ claim_email: email || null })
        .eq('id', p.id);

      if (upErr) {
        input.value = last;
        return say(`Could not save ${esc(p.display_name)}: ${esc(upErr.message)}`, true);
      }
      last = email;
      say(`${esc(p.display_name)} will be linked when ${esc(email || 'nobody')} signs in.`);
    };

    tb.appendChild(tr);
  }
}
