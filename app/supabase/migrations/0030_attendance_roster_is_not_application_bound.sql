-- 0030 — the attendance roster stops being application-bound.
--
-- THE DEFECT, DRIVEN RATHER THAN READ.
--
-- attendance_mark_v1 and attendance_for_activity_v1 disagree about who can have
-- attendance at an activity, and the disagreement is silent in the direction
-- that loses an admin's work.
--
-- attendance_mark_v1 (0001) takes p_member_id and inserts. It checks is_staff()
-- and the status vocabulary, and nothing else — in particular it never asks
-- whether that member has an activity_applications row. So marking a walk-in
-- succeeds and the row is stored.
--
-- attendance_for_activity_v1 (0001) builds its result the other way round:
--
--     from public.activity_applications ap
--     join public.members m on m.id = ap.member_id
--     left join public.attendance a on a.activity_id = ap.activity_id
--                                  and a.member_id   = ap.member_id
--    where ap.application_type = 'participant'
--
-- The roster is the application list, and attendance is only ever LEFT JOINed
-- onto it. An attendance row for somebody with no application has nothing to
-- hang on and never appears.
--
-- Seeded two members against one training — one who applied, one who did not —
-- had a staff account mark both, then read it back three ways:
--
--   attendance_mark_v1(..., pwtest_dba2_noapp, 'late', true)  -> returned 'late'
--   physically stored (read as postgres):   noapp | late    | t
--                                           plain | present | f
--   attendance_for_activity_v1(...):        plain | present | f      <- one row
--   noapp's own attendance_my_history_v1(): 1 row
--
-- So the row exists, the member sees it, team_event_rankings_v1 counts it
-- (0016 joins attendance to activities and never looks at applications), and
-- the admin who created it is the only reader who cannot. On the next load the
-- admin sees that person unmarked and marks them again, which is an UPSERT onto
-- the same (activity_id, member_id) key — so the data survives, but the screen
-- has been lying about it the whole time.
--
-- WHY THE UNION AND NOT A CHECK ON THE WRITE SIDE.
--
-- The other way to make the two agree is to have attendance_mark_v1 refuse a
-- member who never applied. That is the wrong direction for this club. The
-- roster is what the pool deck actually looked like, and the application list is
-- a prediction made beforehand; when they differ it is the prediction that is
-- wrong. A member who turns up without applying has attended. Upstream reaches
-- the same conclusion from the other end — its client unions a historical
-- attendance list into t.participants precisely because attendance predates and
-- outruns the application table (upstream/main:index.html:1632-1641).
--
-- Widening the read also keeps the write path a single unguarded UPSERT, which
-- is what makes it safe to call twice.
--
-- The `where public.is_staff()` filter is carried over unchanged. It is a filter
-- and not a raise, so a non-staff caller still receives zero rows rather than an
-- error; that is 0001's contract and the client depends on the empty result, so
-- changing it belongs in its own migration if it is wanted at all.

create or replace function public.attendance_for_activity_v1(p_activity_id uuid)
returns table (
  member_id     uuid,
  nickname      text,
  avatar_path   text,
  status        text,
  late_fee_paid boolean,
  marked_at     timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- UNION, not UNION ALL: a member who both applied and was marked must appear
  -- once. The set operation dedupes on member_id, which is the whole key here.
  with roster as (
    select ap.member_id
      from public.activity_applications ap
     where ap.activity_id = p_activity_id
       and ap.application_type = 'participant'
    union
    select att.member_id
      from public.attendance att
     where att.activity_id = p_activity_id
  )
  select m.id,
         m.nickname,
         m.avatar_path,
         a.status,
         coalesce(a.late_fee_paid, false),
         a.marked_at
    from roster r
    join public.members m on m.id = r.member_id
    left join public.attendance a
      on a.activity_id = p_activity_id
     and a.member_id   = m.id
   where public.is_staff()
   order by m.nickname
$function$;

-- CREATE OR REPLACE preserves the existing ACL, so the 0001 grant still stands.
-- Restated anyway: 0026 made a function unreachable until somebody grants it on
-- purpose, and the grant that keeps this one reachable should be visible in the
-- migration that last touched it rather than only in the one that created it.
grant execute on function public.attendance_for_activity_v1(uuid) to authenticated;
