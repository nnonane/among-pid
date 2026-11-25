-- among pid imposter v2.0 | imposter.sql | 25 Nov 2026
-- Run the whole file once in the Supabase SQL Editor (copy, paste, Run).
-- Safe to run again. Re-running also updates the questions below.
--
-- IMPOSTER - the final week. No roles, kills, tokens or shop.
-- Each round everyone gets the same question, except one imposter who gets a
-- similar one. Everyone answers out loud, then has 2 minutes to vote for who
-- they think the imposter was. Hunter reveals the answer.
--
-- HOW IT STAYS SECRET
--   * The questions and imposters live ONLY in imp_rounds. No website can
--     read that table directly (RLS on, no policies, no grants).
--   * Each player screen calls imp_get_state(). The database works out who
--     is signed in and hands back only that person's question.
--   * Only admins (the existing public.admins table) can run the game or see
--     who the imposter is before the reveal.
--
-- Nothing in the old Mafia tables is changed or deleted.

-- ================================================================ 1. TABLES
create table if not exists public.imp_rounds (
  round_no       int  primary key,
  everyone_q     text not null,
  imposter_q     text not null,
  imposter_email text not null
);

create table if not exists public.imp_state (
  id                int primary key default 1 check (id = 1),
  current_round     int  not null default 0,          -- 0 = not started
  stage             text not null default 'LOBBY',    -- LOBBY | QUESTION | VOTING | REVEAL
  ends_at           timestamptz,                      -- set = clock running
  remaining_seconds int  not null default 0,          -- used while paused
  vote_seconds      int  not null default 120,        -- 2 minutes
  winner            text not null default '',         -- '' | MAFIA | CIVILIANS
  updated_at        timestamptz not null default now()
);

create table if not exists public.imp_votes (
  round_no   int  not null,
  voter_id   text not null,
  target_id  text not null,
  updated_at timestamptz not null default now(),
  primary key (round_no, voter_id)
);

-- Locked down: everything goes through the functions below.
alter table public.imp_rounds enable row level security;
alter table public.imp_state  enable row level security;
alter table public.imp_votes  enable row level security;
revoke all on public.imp_rounds from anon, authenticated;
revoke all on public.imp_state  from anon, authenticated;
revoke all on public.imp_votes  from anon, authenticated;

insert into public.imp_state (id) values (1) on conflict (id) do nothing;

-- ============================================================= 2. QUESTIONS
-- Edit here and run the file again to change a question or an imposter.
insert into public.imp_rounds (round_no, everyone_q, imposter_q, imposter_email) values
  (1,
   'If you could go anywhere in the world tomorrow, where would you go?',
   'Where is somewhere most people wouldn''t want to travel?',
   'bella@amongpid.com'),
  (2,
   'If someone gave you $10,000 and you had to spend it today, what would you buy?',
   'What''s something you would never spend money on?',
   'fatos@amongpid.com'),
  (3,
   'Who would be the most useful to have with you in PID if you were stranded on an island?',
   'Who would provide the most entertainment in PID if you were stranded on an island?',
   'georgie@amongpid.com')
on conflict (round_no) do update
  set everyone_q     = excluded.everyone_q,
      imposter_q     = excluded.imposter_q,
      imposter_email = excluded.imposter_email;

-- =============================================================== 3. HELPERS
create or replace function public.imp_is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.admins a where a.auth_user_id = auth.uid());
$$;

-- The player seat that belongs to a round's imposter email. Matches the
-- seat's login email (claim_email) or the email of the account linked to it.
create or replace function public.imp_imposter_seat(p_round int)
returns table(seat_id text, seat_name text)
language sql
security definer
stable
set search_path = public, auth
as $$
  select p.id::text, p.display_name
  from public.imp_rounds r
  join public.players p on true
  left join auth.users u on u.id = p.auth_user_id
  where r.round_no = p_round
    and (lower(trim(p.claim_email)) = lower(trim(r.imposter_email))
      or lower(trim(u.email))       = lower(trim(r.imposter_email)))
  order by (lower(trim(p.claim_email)) = lower(trim(r.imposter_email))) desc nulls last
  limit 1;
$$;

revoke all on function public.imp_is_admin()          from public, anon, authenticated;
revoke all on function public.imp_imposter_seat(int)  from public, anon, authenticated;

