-- mafia v0.7 | retire_roles.sql | 30 Sep 2026
-- Run once in the Supabase SQL Editor. Safe to run again.
-- Doctor and Sheriff no longer exist. Any seat still holding one becomes a
-- Civilian. Tokens, Spirit Points, items and life status are not touched.

update public.players
   set role = 'CIVILIAN', alignment = 'GOOD'
 where role in ('DOCTOR', 'SHERIFF');

delete from public.actions
 where type in ('DOCTOR_SAVE', 'SHERIFF_INVESTIGATE');

-- Check: should return no rows.
select display_name, role from public.players
 where role in ('DOCTOR', 'SHERIFF');
