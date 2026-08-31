-- 0050 — 일정(훈련/대회/기타) 댓글, and the push event that goes with it.
--
-- Same shape as 0004's notice_comments, for the same reason: one row per
-- comment keyed by member_id, not a nickname string and not a jsonb array two
-- concurrent commenters overwrite each other in. The legacy app never had this
-- for activities at all — his own rebuild attempt (activity-comments-v98.js,
-- injected by sw.js) is real and does run, and its own UI copy is the source
-- for who gets notified below: "댓글 등록 시 해당 일정 신청자·대기자에게
-- 알림이 전송됩니다."
--
-- Builds on 0001 (activities, activity_applications), 0004 (append_notice_comment,
-- the pattern this copies), 0022 (push_notify_context_v1, request_push_notify,
-- the trigger shape this extends) and 0023 (the CURRENT push_notify_context_v1
-- body — it replaced 0022's, adding the member_is_staff guard on
-- activity_created below. Reproduced from 0023, not 0022: sourcing an
-- old body here would have silently dropped that guard.

create table if not exists public.activity_comments (
  id           uuid primary key default gen_random_uuid(),
  activity_id  uuid not null references public.activities(id) on delete cascade,
  member_id    uuid not null references public.members(id),
  body         text not null,
  created_at   timestamptz not null default now()
);
comment on table public.activity_comments is
  '일정(훈련/대회/기타) 댓글. 작성자는 member_id로만 식별하며 닉네임을 복사하지 않는다.';
create index if not exists activity_comments_activity_idx
  on public.activity_comments (activity_id, created_at);

alter table public.activity_comments enable row level security;

drop policy if exists activity_comments_read on public.activity_comments;
create policy activity_comments_read on public.activity_comments
  for select using (public.current_member_id() is not null);

-- Immutable, same as notice_comments: no UPDATE policy. No INSERT policy
-- either — inserts go through append_activity_comment() so the author cannot
-- be spoofed the way the legacy client (which sends created_by straight from
-- the browser) can be.
drop policy if exists activity_comments_delete on public.activity_comments;
create policy activity_comments_delete on public.activity_comments
  for delete using (member_id = public.current_member_id() or public.is_staff());

-- ------------------------------------------------------------------------ RPC
-- Derives the author from auth.uid() via current_member_id(), the same
-- append_notice_comment() shape — a client cannot claim to be someone else,
-- and each comment is one INSERT so concurrent comments cannot collide.
create or replace function public.append_activity_comment(p_activity_id uuid, p_body text)
returns public.activity_comments
language plpgsql security definer set search_path = public
as $$
declare
  v_member uuid;
  v_body   text;
  v_row    public.activity_comments;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'comment body is empty' using errcode = '22023';
  end if;

  if not exists (select 1 from public.activities where id = p_activity_id) then
    raise exception 'no such activity' using errcode = '23503';
  end if;

  insert into public.activity_comments (activity_id, member_id, body)
  values (p_activity_id, v_member, v_body)
  returning * into v_row;

  return v_row;
end $$;

revoke all on function public.append_activity_comment(uuid, text) from public, anon, authenticated;
grant execute on function public.append_activity_comment(uuid, text) to authenticated;

-- ============================================================ push: the event
-- push_notify_context_v1 is reproduced here in full, from 0023 (its current
-- owner — 0022 defined it first, but 0023 replaced the body, and copying 0022's
-- instead would have silently reverted 0023's member_is_staff guard below), with
-- one new branch added (activity_comment_created) and every existing branch
-- left byte-for-byte unchanged. CREATE OR REPLACE means a body written from
-- memory would silently drop whatever it forgot — this one was copied out of
-- 0023, not reconstructed.
create or replace function public.push_notify_context_v1(p_event text, p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_fact     jsonb;
  v_audience uuid[];
begin
  if p_event = 'notice_created' then
    select jsonb_build_object('notice_id', n.id, 'title', n.title),
           array(select m.id from public.members m
                  where m.status = 'approved'
                    and m.id is distinct from n.created_by)
      into v_fact, v_audience
      from public.notices n
     where n.id = p_id;

  elsif p_event = 'activity_created' then
    select jsonb_build_object('activity_id', a.id, 'kind', a.kind, 'title', a.title,
                              'activity_date', a.activity_date, 'start_time', a.start_time),
           array(select m.id from public.members m
                  where m.status = 'approved'
                    and m.id is distinct from a.created_by)
      into v_fact, v_audience
      from public.activities a
     where a.id = p_id
       -- The half of the broadcast rule that survives the trigger being
       -- bypassed. Null created_by notifies for the reason the trigger gives.
       and (a.created_by is null or public.member_is_staff(a.created_by));

  elsif p_event = 'waitlist_offered' then
    select jsonb_build_object('activity_id', a.id, 'kind', a.kind, 'title', a.title,
                              'activity_date', a.activity_date,
                              'offer_expires_at', aa.offer_expires_at),
           array[aa.member_id]
      into v_fact, v_audience
      from public.activity_applications aa
      join public.activities a on a.id = aa.activity_id
      join public.members m    on m.id = aa.member_id
     where aa.id = p_id
       and aa.offer_status = 'offered'
       and aa.offer_expires_at is not null
       and aa.offer_expires_at > now()
       and m.status = 'approved';

  elsif p_event = 'activity_comment_created' then
    -- Audience is the activity's own applicants and waitlisters, not the
    -- whole club — a comment thread on one 훈련 is not club news. Excludes
    -- the commenter, same rule as notice_created/activity_created. Sourced
    -- from activity_applications (both application_type values), which is
    -- exactly upstream's own description of this feature: "댓글 등록 시
    -- 해당 일정 신청자·대기자에게 알림이 전송됩니다."
    select jsonb_build_object('activity_id', a.id, 'kind', a.kind, 'title', a.title,
                              'activity_date', a.activity_date, 'body', c.body),
           array(select aa.member_id from public.activity_applications aa
                  join public.members m on m.id = aa.member_id
                 where aa.activity_id = a.id
                   and m.status = 'approved'
                   and aa.member_id is distinct from c.member_id)
      into v_fact, v_audience
      from public.activity_comments c
      join public.activities a on a.id = c.activity_id
     where c.id = p_id;

  elsif p_event = 'self_test' then
    select '{}'::jsonb, array[m.id]
      into v_fact, v_audience
      from public.members m
     where m.id = p_id and m.status = 'approved';

  else
    return null;
  end if;

  if v_fact is null then
    return null;
  end if;

  return jsonb_build_object(
    'event', p_event,
    'fact', v_fact,
    'member_count', (
      select count(distinct ps.member_id)
        from public.push_subscriptions ps
       where ps.member_id = any(v_audience)
    ),
    'recipients', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ps.id, 'endpoint', ps.endpoint,
               'p256dh', ps.p256dh, 'auth', ps.auth))
        from public.push_subscriptions ps
       where ps.member_id = any(v_audience)
    ), '[]'::jsonb)
  );
end $$;

comment on function public.push_notify_context_v1(text, uuid) is
  '알림 대상과 문구 근거를 이벤트 한 건에서 직접 읽어 돌려준다. 호출자는 수신자를 지정할 수 없고, 문구도 행에서만 나온다. 일정 알림은 운영진이 등록한 것만 대상이 된다.';

-- ==================================================================== trigger
create or replace function public.activity_comments_notify_created()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.request_push_notify('activity_comment_created', new.id);
  return null;
end $$;

comment on function public.activity_comments_notify_created() is
  '일정 댓글이 등록되면 그 일정의 신청자·대기자에게(작성자 제외) 알림을 요청한다.';

drop trigger if exists activity_comments_notify_created on public.activity_comments;
create trigger activity_comments_notify_created
  after insert on public.activity_comments
  for each row execute function public.activity_comments_notify_created();

-- --------------------------------------------------------------- execute rights
-- push_notify_context_v1's grant is unaffected by this file (still service_role
-- only, still revoked from public/anon/authenticated by 0022) — restated here
-- only for the new trigger function, same footer shape as 0022's.
revoke all on function public.activity_comments_notify_created() from public, anon, authenticated, service_role;
