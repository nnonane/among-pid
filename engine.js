/* mafia v0.3 | engine.js | 30 Sep 2026 */
/*
  v0.2: Doctor and Sheriff retired. Every non-Mafia player is a Civilian.
  The only night action is the Mafia kill; Temporary Immunity is the only
  thing that can block it. Everything else is unchanged.
  v0.3: Discussion and Voting are one phase. Ballots are public - every
  player can see who voted for whom - while hidden weights (Extra Vote,
  Master double vote, Vote Manipulation) still only show in the final count.
*/
/*
  PURE GAME RULES. No DOM. No storage. No side effects.
  Every exported function takes plain data and returns plain data.
  This file must remain testable in isolation — it is what makes the
  Stage 2 (Supabase) swap safe.
*/

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ROLE = {
  MAFIA: 'MAFIA',
  CIVILIAN: 'CIVILIAN'
};
/** Roles that no longer exist. Old saves holding them become Civilian. */
export const RETIRED_ROLES = ['DOCTOR', 'SHERIFF'];

export const ALIGNMENT = { GOOD: 'GOOD', MAFIA: 'MAFIA' };

export const LIFE = { ALIVE: 'ALIVE', SPIRIT: 'SPIRIT' };

export const ATTENDANCE = {
  PRESENT: 'PRESENT',
  DORMANT: 'DORMANT',
  INACTIVE: 'INACTIVE'
};

export const PHASE = {
  CLOSED: 'CLOSED',
  ATTENDANCE: 'ATTENDANCE',
  HIDDEN_ACTIONS: 'HIDDEN_ACTIONS',
  MINIGAME: 'MINIGAME',
  REWARDS: 'REWARDS',
  RESOLUTION: 'RESOLUTION',
  MASTER: 'MASTER',
  VOTING: 'VOTING',       // discussion and voting together, on one timer
  RESULTS: 'RESULTS',
  FINISHED: 'FINISHED'
};

export const PHASE_ORDER = [
  PHASE.CLOSED,
  PHASE.ATTENDANCE,
  PHASE.HIDDEN_ACTIONS,
  PHASE.MINIGAME,
  PHASE.REWARDS,
  PHASE.RESOLUTION,
  PHASE.MASTER,
  PHASE.VOTING,
  PHASE.RESULTS
];

export const ACTION = {
  MAFIA_KILL_VOTE: 'MAFIA_KILL_VOTE'
};

export const ITEM = {
  TEMP_IMMUNITY: 'TEMP_IMMUNITY',
  EXTRA_VOTE: 'EXTRA_VOTE',
  DISCOUNTED_RESURRECTION: 'DISCOUNTED_RESURRECTION',
  VOTE_MANIPULATION: 'VOTE_MANIPULATION',
  RECRUIT_NEW_MAFIA: 'RECRUIT_NEW_MAFIA'
};

export const STORE = {
  [ROLE.CIVILIAN]: [
    ITEM.TEMP_IMMUNITY,
    ITEM.EXTRA_VOTE,
    ITEM.DISCOUNTED_RESURRECTION
  ],
  [ROLE.MAFIA]: [
    ITEM.VOTE_MANIPULATION,
    ITEM.RECRUIT_NEW_MAFIA
  ]
};

// Admin-configurable. Never hard-code these inline — surface them in settings.
export const DEFAULT_SETTINGS = {
  voteManipulationDirection: 1,        // +1 adds, -1 removes
  spiritPointsAttendance: 1,
  spiritPointsMinigameWin: 3,          // total, not additive
  resurrectionCost: 3,
  resurrectionDiscountedCost: 2,
  maxActiveMafiaFromRecruit: 3,
  tempImmunityCoversVote: true,
  masterEnabled: true,
  voteMinutes: 5                       // discussion & vote timer
};

// ---------------------------------------------------------------------------
// Seeded RNG — deterministic and auditable. Never use Math.random().
// ---------------------------------------------------------------------------

export function makeRng(seed) {
  let s = seed >>> 0;
  const draws = [];
  const next = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    draws,
    pick(candidates, reason) {
      if (!candidates.length) return null;
      const roll = next();
      const index = Math.floor(roll * candidates.length);
      const result = candidates[index];
      draws.push({ reason, candidates: [...candidates], roll, result });
      return result;
    },
    chance(probability, reason) {
      const roll = next();
      const result = roll < probability;
      draws.push({ reason, probability, roll, result });
      return result;
    },
    shuffle(list, reason) {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      draws.push({ reason, before: [...list], result: [...out] });
      return out;
    }
  };
}

