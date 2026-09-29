-- mafia v0.6 | fix_logins.sql | 29 Sep 2026
-- Run the whole file once in the Supabase SQL Editor. Safe to run again.

-- ============================================================ 1. DIAGNOSE
-- Shows, for every seat, whether a Supabase login actually exists for the
-- email you typed. "account_exists = false" means the email is misspelt or
-- the account was never created / was deleted.
select p.display_name,
       p.claim_email,
       u.id is not null                  as account_exists,
       u.email_confirmed_at is not null  as email_confirmed,
       p.auth_user_id is not null        as linked,
       (p.auth_user_id is not null and p.auth_user_id is distinct from u.id) as linked_to_wrong_account
from public.players p
left join auth.users u on lower(trim(u.email)) = lower(trim(p.claim_email))
order by p.display_name;


-- ======================================================= 2. CLAIM ON LOGIN
-- Replaces the old claim_my_seat. The old one could quietly do nothing if
-- the login was still tied to a deleted/older seat. This one frees the
-- login from any other seat first, then links it. Matching ignores case
-- and spaces.
drop function if exists public.claim_my_seat();

create function public.claim_my_seat()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_id    public.players.id%type;
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;

  select lower(trim(u.email)) into v_email from auth.users u where u.id = v_uid;

  select p.id into v_id
  from public.players p
  where lower(trim(p.claim_email)) = v_email
  order by (p.auth_user_id = v_uid) desc nulls last, p.display_name
  limit 1;

  if v_id is null then
    return;  -- no seat for this email; the player page explains that
  end if;

  update public.players set auth_user_id = null
   where auth_user_id = v_uid and id <> v_id;
  update public.players set auth_user_id = v_uid
   where id = v_id;
end;
$$;

revoke all on function public.claim_my_seat() from public, anon;
grant execute on function public.claim_my_seat() to authenticated;


-- ======================================================= 3. LINK NOW (ADMIN)
-- Used by the "Link now" button in Player logins. Links every seat to the
-- account with the matching email immediately, and reports each result.
create or replace function public.link_all_seats()
returns table(out_name text, out_email text, out_status text)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  r     record;
  v_uid uuid;
begin
  if not exists (select 1 from public.admins a where a.auth_user_id = auth.uid()) then
    raise exception 'Only an admin can link logins';
  end if;

  for r in select p.id, p.display_name, p.claim_email
           from public.players p order by p.display_name loop
    out_name  := r.display_name;
    out_email := r.claim_email;

    if r.claim_email is null or trim(r.claim_email) = '' then
      out_status := 'NO_EMAIL'; return next; continue;
    end if;

    v_uid := null;
    select u.id into v_uid from auth.users u
     where lower(trim(u.email)) = lower(trim(r.claim_email)) limit 1;

    if v_uid is null then
      out_status := 'NO_ACCOUNT'; return next; continue;
    end if;

    update public.players set auth_user_id = null
     where auth_user_id = v_uid and id <> r.id;
    update public.players set auth_user_id = v_uid
     where id = r.id;

    out_status := 'LINKED'; return next;
  end loop;
end;
$$;

revoke all on function public.link_all_seats() from public, anon;
grant execute on function public.link_all_seats() to authenticated;


-- ===================================================== 4. RESET SUBMISSIONS
-- Used by the console's Reset button. Admins only.
create or replace function public.reset_game()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admins where auth_user_id = auth.uid()) then
    raise exception 'Only an admin can reset the game';
  end if;
  delete from public.private_events where true;
  delete from public.purchases      where true;
  delete from public.ballots        where true;
  delete from public.actions        where true;
end;
$$;

revoke all on function public.reset_game() from public, anon;
grant execute on function public.reset_game() to authenticated;