-- ======================================================= 4. PLAYER: STATE
-- Everything a player screen needs, in one call. The question returned is
-- the caller's own: the imposter gets the imposter question, everyone else
-- gets the normal one. Who the imposter is only appears at the reveal.
create or replace function public.imp_get_state()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, auth
as $$
declare
  v_uid      uuid := auth.uid();
  s          public.imp_state;
  r          public.imp_rounds;
  v_me_id    text;
  v_me_name  text;
  v_email    text;
  v_imp_id   text;
  v_imp_name text;
  v_question text;
  v_reveal   jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;

  select * into s from public.imp_state where id = 1;

  select p.id::text, p.display_name into v_me_id, v_me_name
  from public.players p where p.auth_user_id = v_uid limit 1;

  select lower(trim(u.email)) into v_email from auth.users u where u.id = v_uid;

  if coalesce(s.current_round, 0) > 0 then
    select * into r from public.imp_rounds where round_no = s.current_round;
    select i.seat_id, i.seat_name into v_imp_id, v_imp_name
    from public.imp_imposter_seat(s.current_round) i;

    if r.round_no is not null and s.stage in ('QUESTION', 'VOTING', 'REVEAL') then
      if v_email = lower(trim(r.imposter_email))
         or (v_me_id is not null and v_me_id = v_imp_id) then
        v_question := r.imposter_q;
      else
        v_question := r.everyone_q;
      end if;
    end if;

    if r.round_no is not null and s.stage = 'REVEAL' then
      v_reveal := jsonb_build_object(
        'imposter_id',   v_imp_id,
        'imposter_name', coalesce(v_imp_name, r.imposter_email),
        'everyone_q',    r.everyone_q,
        'imposter_q',    r.imposter_q
      );
    end if;
  end if;

  return jsonb_build_object(
    'server_time',       now(),
    'round',             coalesce(s.current_round, 0),
    'total_rounds',      (select count(*) from public.imp_rounds),
    'stage',             coalesce(s.stage, 'LOBBY'),
    'ends_at',           s.ends_at,
    'remaining_seconds', coalesce(s.remaining_seconds, 0),
    'vote_seconds',      coalesce(s.vote_seconds, 120),
    'winner',            coalesce(s.winner, ''),
    'me',                case when v_me_id is null then null
                              else jsonb_build_object('id', v_me_id, 'name', v_me_name) end,
    'question',          v_question,
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id::text, 'name', p.display_name)
                       order by p.display_name)
      from public.players p
      where coalesce(p.attendance_status, '') <> 'INACTIVE'
    ), '[]'::jsonb),
    'votes', coalesce((
      select jsonb_agg(jsonb_build_object('voter_id', v.voter_id, 'target_id', v.target_id))
      from public.imp_votes v
      where v.round_no = coalesce(s.current_round, 0)
    ), '[]'::jsonb),
    'reveal',            v_reveal
  );
end;
$$;

-- ======================================================== 5. PLAYER: VOTE
-- Casts or changes the caller's own vote. Only while voting is open and the
-- clock has time left. Nobody can vote for themselves.
create or replace function public.imp_cast_vote(p_target text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s    public.imp_state;
  v_me text;
begin
  select p.id::text into v_me
  from public.players p
  where p.auth_user_id = auth.uid()
    and coalesce(p.attendance_status, '') <> 'INACTIVE'
  limit 1;
  if v_me is null then
    raise exception 'NO_SEAT';
  end if;

  select * into s from public.imp_state where id = 1;
  if s.stage <> 'VOTING' then
    raise exception 'VOTING_CLOSED';
  end if;
  if not ((s.ends_at is not null and now() < s.ends_at)
       or (s.ends_at is null and s.remaining_seconds > 0)) then
    raise exception 'TIME_UP';
  end if;

  if p_target is null or p_target = v_me
     or not exists (select 1 from public.players p
                    where p.id::text = p_target
                      and coalesce(p.attendance_status, '') <> 'INACTIVE') then
    raise exception 'BAD_TARGET';
  end if;

  insert into public.imp_votes (round_no, voter_id, target_id, updated_at)
  values (s.current_round, v_me, p_target, now())
  on conflict (round_no, voter_id)
  do update set target_id = excluded.target_id, updated_at = now();
end;
$$;

-- ======================================================== 6. ADMIN: STATE
-- Same as imp_get_state, plus every round with its imposter. Admins only.
create or replace function public.imp_admin_state()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.imp_is_admin() then
    raise exception 'NOT_ADMIN';
  end if;
  return public.imp_get_state() || jsonb_build_object(
    'rounds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'round_no',       r.round_no,
        'everyone_q',     r.everyone_q,
        'imposter_q',     r.imposter_q,
        'imposter_email', r.imposter_email,
        'imposter_id',    i.seat_id,
        'imposter_name',  i.seat_name
      ) order by r.round_no)
      from public.imp_rounds r
      left join lateral public.imp_imposter_seat(r.round_no) i on true
    ), '[]'::jsonb)
  );
end;
$$;