// ---------------------------------------------------------------------------
// Player selectors
// ---------------------------------------------------------------------------

export const isProfileActive = (p) => p.attendanceStatus !== ATTENDANCE.INACTIVE;
export const isAlive = (p) => p.lifeStatus === LIFE.ALIVE && isProfileActive(p);
export const isPresent = (p) =>
  isAlive(p) && p.attendanceStatus === ATTENDANCE.PRESENT;
export const isSpirit = (p) =>
  p.lifeStatus === LIFE.SPIRIT && isProfileActive(p);

/** Players who can act, vote, or be targeted this round. */
export const eligiblePlayers = (players) => players.filter(isPresent);

export const alignmentOf = (role) =>
  role === ROLE.MAFIA ? ALIGNMENT.MAFIA : ALIGNMENT.GOOD;

export const countAliveMafia = (players) =>
  players.filter((p) => isAlive(p) && p.role === ROLE.MAFIA).length;

// ---------------------------------------------------------------------------
// Role balance
// ---------------------------------------------------------------------------

/**
 * Starting distribution per the design overview. Mafia counts are unchanged;
 * everyone who is not Mafia is a Civilian.
 */
export function startingBalance(playerCount) {
  let mafia;
  if (playerCount < 10) {
    // Below the documented range — scale down conservatively.
    mafia = Math.max(1, Math.floor(playerCount / 5));
  } else if (playerCount === 10) mafia = 2;
  else if (playerCount <= 13) mafia = 3;
  else mafia = 4;
  return { mafia, civilian: Math.max(playerCount - mafia, 0) };
}

export function assignStartingRoles(players, rng) {
  const balance = startingBalance(players.length);
  const order = rng.shuffle(players.map((p) => p.id), 'initial role assignment');
  const roles = new Map();
  let i = 0;
  for (let n = 0; n < balance.mafia; n++) roles.set(order[i++], ROLE.MAFIA);
  while (i < order.length) roles.set(order[i++], ROLE.CIVILIAN);

  return players.map((p) => {
    const role = roles.get(p.id);
    return { ...p, role, alignment: alignmentOf(role) };
  });
}

/**
 * Late joiner. Returns a suggested role only — the Super Admin previews and
 * may override before activation.
 */
export function suggestLateJoinerRole(players, rng, settings = DEFAULT_SETTINGS) {
  const living = players.filter(isAlive);
  const target = startingBalance(living.length + 1);
  const aliveMafia = countAliveMafia(players);
  const allowed = [ROLE.CIVILIAN];
  if (aliveMafia < Math.min(target.mafia, settings.maxActiveMafiaFromRecruit)) {
    allowed.push(ROLE.MAFIA);
  }
  return rng.pick(allowed, 'late joiner role');
}

// ---------------------------------------------------------------------------
// Inventory helpers
// ---------------------------------------------------------------------------

const hasUsableItem = (player, type, round) =>
  (player.inventory || []).some(
    (it) =>
      it.rewardType === type &&
      it.status === 'OWNED' &&
      (it.eligibleFromRound == null || it.eligibleFromRound <= round) &&
      (it.expiresRound == null || it.expiresRound >= round)
  );

/** Items the player has explicitly staged for use this round. */
const hasStagedItem = (player, type, round) =>
  (player.inventory || []).some(
    (it) =>
      it.rewardType === type &&
      it.status === 'STAGED' &&
      it.stagedRound === round
  );

