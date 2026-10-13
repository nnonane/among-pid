-- mafia v1.2 | sabotage.sql | 14 Oct 2026
-- Run once in the Supabase SQL Editor (copy, paste, Run). Safe to run again.
--
-- Rebuilds game_phase exactly as master_awards.sql made it, with ONE new
-- column on the end: sabotaged_id.
--
-- It holds the player who has been sabotaged and cannot vote this week.
-- It only shows during Discuss & vote and Results, and only when the
-- Sabotage actually took effect. Who bought it is never exposed, and a
-- Sabotage blocked by Temporary Immunity is never shown (that would
-- reveal the immunity).
drop view if exists public.game_phase;
create view public.game_phase
with (security_invoker = false) as
select
  'current'::text                                                      as id,
  public.current_phase()                                               as phase,
  public.current_round()                                               as current_round,
  coalesce(public.game_blob() -> 'pendingPublicEvent' ->> 'text', '')  as public_text,
  coalesce(public.game_blob() -> 'game' ->> 'winner', '')              as winner,
  case when public.current_phase() = 'RESULTS'
    then coalesce(public.game_blob() -> 'currentVoteResult' ->> 'eliminated', '')
    else '' end                                                        as eliminated_id,
  case when public.current_phase() = 'RESULTS'
    then coalesce(public.game_blob() -> 'currentVoteResult' ->> 'revealedRole', '')
    else '' end                                                        as eliminated_role,
  case
    when public.current_phase() <> 'CLOSED'
     and coalesce((public.game_blob() -> 'currentMaster' ->> 'confirmed')::boolean, false)
    then coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', a ->> 'title',
        'player_id', a ->> 'playerId',
        'display_name', p.display_name,
        'prize', a ->> 'prize'
      ) order by a ->> 'key')
      from jsonb_array_elements(coalesce(public.game_blob() -> 'currentMaster' -> 'awards', '[]'::jsonb)) a
      left join public.players p on p.id::text = a ->> 'playerId'
      where coalesce(a ->> 'playerId', '') <> ''
    ), '[]'::jsonb)
    else '[]'::jsonb
  end                                                                  as master_awards,
  -- NEW: who cannot vote this week.
  case when public.current_phase() in ('VOTING', 'RESULTS')
    then coalesce(public.game_blob() -> 'currentSabotage' ->> 'targetId', '')
    else '' end                                                        as sabotaged_id;
grant select on public.game_phase to authenticated;
-- Check: should show one line, with a sabotaged_id column at the end.
select * from public.game_phase;
