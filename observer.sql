-- mafia v1.3 | observer.sql | 21 Oct 2026
-- Run once in the Supabase SQL Editor (copy, paste, Run). Safe to run again.
--
-- Sets up the OBSERVER screen (observer.html): a view that shows everything,
-- including roles, Mafia kill picks, tokens, items, purchases, weighted
-- votes and the full game log. It is meant for someone who is not playing.
--
-- HOW IT STAYS SAFE
--   * Nothing about the existing tables or policies is changed. Players can
--     see exactly what they could see before.
--   * Everything goes through ONE function, observer_snapshot(). It checks
--     who is asking before it returns anything.
--   * Only accounts listed in the new observers table (or admins) get an
--     answer. Everyone else gets an error.
--   * A login that is linked to a player seat is refused, even if somebody
--     adds it to observers by mistake. A player can never see the secrets.
--
-- STEPS
--   1. Authentication -> Users -> Add user. Make an account for the observer
--      (for example observer@yourdomain). Do NOT give it a player seat.
--   2. Run this whole file.
--   3. Change the email in step 3 below to that account, and run just that
--      statement (or run the whole file again - it is safe).
--   4. Open observer.html and sign in with that account.

-- ============================================================ 1. OBSERVERS
create table if not exists public.observers (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  note         text,
  created_at   timestamptz not null default now()
);

-- RLS on with no policies: the table cannot be read or written through the
-- website at all. Only this SQL Editor and the function below can use it.
alter table public.observers enable row level security;
revoke all on public.observers from anon, authenticated;

-- ===================================================== 2. THE SNAPSHOT
-- Returns everything the observer screen needs in one call:
--   blob        the game (phase, week, settings, actions, master awards,
--               winners, vote result, announcement...) minus the audit log
--   audit       the last 250 log entries, without their large before/after
--               snapshots
--   players     every seat with role, tokens, Spirit Points and items
--               (login email and login id are removed)
--   actions     this week's Mafia kill picks as submitted
--   ballots     this week's votes as submitted
--   purchases   this week's shop requests, with status
--   vote_timer  the shared clock
create or replace function public.observer_snapshot()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_admin boolean;
  v_blob  jsonb;
  v_round int;
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;

  v_admin := exists (select 1 from public.admins ad where ad.auth_user_id = v_uid);

  if not v_admin
     and not exists (select 1 from public.observers o where o.auth_user_id = v_uid) then
    raise exception 'NOT_OBSERVER';
  end if;

  -- Belt and braces: a player can never be an observer.
  if not v_admin
     and exists (select 1 from public.players pl where pl.auth_user_id = v_uid) then
    raise exception 'OBSERVER_IS_PLAYER';
  end if;

  select g.blob into v_blob from public.games g where g.id = 'current';
  v_blob  := coalesce(v_blob, '{}'::jsonb);
  v_round := coalesce((v_blob -> 'game' ->> 'currentRound')::int, 0);

  return jsonb_build_object(
    'server_time', now(),
    'blob', v_blob - 'audit',
    'audit', coalesce((
      select jsonb_agg(e.val - 'before' - 'after' order by e.ord)
      from (
        select t.val, t.ord
        from jsonb_array_elements(coalesce(v_blob -> 'audit', '[]'::jsonb))
             with ordinality as t(val, ord)
        order by t.ord desc
        limit 250
      ) e
    ), '[]'::jsonb),
    'players', coalesce((
      select jsonb_agg((to_jsonb(p) - 'auth_user_id' - 'claim_email') order by p.display_name)
      from public.players p
    ), '[]'::jsonb),
    'actions', coalesce((
      select jsonb_agg(to_jsonb(a))
      from public.actions a where a.round = v_round
    ), '[]'::jsonb),
    'ballots', coalesce((
      select jsonb_agg(to_jsonb(b))
      from public.ballots b where b.round = v_round
    ), '[]'::jsonb),
    'purchases', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at)
      from public.purchases x where x.round = v_round
    ), '[]'::jsonb),
    'vote_timer', (select to_jsonb(vt) from public.vote_timer vt where vt.id = 1)
  );
end;
$$;

revoke all on function public.observer_snapshot() from public, anon;
grant execute on function public.observer_snapshot() to authenticated;

-- ================================================ 3. ADD AN OBSERVER LOGIN
-- Change the email to the account you made in step 1, then run this.
-- Run it again with another email to add a second observer.
insert into public.observers (auth_user_id, note)
select u.id, 'Observer screen'
from auth.users u
where lower(trim(u.email)) = lower(trim('observer@example.com'))
on conflict (auth_user_id) do nothing;

-- To remove one later:
-- delete from public.observers
--  where auth_user_id = (select id from auth.users where lower(email) = lower('observer@example.com'));

-- ================================================================ CHECK
-- Lists every observer. "is_a_player = true" means that login is linked to
-- a seat and will be refused - use a different account for observing.
select u.email,
       exists (select 1 from public.players p where p.auth_user_id = o.auth_user_id) as is_a_player,
       o.created_at
from public.observers o
join auth.users u on u.id = o.auth_user_id
order by u.email;
