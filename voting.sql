-- mafia v0.8 | voting.sql | 30 Sep 2026
-- Run once in the Supabase SQL Editor (copy, paste, Run). Safe to run again.
-- Adds three things for the new Discuss & vote phase. Nothing existing is
-- removed or changed - these only ADD permissions.

-- ============================================== 1. PUBLIC VOTE BOARD
-- Every signed-in player can see every ballot (who voted for whom).
-- Players still can only CAST their own vote - that rule is untouched.
drop policy if exists "ballots_public_read" on public.ballots;
create policy "ballots_public_read"
  on public.ballots for select
  to authenticated
  using (true);

-- ============================================== 2. ADMIN CAN FIX VOTES
-- Lets an admin enter, change or clear anyone's vote from the console,
-- so it shows on every screen and counts in the tally.
drop policy if exists "ballots_admin_write" on public.ballots;
create policy "ballots_admin_write"
  on public.ballots for all
  to authenticated
  using      (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

-- ============================================== 3. SHARED TIMER
-- One row. The console writes it; every player screen reads it.
create table if not exists public.vote_timer (
  id                int primary key default 1 check (id = 1),
  round             int not null default 0,
  ends_at           timestamptz,             -- set = running, null = paused
  remaining_seconds int not null default 300,
  updated_at        timestamptz not null default now()
);

alter table public.vote_timer enable row level security;

drop policy if exists "vote_timer_read" on public.vote_timer;
create policy "vote_timer_read"
  on public.vote_timer for select
  to authenticated
  using (true);

drop policy if exists "vote_timer_admin_write" on public.vote_timer;
create policy "vote_timer_admin_write"
  on public.vote_timer for all
  to authenticated
  using      (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

grant select, insert, update, delete on public.vote_timer to authenticated;

-- Check: should show one line with a round of 0 or more.
insert into public.vote_timer (id) values (1) on conflict (id) do nothing;
select * from public.vote_timer;