export function canPurchase(player, rewardType, players, settings = DEFAULT_SETTINGS) {
  if (player.rewardTokens < 1) return { ok: false, reason: 'Insufficient tokens' };
  const store = STORE[player.role] || [];
  if (!store.includes(rewardType)) {
    return { ok: false, reason: 'Reward not available to this role' };
  }
  if (rewardType === ITEM.RECRUIT_NEW_MAFIA) {
    if (countAliveMafia(players) >= settings.maxActiveMafiaFromRecruit) {
      return { ok: false, reason: 'Would exceed maximum active Mafia' };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Hidden action resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the hidden-action phase.
 * @returns {{ death, blockedBy, savedTarget, mafiaTarget, publicEvent, privateEvents, log }}
 */
export function resolveHiddenActions(state, rng) {
  const round = state.game.currentRound;
  const players = state.players;
  const byId = new Map(players.map((p) => [p.id, p]));
  const actions = (state.currentActions || []).filter((a) => {
    const actor = byId.get(a.actorId);
    const target = a.targetId ? byId.get(a.targetId) : null;
    if (!actor || !isPresent(actor)) return false;
    if (a.targetId && (!target || !isPresent(target))) return false;
    return true;
  });

  const log = [];
  const privateEvents = [];

  // --- 1. Mafia target -----------------------------------------------------
  const mafiaBallots = actions.filter((a) => a.type === ACTION.MAFIA_KILL_VOTE);
  let mafiaTarget = null;

  if (mafiaBallots.length) {
    const tally = {};
    for (const b of mafiaBallots) tally[b.targetId] = (tally[b.targetId] || 0) + 1;
    const top = Math.max(...Object.values(tally));
    const tied = Object.keys(tally).filter((id) => tally[id] === top);
    mafiaTarget = tied.length === 1 ? tied[0] : rng.pick(tied, 'tied Mafia kill vote');
    log.push({ step: 'mafiaTarget', tally, tied, chosen: mafiaTarget });
  } else {
    log.push({ step: 'mafiaTarget', chosen: null, note: 'No Mafia ballots submitted' });
  }

  // --- 2. Immunity ---------------------------------------------------------
  const immune = new Set(
    players.filter((p) => hasUsableItem(p, ITEM.TEMP_IMMUNITY, round)).map((p) => p.id)
  );

  // --- 3. Kill outcome -----------------------------------------------------
  let death = null;
  let blockedBy = null;
  if (mafiaTarget) {
    if (immune.has(mafiaTarget)) blockedBy = 'IMMUNITY';
    else death = mafiaTarget;
  }
  log.push({ step: 'killOutcome', mafiaTarget, blockedBy, death });

  // --- 4. Public event — sealed until after minigame and rewards -----------
  const victim = death ? byId.get(death) : null;
  const publicEvent = death
    ? {
        type: 'DEATH',
        playerId: death,
        text: `${victim.displayName} was killed.`,
        revealAlignment: !!victim.flags?.revealAlignmentOnDeath,
        alignment: victim.flags?.revealAlignmentOnDeath ? victim.alignment : null
      }
    : { type: 'NO_DEATH', text: 'No one was killed.' };

  return {
    mafiaTarget,
    death,
    blockedBy,
    savedTarget: blockedBy ? mafiaTarget : null,
    publicEvent,
    privateEvents,
    log,
    rngDraws: rng.draws
  };
}

// ---------------------------------------------------------------------------
// Public vote
// ---------------------------------------------------------------------------

/**
 * @param ballots [{voterId, targetId}]
 * @param master {immunePlayerId, doubleVotePlayerId}
 * @param manipulation {targetId, delta} — anonymous Mafia adjustment
 */
export function resolveVote(state, ballots, master = {}, manipulation = null) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.game.settings || {}) };
  const round = state.game.currentRound;
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const totals = {};
  const log = [];

  const valid = ballots.filter((b) => {
    const voter = byId.get(b.voterId);
    const target = byId.get(b.targetId);
    return voter && target && isPresent(voter) && isPresent(target);
  });

  for (const b of valid) {
    const voter = byId.get(b.voterId);
    let weight = 1;
    if (hasStagedItem(voter, ITEM.EXTRA_VOTE, round)) weight += 1;
    if (master.doubleVotePlayerId === b.voterId) weight += 1;
    totals[b.targetId] = (totals[b.targetId] || 0) + weight;
  }

  if (manipulation && manipulation.targetId) {
    const delta = manipulation.delta ?? settings.voteManipulationDirection;
    totals[manipulation.targetId] = (totals[manipulation.targetId] || 0) + delta;
    log.push({ step: 'voteManipulation', targetId: manipulation.targetId, delta });
  }

  // Master immunity and temporary immunity remove a player from elimination
  // consideration, but their votes still counted above.
  const shielded = new Set();
  if (master.immunePlayerId) shielded.add(master.immunePlayerId);
  if (settings.tempImmunityCoversVote) {
    for (const p of state.players) {
      if (hasUsableItem(p, ITEM.TEMP_IMMUNITY, round)) shielded.add(p.id);
    }
  }

  const considered = Object.keys(totals).filter((id) => !shielded.has(id));
  let eliminated = null;
  let tie = false;

  if (considered.length) {
    const top = Math.max(...considered.map((id) => totals[id]));
    const leaders = considered.filter((id) => totals[id] === top);
    if (leaders.length === 1) eliminated = leaders[0];
    else tie = true;
    log.push({ step: 'tally', totals, shielded: [...shielded], top, leaders });
  }

  const victim = eliminated ? byId.get(eliminated) : null;
  return {
    totals,           // public
    eliminated,
    tie,
    shielded: [...shielded],
    revealedRole: victim ? victim.role : null,
    revealedAlignment:
      victim && victim.flags?.revealAlignmentOnDeath ? victim.alignment : null,
    log
  };
}

