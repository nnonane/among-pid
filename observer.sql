-- mafia v1.3.1 | observer.sql | 21 Oct 2026
-- Run in the Supabase SQL Editor (copy, paste, Run). Safe to run again.
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
--   * Only accounts listed in the observers table (or admins) get an answer.
--   * A login that is linked to a player seat is always refused, even if it
--     is added to observers by mistake.
--
-- STEPS
--   1. Authentication -> Users -> Add user -> Create new user. Make the
--      observer account. Tick "Auto Confirm User". Do NOT give it a seat.
--   2. Put that email in step 3 below (one place only).
--   3. Run this whole file. Read the "verdict" column at the bottom.
--   4. Open observer.html and sign in with that account.
--
-- v1.3.1: step 3 now confirms the email for you and prints a verdict that
-- says exactly what is wrong if the login will not work.

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
-- Put the observer's email on the next line (keep the quotes).
-- Run again with a different email to add another observer.

create temp table if not exists _obs_email (email text);
truncate _obs_email;
insert into _obs_email values (lower(trim('mandie@amongpid.com')));

-- An account made with "Add user" but without "Auto Confirm User" cannot
-- sign in. Confirm this one so it can.
update auth.users u
   set email_confirmed_at = coalesce(u.email_confirmed_at, now())
 where lower(trim(u.email)) = (select email from _obs_email);

insert into public.observers (auth_user_id, note)
select u.id, 'Observer screen'
from auth.users u
where lower(trim(u.email)) = (select email from _obs_email)
on conflict (auth_user_id) do nothing;

-- RESULT: read the "verdict" column.
select e.email,
       u.id is not null                                   as account_exists,
       u.email_confirmed_at is not null                   as email_confirmed,
       o.auth_user_id is not null                         as on_observer_list,
       exists (select 1 from public.players p where p.auth_user_id = u.id) as linked_to_a_player_seat,
       case
         when u.id is null then
           'NO ACCOUNT with this email. Create it under Authentication -> Users -> Add user (tick Auto Confirm User), check the spelling, then run this file again.'
         when exists (select 1 from public.players p where p.auth_user_id = u.id) then
           'This login is linked to a PLAYER seat, so it will always be refused. Use a different email for observing.'
         when o.auth_user_id is null then
           'Not added yet - run the file again.'
         else
           'READY. Sign in on observer.html with this email. Wrong password? Reset it under Authentication -> Users.'
       end as verdict
from _obs_email e
left join auth.users u on lower(trim(u.email)) = e.email
left join public.observers o on o.auth_user_id = u.id;

-- To remove an observer later:
-- delete from public.observers
--  where auth_user_id = (select id from auth.users where lower(email) = lower('someone@example.com'));