-- ====================================================== 7. ADMIN: CONTROL
-- Every button on the admin console. Admins only.
--   START_ROUND (n)   question goes out for round n; that round's votes cleared
--   OPEN_VOTING       starts the 2 minute clock on every screen
--   PAUSE / RESUME    pauses or restarts the clock
--   ADD_MINUTE        +60 seconds
--   LOCK              ends voting now
--   REVEAL            shows the imposter on every screen
--   RESTART_ROUND     clears this round's votes, back to the question
--   RESET_GAME        back to before round 1; every vote and the winner cleared
--   SET_WINNER (MAFIA | CIVILIANS | '')
create or replace function public.imp_control(p_action text, p_value text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s      public.imp_state;
  v_n    int;
  v_left int;
begin
  if not public.imp_is_admin() then
    raise exception 'NOT_ADMIN';
  end if;

  select * into s from public.imp_state where id = 1;
  v_left := case when s.ends_at is not null
                 then greatest(0, ceil(extract(epoch from (s.ends_at - now())))::int)
                 else s.remaining_seconds end;

  if p_action = 'START_ROUND' then
    v_n := p_value::int;
    if not exists (select 1 from public.imp_rounds where round_no = v_n) then
      raise exception 'NO_SUCH_ROUND';
    end if;
    delete from public.imp_votes where round_no = v_n;
    update public.imp_state
       set current_round = v_n, stage = 'QUESTION', ends_at = null,
           remaining_seconds = 0, updated_at = now()
     where id = 1;

  elsif p_action = 'OPEN_VOTING' then
    if s.current_round = 0 then raise exception 'NO_ROUND'; end if;
    update public.imp_state
       set stage = 'VOTING',
           ends_at = now() + make_interval(secs => s.vote_seconds),
           remaining_seconds = s.vote_seconds, updated_at = now()
     where id = 1;

  elsif p_action = 'PAUSE' then
    if s.ends_at is not null then
      update public.imp_state
         set ends_at = null, remaining_seconds = v_left, updated_at = now()
       where id = 1;
    end if;

  elsif p_action = 'RESUME' then
    if s.ends_at is null and s.remaining_seconds > 0 then
      update public.imp_state
         set ends_at = now() + make_interval(secs => s.remaining_seconds), updated_at = now()
       where id = 1;
    end if;

  elsif p_action = 'ADD_MINUTE' then
    if s.stage = 'VOTING' then
      if s.ends_at is not null then
        update public.imp_state
           set ends_at = greatest(s.ends_at, now()) + interval '60 seconds', updated_at = now()
         where id = 1;
      else
        update public.imp_state
           set remaining_seconds = s.remaining_seconds + 60, updated_at = now()
         where id = 1;
      end if;
    end if;

  elsif p_action = 'LOCK' then
    update public.imp_state
       set ends_at = null, remaining_seconds = 0, updated_at = now()
     where id = 1;

  elsif p_action = 'REVEAL' then
    if s.current_round = 0 then raise exception 'NO_ROUND'; end if;
    update public.imp_state
       set stage = 'REVEAL', ends_at = null, remaining_seconds = 0, updated_at = now()
     where id = 1;

  elsif p_action = 'RESTART_ROUND' then
    if s.current_round = 0 then raise exception 'NO_ROUND'; end if;
    delete from public.imp_votes where round_no = s.current_round;
    update public.imp_state
       set stage = 'QUESTION', ends_at = null, remaining_seconds = 0, updated_at = now()
     where id = 1;

  elsif p_action = 'RESET_GAME' then
    delete from public.imp_votes where true;
    update public.imp_state
       set current_round = 0, stage = 'LOBBY', ends_at = null,
           remaining_seconds = 0, winner = '', updated_at = now()
     where id = 1;

  elsif p_action = 'SET_WINNER' then
    if coalesce(p_value, '') not in ('', 'MAFIA', 'CIVILIANS') then
      raise exception 'BAD_WINNER';
    end if;
    update public.imp_state
       set winner = coalesce(p_value, ''), updated_at = now()
     where id = 1;

  else
    raise exception 'UNKNOWN_ACTION';
  end if;
end;
$$;

-- ================================================================ 8. ACCESS
revoke all on function public.imp_get_state()           from public, anon;
revoke all on function public.imp_cast_vote(text)       from public, anon;
revoke all on function public.imp_admin_state()         from public, anon;
revoke all on function public.imp_control(text, text)   from public, anon;
grant execute on function public.imp_get_state()         to authenticated;
grant execute on function public.imp_cast_vote(text)     to authenticated;
grant execute on function public.imp_admin_state()       to authenticated;  -- checks admin itself
grant execute on function public.imp_control(text, text) to authenticated;  -- checks admin itself

-- ================================================================= 9. CHECK
-- One line per round. Every verdict should say OK. If one says NO SEAT, that
-- imposter will get the normal question - fix the email (see the bottom).
select r.round_no,
       r.imposter_email,
       i.seat_name as matched_player,
       case when i.seat_id is null
            then 'NO SEAT HAS THIS EMAIL - check spelling in players.claim_email'
            else 'OK' end as verdict
from public.imp_rounds r
left join lateral public.imp_imposter_seat(r.round_no) i on true
order by r.round_no;

-- To fix a player's login email (Table Editor works too):
-- update public.players set claim_email = 'someone@amongpid.com' where display_name = 'Their Name';