// ---------------------------------------------------------------------------
// Death, succession, Legacy
// ---------------------------------------------------------------------------

export function killPlayer(players, playerId) {
  return players.map((p) =>
    p.id === playerId ? { ...p, lifeStatus: LIFE.SPIRIT } : p
  );
}

/**
 * One-time only. Fires when active Mafia first reaches zero.
 * Countdown may disable an unused Legacy.
 */
export function checkMafiaLegacy(state, rng) {
  const { game, players } = state;
  if (game.legacyUsed) return { triggered: false, reason: 'Legacy already used' };
  if (game.countdownDisablesLegacy) return { triggered: false, reason: 'Disabled by Countdown' };
  if (countAliveMafia(players) > 0) return { triggered: false, reason: 'Mafia still active' };

  const candidates = players
    .filter((p) => isAlive(p) && p.role === ROLE.CIVILIAN)
    .map((p) => p.id);
  if (!candidates.length) return { triggered: false, reason: 'No eligible Civilian' };

  const chosenId = rng.pick(candidates, 'mafia legacy');
  return {
    triggered: true,
    chosenId,
    players: players.map((p) =>
      p.id === chosenId ? { ...p, role: ROLE.MAFIA, alignment: ALIGNMENT.MAFIA } : p
    ),
    game: { ...game, legacyUsed: true }
  };
}

export function recruitMafia(state, targetId, settings = DEFAULT_SETTINGS) {
  if (countAliveMafia(state.players) >= settings.maxActiveMafiaFromRecruit) {
    return { ok: false, reason: 'Would exceed maximum active Mafia' };
  }
  const target = state.players.find((p) => p.id === targetId);
  if (!target || !isAlive(target) || target.role === ROLE.MAFIA) {
    return { ok: false, reason: 'Ineligible target' };
  }
  return {
    ok: true,
    players: state.players.map((p) =>
      p.id === targetId ? { ...p, role: ROLE.MAFIA, alignment: ALIGNMENT.MAFIA } : p
    )
  };
}

// ---------------------------------------------------------------------------
// Spirits and resurrection
// ---------------------------------------------------------------------------

export function awardSpiritPoints(players, { attendedIds = [], minigameWinnerIds = [] }, settings = DEFAULT_SETTINGS) {
  const winners = new Set(minigameWinnerIds);
  return players.map((p) => {
    if (!isSpirit(p)) return p;
    if (winners.has(p.id)) {
      // Total, never additive with the attendance point.
      return { ...p, spiritPoints: p.spiritPoints + settings.spiritPointsMinigameWin };
    }
    if (attendedIds.includes(p.id)) {
      return { ...p, spiritPoints: p.spiritPoints + settings.spiritPointsAttendance };
    }
    return p;
  });
}

export function resurrectionCost(player, settings = DEFAULT_SETTINGS) {
  const discounted = (player.inventory || []).some(
    (it) => it.rewardType === ITEM.DISCOUNTED_RESURRECTION && it.status === 'OWNED'
  );
  return discounted ? settings.resurrectionDiscountedCost : settings.resurrectionCost;
}

