/* mafia v0.1 | tests.js | 22 Sep 2026 */
/* Disposable test harness. Runs in Node or in the browser via tests.html. */

import * as E from './engine.js';
import { Store, MemoryAdapter, blankState, newPlayer, newInventoryItem } from './store.js';

const results = [];
let currentSuite = '';

const pending = [];
function suite(name) { currentSuite = name; }
function test(name, fn) {
  const suiteName = currentSuite;
  const record = (pass, error) =>
    results.push({ suite: suiteName, name, pass, error });
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      pending.push(out.then(() => record(true), (err) => record(false, err.message)));
    } else {
      record(true);
    }
  } catch (err) {
    record(false, err.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'Expected equal'} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}

// --- fixtures --------------------------------------------------------------

function makeState(spec, gameOverrides = {}) {
  const s = blankState('Test Game');
  s.game = { ...s.game, currentRound: 1, ...gameOverrides };
  s.players = spec.map((p, i) => ({
    ...newPlayer(p.name || `P${i}`),
    id: p.id || `p${i}`,
    role: p.role || E.ROLE.CIVILIAN,
    alignment: E.alignmentOf(p.role || E.ROLE.CIVILIAN),
    lifeStatus: p.life || E.LIFE.ALIVE,
    attendanceStatus: p.att || E.ATTENDANCE.PRESENT,
    rewardTokens: p.tokens ?? 0,
    spiritPoints: p.points ?? 0,
    inventory: p.inventory || [],
    flags: p.flags || {}
  }));
  return s;
}

const staged = (type, round) => ({
  ...newInventoryItem(type, round - 1),
  status: 'STAGED',
  stagedRound: round
});
const owned = (type, round) => ({
  ...newInventoryItem(type, round - 1),
  status: 'OWNED',
  eligibleFromRound: round
});

// ===========================================================================
suite('Role balance');

test('10 players = 2 Mafia, 1 Doctor, 1 Sheriff', () => {
  const b = E.startingBalance(10);
  eq(b.mafia, 2); eq(b.doctor, 1); eq(b.sheriff, 1);
});
test('12 players = 3 Mafia', () => eq(E.startingBalance(12).mafia, 3));
test('15 players = 4 Mafia', () => eq(E.startingBalance(15).mafia, 4));
test('assignment produces exactly the target distribution', () => {
  const players = Array.from({ length: 13 }, (_, i) => newPlayer(`P${i}`));
  const assigned = E.assignStartingRoles(players, E.makeRng(42));
  eq(assigned.filter(p => p.role === E.ROLE.MAFIA).length, 3, 'Mafia count');
  eq(assigned.filter(p => p.role === E.ROLE.DOCTOR).length, 1, 'Doctor count');
  eq(assigned.filter(p => p.role === E.ROLE.SHERIFF).length, 1, 'Sheriff count');
  eq(assigned.filter(p => p.role === E.ROLE.CIVILIAN).length, 8, 'Civilian count');
  assert(assigned.every(p => p.alignment === E.alignmentOf(p.role)), 'alignment matches role');
});
test('assignment is deterministic for a given seed', () => {
  const players = Array.from({ length: 11 }, (_, i) => ({ ...newPlayer(`P${i}`), id: `p${i}` }));
  const a = E.assignStartingRoles(players, E.makeRng(7)).map(p => p.role).join();
  const b = E.assignStartingRoles(players, E.makeRng(7)).map(p => p.role).join();
  eq(a, b);
});

// ===========================================================================
suite('Hidden action resolution');

const baseCast = [
  { id: 'm1', role: E.ROLE.MAFIA }, { id: 'm2', role: E.ROLE.MAFIA },
  { id: 'doc', role: E.ROLE.DOCTOR }, { id: 'sh', role: E.ROLE.SHERIFF },
  { id: 'c1' }, { id: 'c2' }, { id: 'c3' }
];

