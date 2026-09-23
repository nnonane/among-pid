/* mafia v0.4 | live.js | 23 Sep 2026 */
/*
  PLAYER SUBMISSIONS -> ADMIN CONSOLE.

  This is the only file that reads the actions, ballots, purchases and
  private_events tables from the console side. engine.js is untouched:
  everything here produces exactly the shapes it already expects, which is
  why all 72 engine tests still run in Node with no network.

  ONE WRITER RULE
  ---------------
  Players write to actions, ballots and purchases. They never write to
  players. The console writes to players and never has to merge a
  concurrent edit into a row it is already holding in memory. That is what
  makes a purchase made at 7:04 survive an admin save at 7:05.

  A purchase is therefore a REQUEST. The design overview is explicit that a
  token is removed only after a valid purchase is accepted, so acceptance
  runs through engine.canPurchase in the console exactly as a manual
  purchase always has.

  ADMIN OVERRIDE ALWAYS WINS
  --------------------------
  Every merged row carries a source. Once the admin touches a row by hand it
  is marked ADMIN and later syncs leave it alone, so correcting a misheard
  action over the phone is never silently undone by the player's own stale
  submission thirty seconds later.
*/

export const SOURCE = { PLAYER: 'PLAYER', ADMIN: 'ADMIN' };

export class Live {
  constructor(sb) {
    this.sb = sb;
    this.lastError = null;
  }

  /** Swallows the error, records it, returns a fallback. Game night never stops. */
  async #safe(promise, fallback) {
    try {
      const { data, error } = await promise;
      if (error) {
        this.lastError = error.message;
        return fallback;
      }
      this.lastError = null;
      return data ?? fallback;
    } catch (err) {
      this.lastError = err.message;
      return fallback;
    }
  }

  /* ------------------------------------------------------------ reads - */

  async fetchActions(round) {
    const rows = await this.#safe(
      this.sb.from('actions')
        .select('round, actor_id, type, target_id, secondary_target_id, submitted_at')
        .eq('round', round),
      []
    );
    return rows.map((r) => ({
      actorId: r.actor_id,
      type: r.type,
      targetId: r.target_id ?? null,
      secondaryTargetId: r.secondary_target_id ?? null,
      submittedAt: r.submitted_at,
      source: SOURCE.PLAYER
    }));
  }

  async fetchBallots(round) {
    const rows = await this.#safe(
      this.sb.from('ballots')
        .select('round, voter_id, target_id, submitted_at')
        .eq('round', round),
      []
    );
    return rows.map((r) => ({
      voterId: r.voter_id,
      targetId: r.target_id,
      submittedAt: r.submitted_at,
      source: SOURCE.PLAYER
    }));
  }

  async fetchPendingPurchases(round) {
    const rows = await this.#safe(
      this.sb.from('purchases')
        .select('id, round, player_id, reward_type, target_id, status, created_at')
        .eq('round', round)
        .eq('status', 'PENDING')
        .order('created_at'),
      []
    );
    return rows.map((r) => ({
      id: r.id,
      playerId: r.player_id,
      rewardType: r.reward_type,
      targetId: r.target_id ?? null,
      createdAt: r.created_at
    }));
  }

  /* ----------------------------------------------------------- writes - */

  async decidePurchase(id, status, reason = null) {
    const { error } = await this.sb.from('purchases')
      .update({ status, decided_reason: reason })
      .eq('id', id);
    if (error) {
      this.lastError = error.message;
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  }

  /** Sheriff findings and anything else addressed to one person. */
  async pushPrivateEvents(round, events) {
    if (!events || !events.length) return { ok: true };
    const rows = events.map((e) => ({
      round,
      to_player_id: e.toPlayerId,
      type: e.type,
      body: e.text
    }));
    const { error } = await this.sb.from('private_events').insert(rows);
    if (error) {
      this.lastError = error.message;
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  }

  /** Called when a new session opens, so last week cannot leak into this one. */
  async clearRound(round) {
    const { error } = await this.sb.rpc('clear_round', { p_round: round });
    if (error) {
      this.lastError = error.message;
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  }
}

/* ------------------------------------------------------------- merging - */

/**
 * Folds player submissions into the admin's action list.
 * Admin-entered rows are left exactly as they are.
 */
export function mergeActions(existing = [], incoming = []) {
  const byActor = new Map(existing.map((a) => [a.actorId, a]));
  for (const row of incoming) {
    const current = byActor.get(row.actorId);
    if (current && current.source === SOURCE.ADMIN) continue; // admin wins
    byActor.set(row.actorId, row);
  }
  return [...byActor.values()];
}

export function mergeBallots(existing = [], incoming = []) {
  const byVoter = new Map(existing.map((b) => [b.voterId, b]));
  for (const row of incoming) {
    const current = byVoter.get(row.voterId);
    if (current && current.source === SOURCE.ADMIN) continue; // admin wins
    byVoter.set(row.voterId, row);
  }
  return [...byVoter.values()];
}

/** Counts submitted vs expected, for the waiting-on indicator. */
export function submissionTally(expectedIds, rows, key) {
  const done = new Set(rows.filter((r) => r[key]).map((r) => r[key]));
  const submitted = expectedIds.filter((id) => done.has(id));
  return {
    submitted,
    waiting: expectedIds.filter((id) => !done.has(id)),
    count: submitted.length,
    total: expectedIds.length
  };
}
