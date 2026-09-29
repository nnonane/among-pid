-- mafia v0.9 | reveal_role.sql | 30 Sep 2026
-- Run once in the Supabase SQL Editor (copy, paste, Run). Safe to run again.
--
-- When someone is voted out, every player now sees what role they were.
-- This rebuilds the game_phase view exactly as fix_security.sql made it,
-- with ONE new column on the end: eliminated_role.
--
-- Like eliminated_id, it stays blank until you tally and the game moves to
-- Results - so nobody can peek at a role before it is announced. Night
-- kills are NOT revealed; only the public vote.

drop view if exists public.game_phase;

create view public.game_phase
with (security_invoker = false) as
select
  'current'::text                                                     as id,
  public.current_phase()                                              as phase,
  public.current_round()                                              as current_round,
  coalesce(public.game_blob() -> 'pendingPublicEvent' ->> 'text', '')  as public_text,
  coalesce(public.game_blob() -> 'game' ->> 'winner', '')              as winner,
  case
    when public.current_phase() = 'RESULTS'
      then coalesce(public.game_blob() -> 'currentVoteResult' ->> 'eliminated', '')
    else ''
  end                                                                  as eliminated_id,
  -- NEW: the voted-out player's role, revealed at the same moment.
  case
    when public.current_phase() = 'RESULTS'
      then coalesce(public.game_blob() -> 'currentVoteResult' ->> 'revealedRole', '')
    else ''
  end                                                                  as eliminated_role;

grant select on public.game_phase to authenticated;

-- Check: should show one line, with an eliminated_role column at the end.
-- It is blank unless the game is currently on the Results screen.
select * from public.game_phase;