export function resurrect(state, playerId) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.game.settings || {}) };
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !isSpirit(player)) return { ok: false, reason: 'Not a Spirit' };

  const cost = resurrectionCost(player, settings);
  if (player.spiritPoints < cost) {
    return { ok: false, reason: `Needs ${cost} Spirit Points, has ${player.spiritPoints}` };
  }

  const usedDiscount = cost === settings.resurrectionDiscountedCost;
  const players = state.players.map((p) => {
    if (p.id !== playerId) return p;
    return {
      ...p,
      role: ROLE.CIVILIAN,               // always returns as Civilian
      alignment: ALIGNMENT.GOOD,
      lifeStatus: LIFE.ALIVE,
      attendanceStatus: ATTENDANCE.PRESENT,
      spiritPoints: p.spiritPoints - cost,
      inventory: (p.inventory || []).map((it) =>
        usedDiscount && it.rewardType === ITEM.DISCOUNTED_RESURRECTION && it.status === 'OWNED'
          ? { ...it, status: 'USED', usedRound: state.game.currentRound }
          : it
      )
    };
  });

  return { ok: true, players, cost };
}

// ---------------------------------------------------------------------------
// Endgame
// ---------------------------------------------------------------------------

/**
 * Parity excludes Spirits and Dormant players.
 * Call AFTER Legacy has been evaluated.
 */
export function checkEndgame(state) {
  const { game, players } = state;
  const activeMafia = players.filter(
    (p) => isPresent(p) && p.role === ROLE.MAFIA
  ).length;
  const activeGood = players.filter(
    (p) => isPresent(p) && p.role !== ROLE.MAFIA
  ).length;
  const aliveMafia = countAliveMafia(players);

  if (aliveMafia === 0 && (game.legacyUsed || game.countdownDisablesLegacy)) {
    return { finished: true, winner: 'GOOD', reason: 'No Mafia remain and Legacy is spent' };
  }
  if (activeMafia > 0 && activeMafia >= activeGood) {
    return { finished: true, winner: 'MAFIA', reason: 'Mafia equal or outnumber living Good players' };
  }
  if (game.countdownEnabled && game.roundsRemaining <= 0) {
    return {
      finished: true,
      winner: aliveMafia === 0 ? 'GOOD' : 'MAFIA',
      reason: 'Countdown expired'
    };
  }
  return { finished: false, activeMafia, activeGood };
}

// ---------------------------------------------------------------------------
// Phase machine
// ---------------------------------------------------------------------------

export function nextPhase(current) {
  if (current === PHASE.FINISHED) return PHASE.FINISHED;
  const i = PHASE_ORDER.indexOf(current);
  if (i === -1) return PHASE.CLOSED;
  // RESULTS loops back to CLOSED; the round counter increments on reopen.
  return i === PHASE_ORDER.length - 1 ? PHASE.CLOSED : PHASE_ORDER[i + 1];
}

export function previousPhase(current) {
  const i = PHASE_ORDER.indexOf(current);
  return i <= 0 ? PHASE.CLOSED : PHASE_ORDER[i - 1];
}

/** What a given viewer is permitted to see. Enforced again in ui.js. */
export function visibleStateFor(state, viewer) {
  const isAdmin = viewer.accessType === 'SUPER_ADMIN' || viewer.accessType === 'SPECTATOR_ADMIN';
  if (isAdmin) return state;

  const closed = state.game.status === PHASE.CLOSED;
  return {
    ...state,
    players: state.players.map((p) => {
      const own = p.id === viewer.id;
      const mafiaPeer =
        viewer.role === ROLE.MAFIA && p.role === ROLE.MAFIA && isAlive(viewer);
      return {
        id: p.id,
        displayName: p.displayName,
        lifeStatus: p.lifeStatus,
        attendanceStatus: p.attendanceStatus,
        role: own || mafiaPeer ? p.role : null,
        alignment: own || mafiaPeer ? p.alignment : null,
        rewardTokens: own ? p.rewardTokens : null,
        spiritPoints: own ? p.spiritPoints : null,
        inventory: own ? p.inventory : null
      };
    }),
    currentActions: undefined,
    // Ballots are public: who voted for whom. Weights are not.
    currentBallots: (state.currentBallots || []).map((b) => ({
      voterId: b.voterId, targetId: b.targetId
    })),
    audit: undefined,
    storeVisible: closed ? [] : STORE[viewer.role] || []
  };
}
