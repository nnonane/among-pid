-- mafia v1.0 | master_awards.sql | 30 Sep 2026
-- Run once in the Supabase SQL Editor after the existing setup SQL. Safe to run again.
-- Rebuilds game_phase as reveal_role.sql does, plus confirmed public Master awards.
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
  end                                                                  as master_awards;
grant select on public.game_phase to authenticated;
select * from public.game_phase;
