/* mafia v0.2.3 | store.js | 22 Sep 2026 */
/*
  ALL persistence lives here. No game rules. No DOM.
  This is the swappable adapter: replacing the LocalAdapter with a Supabase
  adapter later must require no changes to engine.js or ui.js.
*/

import {
  ROLE,
  ALIGNMENT,
  LIFE,
  ATTENDANCE,
  PHASE,
  DEFAULT_SETTINGS
} from './engine.js';

export const SCHEMA_VERSION = 1;
const STORAGE_KEY = 'weeklyMafia:v1';

// ---------------------------------------------------------------------------
// Serialisation safety
// ---------------------------------------------------------------------------

/**
 * A snapshot for the audit log's before/after payload.
 *
 * The audit array is stripped first. Keeping it caused two failures:
 *   1. `after` pointed at the live state object, which contains the audit
 *      array the entry is being pushed into — a circular reference that made
 *      JSON.stringify throw, breaking BOTH export and localStorage writes.
 *   2. Even without the cycle, nesting the audit log inside its own entries
 *      grows the saved state exponentially.
 */
function snapshot(state) {
  if (!state) return undefined;
  const { audit, ...rest } = state;
  return structuredClone(rest);
}

/**
 * JSON.stringify that can never throw on a cycle. Any state written by an
 * older build may still contain the circular audit entries described above,
 * so export and restore must stay usable rather than dying on bad data.
 */