test('majority Mafia target is killed', () => {
  const s = makeState(baseCast);
  s.currentActions = [
    { actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' },
    { actorId: 'm2', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' }
  ];
  const r = E.resolveHiddenActions(s, E.makeRng(1));
  eq(r.death, 'c1');
  eq(r.publicEvent.type, 'DEATH');
});

test('tied Mafia vote produces a logged random target', () => {
  const s = makeState(baseCast);
  s.currentActions = [
    { actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' },
    { actorId: 'm2', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c2' }
  ];
  const rng = E.makeRng(3);
  const r = E.resolveHiddenActions(s, rng);
  assert(['c1', 'c2'].includes(r.death), 'one of the tied targets died');
  assert(rng.draws.some(d => d.reason === 'tied Mafia kill vote'), 'random draw was logged');
});

test('Doctor save blocks the kill', () => {
  const s = makeState(baseCast);
  s.currentActions = [
    { actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' },
    { actorId: 'doc', type: E.ACTION.DOCTOR_SAVE, targetId: 'c1' }
  ];
  const r = E.resolveHiddenActions(s, E.makeRng(1));
  eq(r.death, null);
  eq(r.blockedBy, 'DOCTOR');
  eq(r.publicEvent.type, 'NO_DEATH');
});

test('Bypass Doctor Save defeats the save', () => {
  const cast = baseCast.map(p => p.id === 'm1'
    ? { ...p, inventory: [staged(E.ITEM.BYPASS_DOCTOR_SAVE, 1)] } : p);
  const s = makeState(cast);
  s.currentActions = [
    { actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' },
    { actorId: 'doc', type: E.ACTION.DOCTOR_SAVE, targetId: 'c1' }
  ];
  const r = E.resolveHiddenActions(s, E.makeRng(1));
  eq(r.death, 'c1');
});

test('Temporary Immunity blocks the kill even with Bypass', () => {
  const cast = baseCast.map(p => {
    if (p.id === 'm1') return { ...p, inventory: [staged(E.ITEM.BYPASS_DOCTOR_SAVE, 1)] };
    if (p.id === 'c1') return { ...p, inventory: [owned(E.ITEM.TEMP_IMMUNITY, 1)] };
    return p;
  });
  const s = makeState(cast);
  s.currentActions = [{ actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' }];
  const r = E.resolveHiddenActions(s, E.makeRng(1));
  eq(r.death, null);
  eq(r.blockedBy, 'IMMUNITY');
});

test('Self Save is rejected unless the item is staged', () => {
  const s = makeState(baseCast);
  s.currentActions = [
    { actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'doc' },
    { actorId: 'doc', type: E.ACTION.DOCTOR_SAVE, targetId: 'doc' }
  ];
  eq(E.resolveHiddenActions(s, E.makeRng(1)).death, 'doc');
});

test('Self Save works when staged', () => {
  const cast = baseCast.map(p => p.id === 'doc'
    ? { ...p, inventory: [staged(E.ITEM.SELF_SAVE, 1)] } : p);
  const s = makeState(cast);
  s.currentActions = [
    { actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'doc' },
    { actorId: 'doc', type: E.ACTION.DOCTOR_SAVE, targetId: 'doc' }
  ];
  eq(E.resolveHiddenActions(s, E.makeRng(1)).death, null);
});

test('Dormant players cannot act or be targeted', () => {
  const cast = baseCast.map(p => p.id === 'c1' ? { ...p, att: E.ATTENDANCE.DORMANT } : p);
  const s = makeState(cast);
  s.currentActions = [{ actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' }];
  const r = E.resolveHiddenActions(s, E.makeRng(1));
  eq(r.mafiaTarget, null, 'action against a Dormant player is discarded');
  eq(r.death, null);
});

test('all Mafia absent means no kill', () => {
  const cast = baseCast.map(p =>
    p.role === E.ROLE.MAFIA ? { ...p, att: E.ATTENDANCE.DORMANT } : p);
  const s = makeState(cast);
  s.currentActions = [{ actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' }];
  eq(E.resolveHiddenActions(s, E.makeRng(1)).death, null);
});

test('Sheriff finding on Mafia is always SUSPICIOUS', () => {
  const s = makeState(baseCast);
  s.currentActions = [{ actorId: 'sh', type: E.ACTION.SHERIFF_INVESTIGATE, targetId: 'm1' }];
  eq(E.resolveHiddenActions(s, E.makeRng(1)).sheriffResults[0].verdict, 'SUSPICIOUS');
});

test('INNOCENT is never returned for a Mafia target across many seeds', () => {
  for (let seed = 0; seed < 200; seed++) {
    const s = makeState(baseCast);
    s.currentActions = [{ actorId: 'sh', type: E.ACTION.SHERIFF_INVESTIGATE, targetId: 'm2' }];
    eq(E.resolveHiddenActions(s, E.makeRng(seed)).sheriffResults[0].verdict, 'SUSPICIOUS',
      `seed ${seed}`);
  }
});

test('non-Mafia can return SUSPICIOUS (inconclusive by design)', () => {
  let sus = 0;
  for (let seed = 0; seed < 200; seed++) {
    const s = makeState(baseCast);
    s.currentActions = [{ actorId: 'sh', type: E.ACTION.SHERIFF_INVESTIGATE, targetId: 'c1' }];
    if (E.resolveHiddenActions(s, E.makeRng(seed)).sheriffResults[0].verdict === 'SUSPICIOUS') sus++;
  }
  assert(sus > 10 && sus < 120, `false positives within sane range, got ${sus}/200`);
});

test('Additional Investigation yields two results', () => {
  const cast = baseCast.map(p => p.id === 'sh'
    ? { ...p, inventory: [staged(E.ITEM.ADDITIONAL_INVESTIGATION, 1)] } : p);
  const s = makeState(cast);
  s.currentActions = [{
    actorId: 'sh', type: E.ACTION.SHERIFF_INVESTIGATE, targetId: 'c1', secondaryTargetId: 'c2'
  }];
  eq(E.resolveHiddenActions(s, E.makeRng(1)).sheriffResults.length, 2);
});

test('Sheriff results are private events only', () => {
  const s = makeState(baseCast);
  s.currentActions = [{ actorId: 'sh', type: E.ACTION.SHERIFF_INVESTIGATE, targetId: 'm1' }];
  const r = E.resolveHiddenActions(s, E.makeRng(1));
  assert(r.privateEvents.every(e => e.toPlayerId === 'sh'), 'addressed only to the Sheriff');
  assert(!JSON.stringify(r.publicEvent).includes('SUSPICIOUS'), 'nothing leaks publicly');
});

// ===========================================================================
suite('Public vote');

test('highest unique total is eliminated and role revealed', () => {
  const s = makeState(baseCast);
  const r = E.resolveVote(s, [
    { voterId: 'c1', targetId: 'm1' }, { voterId: 'c2', targetId: 'm1' },
    { voterId: 'c3', targetId: 'c1' }
  ]);
  eq(r.eliminated, 'm1');
  eq(r.revealedRole, E.ROLE.MAFIA);
});

test('tie produces no elimination', () => {
  const s = makeState(baseCast);
  const r = E.resolveVote(s, [
    { voterId: 'c1', targetId: 'm1' }, { voterId: 'c2', targetId: 'c3' }
  ]);
  eq(r.eliminated, null);
  eq(r.tie, true);
});

test('Extra Vote adds one weight', () => {
  const cast = baseCast.map(p => p.id === 'c1'
    ? { ...p, inventory: [staged(E.ITEM.EXTRA_VOTE, 1)] } : p);
  const s = makeState(cast);
  const r = E.resolveVote(s, [
    { voterId: 'c1', targetId: 'm1' }, { voterId: 'c2', targetId: 'c3' }
  ]);
  eq(r.totals.m1, 2);
  eq(r.eliminated, 'm1');
});

test('Master double vote adds one weight', () => {
  const s = makeState(baseCast);
  const r = E.resolveVote(s, [
    { voterId: 'c1', targetId: 'm1' }, { voterId: 'c2', targetId: 'c3' }
  ], { doubleVotePlayerId: 'c1' });
  eq(r.totals.m1, 2);
  eq(r.eliminated, 'm1');
});

test('Master immunity removes the leader from elimination', () => {
  const s = makeState(baseCast);
  const r = E.resolveVote(s, [
    { voterId: 'c1', targetId: 'm1' }, { voterId: 'c2', targetId: 'm1' },
    { voterId: 'c3', targetId: 'c2' }
  ], { immunePlayerId: 'm1' });
  eq(r.eliminated, 'c2', 'next eligible total is eliminated');
  eq(r.totals.m1, 2, 'votes still counted publicly');
});

test('Master immunity leaving a tie means no elimination', () => {
  const s = makeState(baseCast);
  const r = E.resolveVote(s, [
    { voterId: 'c1', targetId: 'm1' }, { voterId: 'c2', targetId: 'c2' },
    { voterId: 'c3', targetId: 'c3' }
  ], { immunePlayerId: 'm1' });
  eq(r.eliminated, null);
  eq(r.tie, true);
});

test('Vote Manipulation applies anonymously', () => {
  const s = makeState(baseCast);
  const r = E.resolveVote(s,
    [{ voterId: 'c1', targetId: 'c2' }, { voterId: 'c3', targetId: 'm1' }],
    {}, { targetId: 'c2', delta: 1 });
  eq(r.totals.c2, 2);
  eq(r.eliminated, 'c2');
  assert(!('voterId' in r.totals), 'totals expose no voter identity');
});

test('vote totals never identify who voted', () => {
  const s = makeState(baseCast);
  const r = E.resolveVote(s, [{ voterId: 'c1', targetId: 'm1' }]);
  const json = JSON.stringify({ totals: r.totals, eliminated: r.eliminated, tie: r.tie });
  assert(!json.includes('c1'), 'voter id absent from public payload');
});

test('Spirits and Dormant players cannot vote or be voted for', () => {
  const cast = baseCast.map(p => {
    if (p.id === 'c1') return { ...p, life: E.LIFE.SPIRIT };
    if (p.id === 'c2') return { ...p, att: E.ATTENDANCE.DORMANT };
    return p;
  });
  const s = makeState(cast);
  const r = E.resolveVote(s, [
    { voterId: 'c1', targetId: 'm1' },   // spirit voting
    { voterId: 'c3', targetId: 'c2' }    // voting for a dormant player
  ]);
  eq(Object.keys(r.totals).length, 0);
  eq(r.eliminated, null);
});

// ===========================================================================
suite('Doctor succession');

test('random living non-Mafia inherits Doctor', () => {
  let players = makeState(baseCast).players;
  players = E.killPlayer(players, 'doc');
  const r = E.applyDoctorSuccession(players, 'doc', E.makeRng(5));
  const successor = r.players.find(p => p.id === r.successorId);
  eq(successor.role, E.ROLE.DOCTOR);
  assert(successor.alignment === E.ALIGNMENT.GOOD, 'successor is Good');
  assert(!['m1', 'm2'].includes(r.successorId), 'never a Mafia member');
});

test('no succession when a non-Doctor dies', () => {
  const players = makeState(baseCast).players;
  eq(E.applyDoctorSuccession(players, 'c1', E.makeRng(5)).successorId, null);
});

test('Doctor post vacant when no eligible successor exists', () => {
  let s = makeState([
    { id: 'm1', role: E.ROLE.MAFIA }, { id: 'doc', role: E.ROLE.DOCTOR }
  ]);
  const players = E.killPlayer(s.players, 'doc');
  const r = E.applyDoctorSuccession(players, 'doc', E.makeRng(5));
  eq(r.successorId, null);
  eq(r.vacant, true);
});

// ===========================================================================
suite('Mafia Legacy');

test('does not trigger while Mafia remain', () => {
  const s = makeState(baseCast);
  eq(E.checkMafiaLegacy(s, E.makeRng(1)).triggered, false);
});

test('triggers once when the last Mafia dies, creating exactly one Mafia', () => {
  const s = makeState(baseCast);
  s.players = E.killPlayer(E.killPlayer(s.players, 'm1'), 'm2');
  const r = E.checkMafiaLegacy(s, E.makeRng(9));
  eq(r.triggered, true);
  eq(E.countAliveMafia(r.players), 1, 'exactly one replacement');
  eq(r.game.legacyUsed, true);
});

test('cannot trigger a second time', () => {
  const s = makeState(baseCast, { legacyUsed: true });
  s.players = E.killPlayer(E.killPlayer(s.players, 'm1'), 'm2');
  eq(E.checkMafiaLegacy(s, E.makeRng(9)).triggered, false);
});

test('Countdown can disable an unused Legacy', () => {
  const s = makeState(baseCast, { countdownDisablesLegacy: true });
  s.players = E.killPlayer(E.killPlayer(s.players, 'm1'), 'm2');
  eq(E.checkMafiaLegacy(s, E.makeRng(9)).triggered, false);
});

test('only Civilians are eligible for Legacy', () => {
  for (let seed = 0; seed < 50; seed++) {
    const s = makeState(baseCast);
    s.players = E.killPlayer(E.killPlayer(s.players, 'm1'), 'm2');
    const r = E.checkMafiaLegacy(s, E.makeRng(seed));
    assert(['c1', 'c2', 'c3'].includes(r.chosenId), `seed ${seed} chose ${r.chosenId}`);
  }
});

// ===========================================================================
suite('Recruitment cap');

test('recruitment blocked at three active Mafia', () => {
  const s = makeState([
    { id: 'm1', role: E.ROLE.MAFIA }, { id: 'm2', role: E.ROLE.MAFIA },
    { id: 'm3', role: E.ROLE.MAFIA }, { id: 'c1' }, { id: 'c2' }
  ]);
  const r = E.recruitMafia(s, 'c1');
  eq(r.ok, false);
});

test('blocked purchase does not charge a token', () => {
  const s = makeState([
    { id: 'm1', role: E.ROLE.MAFIA, tokens: 1 }, { id: 'm2', role: E.ROLE.MAFIA },
    { id: 'm3', role: E.ROLE.MAFIA }, { id: 'c1' }
  ]);
  const mafioso = s.players[0];
  const check = E.canPurchase(mafioso, E.ITEM.RECRUIT_NEW_MAFIA, s.players);
  eq(check.ok, false);
  eq(mafioso.rewardTokens, 1, 'token untouched');
});

test('recruitment succeeds below the cap', () => {
  const s = makeState([
    { id: 'm1', role: E.ROLE.MAFIA }, { id: 'm2', role: E.ROLE.MAFIA },
    { id: 'c1' }, { id: 'c2' }
  ]);
  const r = E.recruitMafia(s, 'c1');
  eq(r.ok, true);
  eq(E.countAliveMafia(r.players), 3);
});

// ===========================================================================
suite('Reward store access');

test('a Civilian cannot buy a Mafia reward', () => {
  const s = makeState([{ id: 'c1', tokens: 5 }]);
  eq(E.canPurchase(s.players[0], E.ITEM.BYPASS_DOCTOR_SAVE, s.players).ok, false);
});

test('purchase blocked without a token', () => {
  const s = makeState([{ id: 'c1', tokens: 0 }]);
  eq(E.canPurchase(s.players[0], E.ITEM.EXTRA_VOTE, s.players).ok, false);
});

test('valid purchase is permitted', () => {
  const s = makeState([{ id: 'c1', tokens: 1 }]);
  eq(E.canPurchase(s.players[0], E.ITEM.EXTRA_VOTE, s.players).ok, true);
});

test('immunity cannot be applied retroactively', () => {
  const item = newInventoryItem(E.ITEM.TEMP_IMMUNITY, 3);
  eq(item.eligibleFromRound, 4);
});

// ===========================================================================
suite('Spirits and resurrection');

test('attendance awards 1 point, minigame win awards 3 and never both', () => {
  const s = makeState([
    { id: 'c1', life: E.LIFE.SPIRIT }, { id: 'c2', life: E.LIFE.SPIRIT }
  ]);
  const out = E.awardSpiritPoints(s.players,
    { attendedIds: ['c1', 'c2'], minigameWinnerIds: ['c2'] });
  eq(out.find(p => p.id === 'c1').spiritPoints, 1);
  eq(out.find(p => p.id === 'c2').spiritPoints, 3, 'total of 3, not 1 + 3');
});

test('living players earn no Spirit Points', () => {
  const s = makeState([{ id: 'c1' }]);
  eq(E.awardSpiritPoints(s.players, { attendedIds: ['c1'] })[0].spiritPoints, 0);
});

test('resurrection costs 3 and returns a Civilian', () => {
  const s = makeState([{ id: 'doc', role: E.ROLE.DOCTOR, life: E.LIFE.SPIRIT, points: 3 }]);
  const r = E.resurrect(s, 'doc');
  eq(r.ok, true);
  const p = r.players[0];
  eq(p.role, E.ROLE.CIVILIAN, 'former Doctor returns as Civilian');
  eq(p.alignment, E.ALIGNMENT.GOOD);
  eq(p.lifeStatus, E.LIFE.ALIVE);
  eq(p.spiritPoints, 0);
});

test('a resurrected Mafia returns Good', () => {
  const s = makeState([{ id: 'm1', role: E.ROLE.MAFIA, life: E.LIFE.SPIRIT, points: 3 }]);
  const p = E.resurrect(s, 'm1').players[0];
  eq(p.role, E.ROLE.CIVILIAN);
  eq(p.alignment, E.ALIGNMENT.GOOD);
});

test('discount lowers the cost to 2 and consumes the item', () => {
  const s = makeState([{
    id: 'c1', life: E.LIFE.SPIRIT, points: 2,
    inventory: [newInventoryItem(E.ITEM.DISCOUNTED_RESURRECTION, 0)]
  }]);
  const r = E.resurrect(s, 'c1');
  eq(r.ok, true);
  eq(r.cost, 2);
  eq(r.players[0].inventory[0].status, 'USED');
});

test('resurrection refused with insufficient points', () => {
  const s = makeState([{ id: 'c1', life: E.LIFE.SPIRIT, points: 2 }]);
  eq(E.resurrect(s, 'c1').ok, false);
});

// ===========================================================================
suite('Endgame');

test('Good wins when no Mafia remain and Legacy is spent', () => {
  const s = makeState(baseCast, { legacyUsed: true });
  s.players = E.killPlayer(E.killPlayer(s.players, 'm1'), 'm2');
  const r = E.checkEndgame(s);
  eq(r.finished, true);
  eq(r.winner, 'GOOD');
});

test('game continues when Legacy is still available', () => {
  const s = makeState(baseCast);
  s.players = E.killPlayer(E.killPlayer(s.players, 'm1'), 'm2');
  eq(E.checkEndgame(s).finished, false);
});

test('Mafia win on parity', () => {
  const s = makeState([
    { id: 'm1', role: E.ROLE.MAFIA }, { id: 'm2', role: E.ROLE.MAFIA },
    { id: 'c1' }, { id: 'c2' }
  ]);
  const r = E.checkEndgame(s);
  eq(r.finished, true);
  eq(r.winner, 'MAFIA');
});

test('Spirits and Dormant players are excluded from parity', () => {
  const s = makeState([
    { id: 'm1', role: E.ROLE.MAFIA },
    { id: 'c1' }, { id: 'c2', life: E.LIFE.SPIRIT }, { id: 'c3', att: E.ATTENDANCE.DORMANT }
  ]);
  const r = E.checkEndgame(s);
  eq(r.finished, true, '1 Mafia vs 1 active Good is parity');
  eq(r.winner, 'MAFIA');
});

test('Countdown expiry decides the winner', () => {
  const s = makeState(baseCast, { countdownEnabled: true, roundsRemaining: 0 });
  eq(E.checkEndgame(s).winner, 'MAFIA', 'Mafia still alive at expiry');
  const s2 = makeState(baseCast, { countdownEnabled: true, roundsRemaining: 0, legacyUsed: true });
  s2.players = E.killPlayer(E.killPlayer(s2.players, 'm1'), 'm2');
  eq(E.checkEndgame(s2).winner, 'GOOD');
});

// ===========================================================================
suite('Phase machine');

test('phases advance in the documented order', () => {
  eq(E.nextPhase(E.PHASE.CLOSED), E.PHASE.ATTENDANCE);
  eq(E.nextPhase(E.PHASE.ATTENDANCE), E.PHASE.HIDDEN_ACTIONS);
  eq(E.nextPhase(E.PHASE.HIDDEN_ACTIONS), E.PHASE.MINIGAME);
  eq(E.nextPhase(E.PHASE.MINIGAME), E.PHASE.REWARDS);
  eq(E.nextPhase(E.PHASE.REWARDS), E.PHASE.RESOLUTION);
  eq(E.nextPhase(E.PHASE.RESOLUTION), E.PHASE.MASTER);
  eq(E.nextPhase(E.PHASE.MASTER), E.PHASE.DISCUSSION);
  eq(E.nextPhase(E.PHASE.DISCUSSION), E.PHASE.VOTING);
  eq(E.nextPhase(E.PHASE.VOTING), E.PHASE.RESULTS);
});

test('RESULTS loops back to CLOSED', () => eq(E.nextPhase(E.PHASE.RESULTS), E.PHASE.CLOSED));
test('FINISHED is terminal', () => eq(E.nextPhase(E.PHASE.FINISHED), E.PHASE.FINISHED));
test('rewind works', () => eq(E.previousPhase(E.PHASE.VOTING), E.PHASE.DISCUSSION));

// ===========================================================================
suite('Information visibility');

test('a Civilian cannot see other roles', () => {
  const s = makeState(baseCast);
  const viewer = s.players.find(p => p.id === 'c1');
  const view = E.visibleStateFor(s, viewer);
  eq(view.players.find(p => p.id === 'm1').role, null);
  eq(view.players.find(p => p.id === 'c1').role, E.ROLE.CIVILIAN, 'own role visible');
});

test('Mafia see each other but no one else', () => {
  const s = makeState(baseCast);
  const viewer = s.players.find(p => p.id === 'm1');
  const view = E.visibleStateFor(s, viewer);
  eq(view.players.find(p => p.id === 'm2').role, E.ROLE.MAFIA);
  eq(view.players.find(p => p.id === 'doc').role, null);
});

test('player views expose no actions, ballots or audit', () => {
  const s = makeState(baseCast);
  s.currentActions = [{ actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' }];
  s.currentBallots = [{ voterId: 'c1', targetId: 'm1' }];
  const view = E.visibleStateFor(s, s.players.find(p => p.id === 'c2'));
  eq(view.currentActions, undefined);
  eq(view.currentBallots, undefined);
  eq(view.audit, undefined);
});

test('balances of other players are hidden', () => {
  const s = makeState(baseCast.map(p => ({ ...p, tokens: 3 })));
  const view = E.visibleStateFor(s, s.players.find(p => p.id === 'c1'));
  eq(view.players.find(p => p.id === 'c2').rewardTokens, null);
  eq(view.players.find(p => p.id === 'c1').rewardTokens, 3);
});

test('admins see everything', () => {
  const s = makeState(baseCast);
  const view = E.visibleStateFor(s, { id: 'admin', accessType: 'SUPER_ADMIN' });
  eq(view.players.find(p => p.id === 'm1').role, E.ROLE.MAFIA);
});

// ===========================================================================
suite('Store');

test('blank state initialises cleanly', async () => {
  const store = new Store(new MemoryAdapter());
  const s = await store.init();
  eq(s.game.status, E.PHASE.CLOSED);
  eq(s.game.currentRound, 0);
  eq(s.players.length, 0);
  eq(s.game.legacyUsed, false);
});

test('commit persists and notifies subscribers', async () => {
  const store = new Store(new MemoryAdapter());
  await store.init();
  let notified = 0;
  store.subscribe(() => notified++);
  await store.commit(d => { d.players.push(newPlayer('Hunter')); });
  eq(store.get().players.length, 1);
  eq(notified, 1);
  const reloaded = await store.adapter.load();
  eq(reloaded.players.length, 1, 'written through to the adapter');
});

test('audit entries are appended', async () => {
  const store = new Store(new MemoryAdapter());
  await store.init();
  await store.commit(d => { d.game.currentRound = 1; },
    { eventType: 'PHASE_ADVANCE', actorId: 'admin', reason: 'Session opened' });
  eq(store.get().audit.length, 1);
  eq(store.get().audit[0].eventType, 'PHASE_ADVANCE');
  assert(store.get().audit[0].timestamp, 'timestamped');
});

test('export and import round-trip', async () => {
  const store = new Store(new MemoryAdapter());
  await store.init();
  await store.commit(d => {
    d.players.push(newPlayer('Hunter'));
    d.game.currentRound = 4;
  });
  const json = store.exportJson();
  const fresh = new Store(new MemoryAdapter());
  await fresh.init();
  await fresh.importJson(json);
  eq(fresh.get().game.currentRound, 4);
  eq(fresh.get().players[0].displayName, 'Hunter');
});

test('migration backfills fields missing from an old save', async () => {
  const store = new Store(new MemoryAdapter());
  await store.init();
  const legacySave = { schemaVersion: 1, game: { name: 'Old', currentRound: 2 }, players: [] };
  await store.importJson(legacySave);
  eq(store.get().game.currentRound, 2);
  assert(store.get().game.settings.resurrectionCost === 3, 'settings backfilled');
  assert(Array.isArray(store.get().audit), 'audit array backfilled');
});

test('a corrupt import is rejected', async () => {
  const store = new Store(new MemoryAdapter());
  await store.init();
  let threw = false;
  try { await store.importJson('{"nope":true}'); } catch { threw = true; }
  assert(threw, 'invalid save rejected');
});

test('commit does not mutate the previous state object', async () => {
  const store = new Store(new MemoryAdapter());
  await store.init();
  const before = store.get();
  await store.commit(d => { d.players.push(newPlayer('X')); });
  eq(before.players.length, 0, 'previous snapshot untouched');
});

// ===========================================================================
// Full-round integration
// ===========================================================================
suite('Integration: a complete round');

test('kill, minigame award, vote, elimination and Legacy in sequence', async () => {
  const store = new Store(new MemoryAdapter());
  await store.init();

  await store.commit(d => {
    d.players = makeState(baseCast).players;
    d.game.currentRound = 1;
    d.game.status = E.PHASE.HIDDEN_ACTIONS;
    d.currentActions = [
      { actorId: 'm1', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' },
      { actorId: 'm2', type: E.ACTION.MAFIA_KILL_VOTE, targetId: 'c1' },
      { actorId: 'doc', type: E.ACTION.DOCTOR_SAVE, targetId: 'c2' },
      { actorId: 'sh', type: E.ACTION.SHERIFF_INVESTIGATE, targetId: 'm1' }
    ];
  });

  const res = E.resolveHiddenActions(store.get(), E.makeRng(store.get().game.rngSeed));
  eq(res.death, 'c1');
  eq(res.sheriffResults[0].verdict, 'SUSPICIOUS');

  // Victim still plays the minigame — death is not announced until after rewards.
  await store.commit(d => {
    d.players = d.players.map(p =>
      ['c1', 'c2'].includes(p.id) ? { ...p, rewardTokens: p.rewardTokens + 1 } : p);
  });
  eq(store.get().players.find(p => p.id === 'c1').rewardTokens, 1,
    'the killed player still earned their token');

  await store.commit(d => { d.players = E.killPlayer(d.players, 'c1'); },
    { eventType: 'DEATH_APPLIED', actorId: 'admin' });
  eq(store.get().players.find(p => p.id === 'c1').lifeStatus, E.LIFE.SPIRIT);

  // Vote out both Mafia across two rounds.
  const v = E.resolveVote(store.get(), [
    { voterId: 'c2', targetId: 'm1' }, { voterId: 'c3', targetId: 'm1' },
    { voterId: 'doc', targetId: 'm1' }, { voterId: 'sh', targetId: 'c3' }
  ]);
  eq(v.eliminated, 'm1');
  await store.commit(d => { d.players = E.killPlayer(d.players, 'm1'); });
  eq(E.checkEndgame(store.get()).finished, false, 'one Mafia remains');

  await store.commit(d => { d.players = E.killPlayer(d.players, 'm2'); });
  const legacy = E.checkMafiaLegacy(store.get(), E.makeRng(11));
  eq(legacy.triggered, true, 'Legacy fires on the last Mafia death');
  await store.commit(d => { d.players = legacy.players; d.game = legacy.game; });
  eq(E.countAliveMafia(store.get().players), 1);
  eq(E.checkEndgame(store.get()).finished, false, 'game continues with the new Mafia');

  const newMafiaId = legacy.chosenId;
  await store.commit(d => { d.players = E.killPlayer(d.players, newMafiaId); });
  const end = E.checkEndgame(store.get());
  eq(end.finished, true);
  eq(end.winner, 'GOOD', 'Good wins once Legacy is spent');
});

test('a skipped week changes nothing', async () => {
  const store = new Store(new MemoryAdapter());
  await store.init();
  await store.commit(d => {
    d.players = makeState(baseCast).players;
    d.players[4].inventory = [newInventoryItem(E.ITEM.TEMP_IMMUNITY, 1)];
    d.game.currentRound = 2;
    d.game.status = E.PHASE.CLOSED;
  });
  const snapshot = JSON.stringify(store.get());
  const reloaded = await store.adapter.load();
  eq(JSON.stringify(reloaded), snapshot, 'state is byte-identical after a closed week');
});

// ===========================================================================
// Reporting
// ===========================================================================

export async function run() {
  await Promise.all(pending);
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  return { results, passed, failed, total: results.length };
}

if (typeof process !== 'undefined' && process.versions?.node) {
  Promise.all(pending).then(() => {
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass);
    let suiteName = '';
    for (const r of results) {
      if (r.suite !== suiteName) { suiteName = r.suite; console.log(`\n  ${suiteName}`); }
      console.log(`   ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '\n         ' + r.error}`);
    }
    console.log(`\n  ${passed}/${results.length} passed, ${failed.length} failed\n`);
    if (failed.length) process.exitCode = 1;
  });
}
