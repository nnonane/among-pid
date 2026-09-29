/* mafia v0.4 | content.js | 30 Sep 2026 */
/*
  YOUR FILE. Edit freely — nothing here affects game logic.
  Minigames, labels and display text only.
*/

export const GAME_TITLE = 'Among PID';
export const GAME_SUBTITLE = 'Weekly Mafia';

// ---------------------------------------------------------------------------
// Minigame library
//   format: 'INDIVIDUAL' | 'TEAM'
//   backup: true = quick-launch, minimal setup, good when running short
// ---------------------------------------------------------------------------

export const MINIGAMES = [
  {
    id: 'mg_werdle',
    name: 'Group Wordle',
    format: 'INDIVIDUAL',
    minutes: 8,
    backup: true,
    instructions:
      'Share the screen on a daily word puzzle. Players call out guesses. ' +
      'Whoever suggests the winning word takes the token.'
  },
  {
    id: 'mg_twotruths',
    name: 'Two Truths and a Lie',
    format: 'INDIVIDUAL',
    minutes: 10,
    backup: false,
    instructions:
      'Each player gives three statements. The group votes on the lie. ' +
      'Anyone who fools the majority wins a token.'
  },
  {
    id: 'mg_emojifilm',
    name: 'Emoji Movie Quiz',
    format: 'TEAM',
    minutes: 8,
    backup: true,
    instructions:
      'Split into two teams. Show emoji sequences representing films. ' +
      'First team to five correct answers wins. Every member takes a token.'
  },
  {
    id: 'mg_pitch',
    name: 'Terrible Product Pitch',
    format: 'INDIVIDUAL',
    minutes: 10,
    backup: false,
    instructions:
      'Spin the wheel for a random object. Each player has 30 seconds to pitch it. ' +
      'Group applause decides the winner.'
  },
  {
    id: 'mg_guessthe',
    name: 'Guess the Desk',
    format: 'INDIVIDUAL',
    minutes: 6,
    backup: true,
    instructions:
      'Show close-up photos of desks, mugs or screensavers. First correct guess wins the round. ' +
      'Most rounds takes the token.'
  },
  {
    id: 'mg_categories',
    name: 'Categories',
    format: 'TEAM',
    minutes: 7,
    backup: true,
    instructions:
      'Pick a letter and a category. Teams alternate answers with no repeats. ' +
      'A team that stalls for five seconds loses the round. Best of five.'
  }
];

// ---------------------------------------------------------------------------
// Display labels
// ---------------------------------------------------------------------------

export const PHASE_LABEL = {
  CLOSED: 'Session closed',
  ATTENDANCE: 'Attendance',
  HIDDEN_ACTIONS: 'Hidden actions',
  MINIGAME: 'Minigame',
  REWARDS: 'Tokens & purchases',
  RESOLUTION: 'Resolution',
  MASTER: 'Master',
  VOTING: 'Discuss & vote',
  RESULTS: 'Results',
  FINISHED: 'Game over'
};

export const PHASE_HINT = {
  CLOSED: 'Nothing advances while the session is closed. Open a session to begin the week.',
  ATTENDANCE: 'Mark who is here. Absent players go Dormant and cannot act, vote or be targeted.',
  HIDDEN_ACTIONS: 'Collect the Mafia kill votes privately, then enter them here.',
  MINIGAME: 'Play the minigame. The killed player does not know yet, so they still take part.',
  REWARDS: 'Award tokens to winners, then handle any private purchases.',
  RESOLUTION: 'Preview the outcome, then publish. This is when the death is announced.',
  MASTER: 'The Master privately grants one vote immunity and one double vote for this round only.',
  VOTING: 'One timer. Everyone discusses and votes whenever they are ready. Every screen shows who voted for whom. Change or enter votes below for anyone having trouble.',
  RESULTS: 'Reveal the outcome, then close the session.',
  FINISHED: 'The game has ended.'
};

export const ROLE_LABEL = {
  MAFIA: 'Mafia',
  CIVILIAN: 'Civilian'
};

export const ITEM_LABEL = {
  TEMP_IMMUNITY: 'Temporary Immunity',
  EXTRA_VOTE: 'Extra Vote',
  DISCOUNTED_RESURRECTION: 'Discounted Resurrection',
  VOTE_MANIPULATION: 'Vote Manipulation',
  RECRUIT_NEW_MAFIA: 'Recruit New Mafia'
};

export const ITEM_HINT = {
  TEMP_IMMUNITY: 'Blocks the kill and the public vote next round.',
  EXTRA_VOTE: 'Adds one weight to one ballot.',
  DISCOUNTED_RESURRECTION: 'Kept through death. Lowers one resurrection to 2 points.',
  VOTE_MANIPULATION: 'One anonymous vote adjustment.',
  RECRUIT_NEW_MAFIA: 'Convert a living non-Mafia. Blocked above three active Mafia.'
};

export const SETTING_LABEL = {
  voteManipulationDirection: 'Vote Manipulation direction',
  spiritPointsAttendance: 'Spirit Points for attendance',
  spiritPointsMinigameWin: 'Spirit Points for a minigame win',
  resurrectionCost: 'Resurrection cost',
  resurrectionDiscountedCost: 'Discounted resurrection cost',
  maxActiveMafiaFromRecruit: 'Maximum active Mafia',
  tempImmunityCoversVote: 'Immunity also blocks the vote',
  masterEnabled: 'Master role in play',
  voteMinutes: 'Discuss & vote timer (minutes)'
};