export function safeStringify(value, indent = 0) {
  const seen = new WeakSet();
  return JSON.stringify(value, function (key, val) {
    if (val && typeof val === 'object') {
      if (seen.has(val)) return '[circular reference removed]';
      seen.add(val);
    }
    return val;
  }, indent);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function blankState(name = 'Weekly Mafia') {
  return {
    schemaVersion: SCHEMA_VERSION,
    game: {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      name,
      status: PHASE.CLOSED,
      currentRound: 0,
      legacyUsed: false,
      countdownEnabled: false,
      countdownDisablesLegacy: false,
      roundsRemaining: null,
      winner: null,
      rngSeed: Math.floor(Math.random() * 2 ** 31),
      settings: { ...DEFAULT_SETTINGS },
      createdAt: new Date().toISOString()
    },
    players: [],
    rounds: [],
    currentActions: [],
    currentBallots: [],
    currentMaster: { immunePlayerId: null, doubleVotePlayerId: null },
    currentManipulation: null,
    pendingPublicEvent: null,
    privateEvents: [],
    audit: []
  };
}

export function newPlayer(displayName, joinedRound = 0) {
  return {
    id: 'p_' + Math.random().toString(36).slice(2, 10),
    displayName,
    role: ROLE.CIVILIAN,
    alignment: ALIGNMENT.GOOD,
    lifeStatus: LIFE.ALIVE,
    attendanceStatus: ATTENDANCE.PRESENT,
    rewardTokens: 0,
    spiritPoints: 0,
    joinedRound,
    inventory: [],
    flags: {},
    passkeyHash: null,
    accessType: 'PLAYER'
  };
}

export function newInventoryItem(rewardType, round) {
  return {
    id: 'i_' + Math.random().toString(36).slice(2, 10),
    rewardType,
    status: 'OWNED',              // OWNED | STAGED | USED
    purchasedRound: round,
    eligibleFromRound: round + 1, // cannot apply retroactively
    expiresRound: null,
    stagedRound: null,
    usedRound: null
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Stage 1: single browser, localStorage. */
export class LocalAdapter {
  constructor(key = STORAGE_KEY) {
    this.key = key;
  }
  async load() {
    try {
      const raw = globalThis.localStorage?.getItem(this.key);
      return raw ? migrate(JSON.parse(raw)) : null;
    } catch (err) {
      console.error('[store] load failed', err);
      return null;
    }
  }
  async save(state) {
    try {
      globalThis.localStorage?.setItem(this.key, safeStringify(state));
      return { ok: true };
    } catch (err) {
      console.error('[store] save failed', err);
      const quota = err?.name === 'QuotaExceededError' ||
                    err?.name === 'NS_ERROR_DOM_QUOTA_REACHED';
      return {
        ok: false,
        reason: quota
          ? 'Browser storage is full. Export a backup, then start a new game.'
          : `Could not write to browser storage: ${err.message}`
      };
    }
  }
  async clear() {
    globalThis.localStorage?.removeItem(this.key);
  }
}

/** Test/SSR adapter — holds state in memory only. */
export class MemoryAdapter {
  constructor(initial = null) {
    this.state = initial;
  }
  async load() {
    return this.state ? migrate(structuredClone(this.state)) : null;
  }
  async save(state) {
    this.state = structuredClone(state);
    return true;
  }
  async clear() {
    this.state = null;
  }
}

/*
  Stage 2 placeholder. Implemented when multi-device play is switched on.
  Must expose exactly load/save/clear so nothing else changes.

  export class SupabaseAdapter { ... }
*/

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export function migrate(state) {
  if (!state) return null;
  if (!state.schemaVersion) state.schemaVersion = 1;
  // Backfill any fields added after a save was written.
  const base = blankState();
  for (const key of Object.keys(base)) {
    if (state[key] === undefined) state[key] = base[key];
  }
  state.game = { ...base.game, ...state.game, id: state.game?.id ?? base.game.id };
  state.game.settings = { ...DEFAULT_SETTINGS, ...(state.game.settings || {}) };
  // Repair audit entries written by a build that stored live references.
  // Any surviving cycle here would break the next save and export.
  state.audit = (state.audit || []).map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const { before, after, ...rest } = entry;
    return {
      ...rest,
      before: before ? snapshot(before) : undefined,
      after: after ? snapshot(after) : undefined
    };
  });

  state.players = (state.players || []).map((p) => ({
    ...newPlayer(p.displayName),
    ...p,
    inventory: p.inventory || [],
    flags: p.flags || {}
  }));
  return state;
}

// ---------------------------------------------------------------------------
// Store — the only object ui.js talks to for state
// ---------------------------------------------------------------------------

export class Store {
  constructor(adapter = new LocalAdapter()) {
    this.adapter = adapter;
    this.state = null;
    this.listeners = new Set();
    /** Optional hook — ui.js sets this to surface save failures to the admin. */
    this.onError = null;
  }

  async init() {
    this.state = (await this.adapter.load()) || blankState();
    this.emit();
    return this.state;
  }

  get() {
    return this.state;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  /**
   * The single write path. Every mutation goes through here so that
   * persistence and audit are impossible to forget.
   */
  async commit(mutator, auditEntry = null) {
    const before = structuredClone(this.state);
    const draft = structuredClone(this.state);
    const result = mutator(draft);
    const next = result === undefined ? draft : result;

    if (auditEntry) {
      next.audit = [
        ...(next.audit || []),
        {
          id: 'a_' + Math.random().toString(36).slice(2, 10),
          timestamp: new Date().toISOString(),
          round: next.game.currentRound,
          ...auditEntry,
          before: auditEntry.trackDiff ? snapshot(before) : undefined,
          after: auditEntry.trackDiff ? snapshot(next) : undefined
        }
      ];
    }

    this.state = next;
    await this.persist();
    this.emit();
    return this.state;
  }

  /**
   * Writes through to the adapter and reports failure instead of swallowing it.
   * A silent save failure means the admin keeps playing a session that is only
   * ever held in memory — one refresh and the week is gone.
   */
  async persist() {
    const result = await this.adapter.save(this.state);
    const ok = result === true || result?.ok === true;
    if (!ok && this.onError) {
      this.onError(result?.reason || 'The game could not be saved to this browser.');
    }
    return ok;
  }

  async reset() {
    this.state = blankState();
    await this.persist();
    this.emit();
  }

  // --- Backup -------------------------------------------------------------

  exportJson() {
    return safeStringify(this.state, 2);
  }

  async importJson(json) {
    const raw = typeof json === 'string' ? JSON.parse(json) : json;
    if (!raw || typeof raw !== 'object' || !raw.game || !Array.isArray(raw.players)) {
      throw new Error('Not a valid Weekly Mafia save file');
    }
    const parsed = migrate(raw);
    this.state = parsed;
    await this.persist();
    this.emit();
    return this.state;
  }

  /** Filename-safe timestamped backup name. */
  backupFilename() {
    const d = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    return `weekly-mafia-round${this.state.game.currentRound}-${d}.json`;
  }
}
