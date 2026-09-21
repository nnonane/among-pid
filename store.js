/* mafia v0.1 | store.js | 22 Sep 2026 */
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
      globalThis.localStorage?.setItem(this.key, JSON.stringify(state));
      return true;
    } catch (err) {
      console.error('[store] save failed', err);
      return false;
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
          before: auditEntry.trackDiff ? before : undefined,
          after: auditEntry.trackDiff ? next : undefined
        }
      ];
    }

    this.state = next;
    await this.adapter.save(this.state);
    this.emit();
    return this.state;
  }

  async reset() {
    this.state = blankState();
    await this.adapter.save(this.state);
    this.emit();
  }

  // --- Backup -------------------------------------------------------------

  exportJson() {
    return JSON.stringify(this.state, null, 2);
  }

  async importJson(json) {
    const raw = typeof json === 'string' ? JSON.parse(json) : json;
    if (!raw || typeof raw !== 'object' || !raw.game || !Array.isArray(raw.players)) {
      throw new Error('Not a valid Weekly Mafia save file');
    }
    const parsed = migrate(raw);
    this.state = parsed;
    await this.adapter.save(this.state);
    this.emit();
    return this.state;
  }

  /** Filename-safe timestamped backup name. */
  backupFilename() {
    const d = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    return `weekly-mafia-round${this.state.game.currentRound}-${d}.json`;
  }
}
