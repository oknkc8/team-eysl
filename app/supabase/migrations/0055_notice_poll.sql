-- 0055 — 공지 투표. A poll attached to a notice, its options, and its votes.
--
-- Ported from upstream's notice-poll-v115.js, which is one of the sidecars
-- sw.js precaches and injects, so it is live code rather than one of the three
-- dead ones. The five RPC names below are his names, read out of that file:
--
--   save_notice_poll_v1  get_notice_poll_v1  cast_notice_poll_vote_v1
--   add_notice_poll_option_v1  delete_notice_poll_v1
--
-- ============================================================================
-- THREE TABLES, NOT TWO
-- ============================================================================
--
-- The brief called for a poll table and a vote table. Options are a third table
-- rather than a jsonb array on the poll row, and that is not decoration:
-- add_notice_poll_option_v1 exists precisely so somebody can add an option to a
-- poll that is already open. Held as jsonb, two members adding an option at the
-- same moment are two whole-array rewrites from stale client copies, and one of
-- them disappears — which is `addComment()`'s defect (index.html:2001), the one
-- 0004 was written to stop repeating. A row per option cannot lose a concurrent
-- insert, and a vote can then carry a real FK to the thing it voted for.
--
-- ============================================================================
-- WHY THE TABLES CARRY NO POLICIES
-- ============================================================================
--
-- All three are RLS-on with zero policies and their standing grants revoked,
-- the shape 0053 argues at length and `attendance` has carried since 0001. The
-- argument is the same one and it is worth restating in this feature's terms,
-- because here it is doing more work than usual:
--
--   voting        the vote's member_id must come from the session. A policy can
--                 check `member_id = current_member_id()`; it cannot SUPPLY it.
--                 A WITH CHECK leaves the client naming itself, and a poll whose
--                 voter list the client fills in is not a poll.
--
--   reading       an anonymous poll's identities must not be readable AT ALL,
--                 and `notice_poll_votes` holds them. There is no projection of
--                 that table a member may have. So it gets no SELECT policy and
--                 no grant, and the only way to the counts is the function
--                 below, which computes them and drops the names.
--
-- ============================================================================
-- ANONYMITY IS ENFORCED IN THE FUNCTION, AND A VIEW COULD NOT DO IT
-- ============================================================================
--
-- get_notice_poll_v1 returns `voters: null` for an anonymous poll — to every
-- caller, staff and the poll's own creator included. Not an empty array: an
-- empty array is a claim that nobody voted, and this function must not make a
-- claim it is refusing to answer.
--
-- The obvious alternative — a view that projects the safe columns — is the
-- exact shape 0019 had to close. A view has no RLS behind it, so its grants are
-- the whole gate, and `grant select` on anything reaching notice_poll_votes
-- hands over every identity the moment somebody adds a column or an
-- auto-updatable view turns out to be writable. The rule lives in one plpgsql
-- branch here and nowhere else.
--
-- WHAT ANONYMITY DOES NOT COVER, stated because it is accepted rather than
-- fixed: an anonymous poll with a single voter leaks by arithmetic. The count
-- goes from 0 to 1 while one member is looking at the screen, and total_voters
-- moves with it. A small club makes that worse, not better — three votes across
-- two options in a roster of five is not much of a hiding place either. The
-- honest description of this feature is "your name is not printed", not "your
-- vote is secret", and any Korean UI copy that promises the second would be
-- false in exactly the way this project keeps finding sentences to be false.
--
-- ============================================================================
-- THE CLOSING TIME IS THE DATABASE'S RULE
-- ============================================================================
--
-- cast_notice_poll_vote_v1 takes `select ... for update` on the poll row before
-- it compares closes_at to now(). Without the lock a concurrent
-- save_notice_poll_v1 can move closes_at between the read and the insert, and
-- the vote is then accepted against a deadline that no longer exists — the
-- write succeeds, nothing errors, and the poll quietly holds a vote cast after
-- it closed. The lock makes the check and the insert one decision.
--
-- The screen also hides the vote control on a closed poll. That is UX; this is
-- the enforcement, and a client that skips the screen meets 42501.
--
-- ============================================================================
-- REFUSE, DO NOT RETURN EMPTY
-- ============================================================================
--
-- Every gate below raises with errcode 42501 rather than returning zero rows or
-- a null. 0053's argument: "nobody voted" and "you may not ask" are different
-- facts, and an empty result presents the second as the first.
--
-- ============================================================================
-- ONE DEVIATION FROM THE BRIEF, AND ITS REASON
-- ============================================================================
--
-- The brief said adding an option is limited to the poll's creator and staff.
-- Implemented as written, `allow_option_add` — upstream's 선택항목 추가 허용
-- checkbox, which his composer writes and his voter UI reads — would have no
-- effect on anything, and this migration would ship a column and a control that
-- do nothing. So the rule here is the union:
--
--     allow_option_add  OR  created_by = current_member_id()  OR  is_staff()
--
-- The brief's floor is intact — the creator and staff may always add, whatever
-- the flag says. Narrowing back to the brief is deleting one arm of one `if`;
-- if that is the call, delete `v_poll.allow_option_add` from the condition in
-- add_notice_poll_option_v1 and drop the column.
--
-- ============================================================================
-- A NAME THAT DIFFERS FROM UPSTREAM ON PURPOSE
-- ============================================================================
--
-- His client sends `p_option_type`; this takes `p_option_kind`, per the brief,
-- and the column is `option_kind`. It is a property of the POLL and not of each
-- option — his composer has one pair of 텍스트/날짜 tabs for the whole poll, not
-- one per row, so a per-option kind would be storing a possibility his UI
-- cannot produce and ours has no reason to invent. Recorded here because a port
-- of his sidecar would otherwise fail signature resolution on a name, which
-- PostgREST reports as the function not existing.

-- ---------------------------------------------------------------------- polls
create table if not exists public.notice_polls (
  id               uuid primary key default gen_random_uuid(),
  -- One poll per notice. His composer offers no way to make a second one, and
  -- the unique constraint is what lets get_notice_poll_v1 and
  -- delete_notice_poll_v1 be addressed by notice_id the way his client
  -- addresses them.
  notice_id        uuid not null unique references public.notices(id) on delete cascade,
  title            text not null,
  option_kind      text not null default 'text' check (option_kind in ('text', 'date')),
  allow_multiple   boolean not null default false,
  anonymous        boolean not null default false,
  allow_option_add boolean not null default false,
  -- Null means no deadline, which his UI prints as 종료시간 없음. A poll with no
  -- closes_at never closes, so `is_closed` is false forever and the vote
  -- control stays up — that is his behaviour, not an omission here.
  closes_at        timestamptz,
  -- ON DELETE SET NULL, not CASCADE: a member leaving must not take the club's
  -- poll with them. The authorization arm that reads this column simply stops
  -- matching, leaving staff, which is the right fallback.
  created_by       uuid references public.members(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.notice_polls is
  '공지에 붙는 투표. 공지 하나당 최대 한 개이며, 접근은 전부 SECURITY DEFINER 함수를 거친다.';
comment on column public.notice_polls.anonymous is
  '익명 투표 여부. 참이면 get_notice_poll_v1 이 누가 투표했는지를 운영진과 작성자에게도 돌려주지 않는다.';
comment on column public.notice_polls.option_kind is
  '항목 종류. 투표 전체의 성질이며 항목별로 다를 수 없다. date 이면 항목 값은 YYYY-MM-DD 형식이어야 한다.';

-- -------------------------------------------------------------------- options
create table if not exists public.notice_poll_options (
  id         uuid primary key default gen_random_uuid(),
  poll_id    uuid not null references public.notice_polls(id) on delete cascade,
  label      text not null,
  sort_order integer not null default 0,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.notice_poll_options is
  '투표 항목. 한 항목이 한 행이며, 항목을 배열로 들고 있지 않는 이유는 0055 헤더에 적혀 있다.';

-- Covers both the cascade from notice_polls and the ordered read in
-- get_notice_poll_v1. created_at breaks the tie so two options added in the
-- same second keep a stable order instead of swapping between refetches.
create index if not exists notice_poll_options_poll_idx
  on public.notice_poll_options (poll_id, sort_order, created_at);

-- ---------------------------------------------------------------------- votes
create table if not exists public.notice_poll_votes (
  option_id uuid not null references public.notice_poll_options(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  -- Denormalised from the option's poll so that "this member's votes in this
  -- poll" is one index lookup rather than a join, which is what
  -- cast_notice_poll_vote_v1 deletes by on every call. Written only by that
  -- function, from the locked poll row, so it cannot disagree with the option.
  poll_id   uuid not null references public.notice_polls(id) on delete cascade,
  voted_at  timestamptz not null default now(),
  primary key (option_id, member_id)
);
comment on table public.notice_poll_votes is
  '투표 기록. 익명 투표라도 member_id 는 저장되며, 익명 여부는 이 표를 읽는 함수가 이름을 돌려주지 않는 것으로 지킨다.';

-- The primary key leads with option_id, so the per-option count is covered and
-- the cascade from an option is too. Neither of the other two cascades is, and
-- both fire on ordinary operations — a member is deleted by cleanup.sql, a poll
-- by delete_notice_poll_v1 — so both get an index.
create index if not exists notice_poll_votes_poll_member_idx
  on public.notice_poll_votes (poll_id, member_id);
create index if not exists notice_poll_votes_member_idx
  on public.notice_poll_votes (member_id);

-- Zero policies on all three, deliberately. See the header.
alter table public.notice_polls        enable row level security;
alter table public.notice_poll_options enable row level security;
alter table public.notice_poll_votes   enable row level security;

-- RLS already refuses. This takes the standing grant away as well, so a policy
-- added later cannot arrive with the grant already in place — 0014's argument,
-- and the half that stayed wrong there. A new table in public still lands with
-- authenticated holding arwdDxtm, which is right for a table policies gate and
-- wrong for these.
revoke all on public.notice_polls        from public, anon, authenticated;
revoke all on public.notice_poll_options from public, anon, authenticated;
revoke all on public.notice_poll_votes   from public, anon, authenticated;

-- ------------------------------------------------------------ shared internals
-- Whether the caller may manage this poll. Read by three of the five functions,
-- so it is one definition rather than three copies that can drift apart.
create or replace function public.notice_poll_can_manage(p_poll public.notice_polls)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_staff()
      or (p_poll.created_by is not null
          and p_poll.created_by = public.current_member_id())
$$;

comment on function public.notice_poll_can_manage(public.notice_polls) is
  '투표를 수정·삭제할 수 있는지. 작성자 본인이거나 운영진이면 참이다.';

-- A date-kind option's label is a date, and this is where that is true rather
-- than merely intended. Without it `option_kind` is a string the screen happens
-- to branch on, and one poll saved through a client that skips the check leaves
-- a label the date renderer prints back raw.
create or replace function public.notice_poll_check_label(p_kind text, p_label text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_label text := btrim(coalesce(p_label, ''));
begin
  if v_label = '' then
    raise exception '투표 항목을 입력해주세요' using errcode = '22023';
  end if;
  if p_kind = 'date' and v_label !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '날짜 항목은 YYYY-MM-DD 형식이어야 합니다' using errcode = '22023';
  end if;
  return v_label;
end $$;

-- ---------------------------------------------------------------- read it back
-- The whole poll as one jsonb document, or null when the notice has none.
--
-- plpgsql rather than sql because this has to RAISE, and because the anonymity
-- branch is a decision rather than a projection.
--
-- Every reference is schema- or alias-qualified. `returns jsonb` avoids the
-- `returns table` shadowing trap, but the habit is cheap and the next person
-- adding an output column should not have to notice the difference.
create or replace function public.get_notice_poll_v1(p_notice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me      uuid;
  v_poll    public.notice_polls;
  v_closed  boolean;
  v_options jsonb;
  v_mine    jsonb;
  v_total   integer;
begin
  -- A poll lives on a notice, and every approved member may read a notice. A
  -- caller who is not one is refused rather than told the poll does not exist:
  -- the two are different facts.
  v_me := public.current_member_id();
  if v_me is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  select * into v_poll
    from public.notice_polls p
   where p.notice_id = p_notice_id;

  -- Null, not a raise. A notice with no poll is the ordinary case — most
  -- notices have none — and his client draws nothing for it.
  if not found then
    return null;
  end if;

  v_closed := v_poll.closes_at is not null and v_poll.closes_at <= now();

  -- Distinct members, not rows: a multi-select poll has one member behind
  -- several votes, and "3명 참여" must not count the same person three times.
  select count(distinct v.member_id) into v_total
    from public.notice_poll_votes v
   where v.poll_id = v_poll.id;

  -- THE ANONYMITY BRANCH. `voters` is null for an anonymous poll and a name
  -- array otherwise; it is never an empty array standing in for "we are not
  -- telling you", which would read as "nobody voted".
  --
  -- The count is computed from notice_poll_votes and NOT from the joined
  -- names, so it stays right when a name is missing. member_public_v carries
  -- `where status = 'approved'` (0019), so a member who voted and was
  -- afterwards blocked drops out of the name list — same behaviour 0053
  -- documents for its reader list. The vote still counts; only the voter stops
  -- being nameable. That asymmetry is why the two are separate subqueries
  -- rather than one join with a count taken over it.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',     o.id,
               'label',  o.label,
               'count',  (select count(*)
                            from public.notice_poll_votes v
                           where v.option_id = o.id),
               'voters', case
                           when v_poll.anonymous then null
                           else coalesce(
                                  (select jsonb_agg(m.nickname order by m.nickname)
                                     from public.notice_poll_votes v
                                     join public.member_public_v m on m.id = v.member_id
                                    where v.option_id = o.id),
                                  '[]'::jsonb)
                         end
             )
             order by o.sort_order, o.created_at
           ),
           '[]'::jsonb)
    into v_options
    from public.notice_poll_options o
   where o.poll_id = v_poll.id;

  -- The caller's own choices, returned even for an anonymous poll: a member
  -- already knows how they voted, and without this the screen cannot show them
  -- their own selection or offer 투표 취소.
  select coalesce(jsonb_agg(v.option_id), '[]'::jsonb)
    into v_mine
    from public.notice_poll_votes v
   where v.poll_id = v_poll.id
     and v.member_id = v_me;

  return jsonb_build_object(
    'id',               v_poll.id,
    'notice_id',        v_poll.notice_id,
    'title',            v_poll.title,
    'option_kind',      v_poll.option_kind,
    'allow_multiple',   v_poll.allow_multiple,
    'anonymous',        v_poll.anonymous,
    'allow_option_add', v_poll.allow_option_add,
    'closes_at',        v_poll.closes_at,
    'is_closed',        v_closed,
    'total_voters',     v_total,
    -- So the screen can offer 수정/삭제 without a second round trip, and so the
    -- two ends agree on one answer rather than each deciding for themselves.
    'can_manage',       public.notice_poll_can_manage(v_poll),
    'can_add_option',   (v_poll.allow_option_add or public.notice_poll_can_manage(v_poll))
                        and not v_closed,
    'options',          v_options,
    'my_option_ids',    v_mine
  );
end $$;

comment on function public.get_notice_poll_v1(uuid) is
  '공지에 붙은 투표 하나를 통째로 돌려준다. 투표가 없으면 null 이다. 익명 투표면 누가 어느 항목을 골랐는지를 운영진과 작성자를 포함해 누구에게도 돌려주지 않는다.';

-- --------------------------------------------------------------- create/update
-- p_options is the DESIRED FINAL LIST, not a delta — the same contract
-- save_notice_v1 uses for attachments, and for the same reason: a client that
-- sends a delta has to be right about what the server already holds.
--
-- An element carrying an `id` that belongs to this poll is kept and relabelled.
-- Anything else is a new option and gets a SERVER-DERIVED id. His client
-- generates a uuid in the browser for every option, new ones included; that
-- value is accepted and ignored rather than trusted, so a client cannot plant
-- an id that collides with another poll's option.
--
-- An option dropped from the list is deleted, and its votes go with it through
-- the cascade. That is the intended meaning of removing an option and it is
-- worth saying out loud: editing a poll can destroy votes already cast.
create or replace function public.save_notice_poll_v1(
  p_notice_id        uuid,
  p_title            text,
  p_option_kind      text,
  p_options          jsonb,
  p_allow_multiple   boolean,
  p_anonymous        boolean,
  p_allow_option_add boolean,
  p_closes_at        timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid;
  v_poll  public.notice_polls;
  v_title text;
  v_kind  text;
  v_item  jsonb;
  v_id    uuid;
  v_label text;
  v_keep  uuid[] := '{}';
  v_order integer := 0;
begin
  v_me := public.current_member_id();
  if v_me is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  if not exists (select 1 from public.notices n where n.id = p_notice_id) then
    raise exception 'no such notice' using errcode = '42704';
  end if;

  v_title := btrim(coalesce(p_title, ''));
  if v_title = '' then
    raise exception '투표 제목을 입력해주세요' using errcode = '22023';
  end if;

  v_kind := coalesce(p_option_kind, 'text');
  if v_kind not in ('text', 'date') then
    raise exception '투표 항목 종류가 올바르지 않습니다' using errcode = '22023';
  end if;

  -- Two is the floor his composer enforces (투표 항목을 2개 이상 입력해주세요) and
  -- the floor a poll needs to mean anything. Enforced here as well, because his
  -- check is in a browser.
  if jsonb_array_length(coalesce(p_options, '[]'::jsonb)) < 2 then
    raise exception '투표 항목을 2개 이상 입력해주세요' using errcode = '22023';
  end if;
  if jsonb_array_length(p_options) > 30 then
    raise exception '투표 항목은 30개까지 만들 수 있습니다' using errcode = '22023';
  end if;

  -- FOR UPDATE, so that two staff saving the same poll at once serialise here
  -- rather than interleaving their option rewrites. Nothing is locked when the
  -- poll does not exist yet; the unique constraint on notice_id is what decides
  -- that race, and the loser gets 23505 rather than a second poll.
  select * into v_poll
    from public.notice_polls p
   where p.notice_id = p_notice_id
     for update;

  if found then
    if not public.notice_poll_can_manage(v_poll) then
      raise exception 'only the poll author or staff may edit this poll'
        using errcode = '42501';
    end if;

    -- ANONYMITY IS A PROMISE MADE BEFORE THE VOTE, SO IT CANNOT BE WITHDRAWN
    -- AFTER ONE.
    --
    -- Without this, the whole anonymity design is decoration: a manager creates
    -- an anonymous poll, the screen tells members 「이름을 공개하지 않음」, they
    -- vote on the strength of that, and the manager then saves the same poll
    -- with anonymous = false. Every name that was collected under the promise
    -- becomes visible, and it can be switched back afterwards so the exposure
    -- leaves no trace on the poll.
    --
    -- get_notice_poll_v1 refusing to return voters for an anonymous poll is
    -- exactly as strong as the flag it reads, and nothing else was defending
    -- the flag.
    --
    -- Refused rather than repaired. Deleting the votes to permit the change
    -- would silently discard what people actually said, and that is a decision
    -- for a person who can go and ask them.
    if v_poll.anonymous and not coalesce(p_anonymous, false)
       and exists (select 1 from public.notice_poll_votes v where v.poll_id = v_poll.id) then
      raise exception '이미 투표한 사람이 있어 익명을 해제할 수 없습니다. 익명으로 받은 이름은 공개하지 않습니다.'
        using errcode = '42501';
    end if;

    update public.notice_polls p
       set title            = v_title,
           option_kind      = v_kind,
           allow_multiple   = coalesce(p_allow_multiple, false),
           anonymous        = coalesce(p_anonymous, false),
           allow_option_add = coalesce(p_allow_option_add, false),
           closes_at        = p_closes_at,
           updated_at       = now()
     where p.id = v_poll.id
     returning * into v_poll;
  else
    -- Creating a poll is writing to a notice, and only staff may write a
    -- notice (0040's save_notice_v1 carries the same line). SECURITY DEFINER
    -- means notices' own policies are not consulted, so this is the whole gate.
    if not public.is_staff() then
      raise exception 'only staff may attach a poll to a notice'
        using errcode = '42501';
    end if;

    insert into public.notice_polls
      (notice_id, title, option_kind, allow_multiple, anonymous,
       allow_option_add, closes_at, created_by)
    values
      (p_notice_id, v_title, v_kind, coalesce(p_allow_multiple, false),
       coalesce(p_anonymous, false), coalesce(p_allow_option_add, false),
       p_closes_at, v_me)
    returning * into v_poll;
  end if;

  -- Walk the desired list in order. sort_order is the position in the array, so
  -- reordering in the composer is carried by the same call that relabels.
  for v_item in select * from jsonb_array_elements(p_options)
  loop
    v_label := public.notice_poll_check_label(v_kind, v_item ->> 'label');

    -- A malformed or unknown id is not an error: his client sends a browser
    -- uuid for new options too, so an id naming nothing in this poll simply
    -- means "new". The `poll_id =` arm is what stops it meaning "somebody
    -- else's option".
    begin
      v_id := (v_item ->> 'id')::uuid;
    exception when invalid_text_representation then
      v_id := null;
    end;

    if v_id is not null and exists (
      select 1 from public.notice_poll_options o
       where o.id = v_id and o.poll_id = v_poll.id
    ) then
      update public.notice_poll_options o
         set label = v_label, sort_order = v_order
       where o.id = v_id;
    else
      insert into public.notice_poll_options (poll_id, label, sort_order, created_by)
      values (v_poll.id, v_label, v_order, v_me)
      returning id into v_id;
    end if;

    v_keep  := v_keep || v_id;
    v_order := v_order + 1;
  end loop;

  -- Anything not named is gone — UNLESS SOMEBODY HAS VOTED FOR IT.
  --
  -- "The list you send is the final list" is a reasonable contract for a form,
  -- and it becomes a data-loss bug the moment the poll can grow underneath the
  -- form. With allow_option_add on, a member adds 「토요일 저녁」 and three
  -- people vote for it; a staffer who opened the editor before that and then
  -- changes only the notice BODY submits the options they loaded, which do not
  -- include it. The member's option and every vote on it disappear, both
  -- operations report success, and no screen ever mentions it.
  --
  -- The same shape reaches it by a second route: if an attachment upload fails
  -- after the poll saved, the editor stays open holding the options it sent
  -- rather than the ids the server returned, and a retry recreates them —
  -- deleting the originals and any votes cast in between.
  --
  -- Refusing is the fix that does not require the editor to be right. A
  -- staffer who genuinely means to remove an option that people have voted on
  -- can clear it deliberately; what they cannot do any more is remove it by not
  -- knowing it existed.
  if exists (
    select 1
      from public.notice_poll_options o
      join public.notice_poll_votes v on v.option_id = o.id
     where o.poll_id = v_poll.id
       and not (o.id = any (v_keep))
  ) then
    raise exception '이미 표가 찍힌 항목은 지울 수 없습니다. 화면을 새로 고쳐 최신 항목을 불러온 뒤 다시 저장해 주세요.'
      using errcode = '42501';
  end if;

  delete from public.notice_poll_options o
   where o.poll_id = v_poll.id
     and not (o.id = any (v_keep));

  return public.get_notice_poll_v1(p_notice_id);
end $$;

comment on function public.save_notice_poll_v1(uuid, text, text, jsonb, boolean, boolean, boolean, timestamptz) is
  '공지 투표를 만들거나 고친다. p_options 는 최종 목록이며 빠진 항목은 삭제된다. 다만 이미 표가 찍힌 항목은 삭제를 거부한다 — 오래된 편집 화면이 회원이 추가한 항목과 그 표를 조용히 지우는 것을 막기 위해서다. 표가 있는 익명 투표의 익명 해제도 거부한다.';

-- ----------------------------------------------------------------------- vote
-- The member's whole ballot in one call: everything they had is deleted and
-- what they sent is inserted. An empty array is therefore 투표 취소, which is
-- exactly how his client cancels — cast_notice_poll_vote_v1 with p_option_ids
-- of []. There is no separate retract function and there should not be, because
-- two doors onto one decision is how the two ends stop agreeing.
create or replace function public.cast_notice_poll_vote_v1(
  p_poll_id    uuid,
  p_option_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid;
  v_poll  public.notice_polls;
  v_ids   uuid[];
  v_count integer;
begin
  v_me := public.current_member_id();
  if v_me is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  -- FOR UPDATE BEFORE THE DEADLINE IS READ. This is the point of the whole
  -- function. A concurrent save_notice_poll_v1 can move closes_at, and without
  -- the lock the sequence "read closes_at, deadline moves, insert" accepts a
  -- vote against a deadline that no longer exists — silently, because both
  -- statements succeed. The lock makes the check and the write one decision.
  select * into v_poll
    from public.notice_polls p
   where p.id = p_poll_id
     for update;

  if not found then
    raise exception 'no such poll' using errcode = '42704';
  end if;

  -- clock_timestamp(), NOT now(). now() is the TRANSACTION START time and does
  -- not advance while this statement waits for the lock above — so a voter who
  -- began at 12:00:00, blocked until 12:00:02, and found a deadline of 12:00:01
  -- set by the transaction it was waiting for would compare 12:00:01 <= 12:00:00
  -- and vote anyway. Taking the lock before reading closes_at is necessary and
  -- was not sufficient; the timestamp has to be read after the wait as well.
  if v_poll.closes_at is not null and v_poll.closes_at <= clock_timestamp() then
    raise exception '마감된 투표입니다' using errcode = '42501';
  end if;

  -- Deduplicated, because a client sending the same option twice is asking for
  -- one vote and would otherwise meet the primary key as an error.
  select coalesce(array_agg(distinct t.id), '{}'::uuid[])
    into v_ids
    from unnest(coalesce(p_option_ids, '{}'::uuid[])) as t(id);

  if not v_poll.allow_multiple and coalesce(array_length(v_ids, 1), 0) > 1 then
    raise exception '이 투표는 한 항목만 고를 수 있습니다' using errcode = '22023';
  end if;

  -- Every id must belong to THIS poll. Same shape 0040 uses for an attachment
  -- that does not belong to its notice, same errcode: naming another poll's
  -- option is not a malformed request, it is reaching somewhere the caller was
  -- not given.
  if coalesce(array_length(v_ids, 1), 0) > 0 then
    select count(*) into v_count
      from public.notice_poll_options o
     where o.id = any (v_ids)
       and o.poll_id = v_poll.id;
    if v_count <> array_length(v_ids, 1) then
      raise exception 'option does not belong to this poll' using errcode = '42501';
    end if;
  end if;

  -- Replace, do not merge. The ballot the client sent is the ballot they hold
  -- afterwards, so unticking an option in a multi-select poll works without a
  -- second call saying which one was removed.
  delete from public.notice_poll_votes v
   where v.poll_id = v_poll.id
     and v.member_id = v_me;

  if coalesce(array_length(v_ids, 1), 0) > 0 then
    insert into public.notice_poll_votes (option_id, member_id, poll_id)
    select t.id, v_me, v_poll.id from unnest(v_ids) as t(id);
  end if;

  return public.get_notice_poll_v1(v_poll.notice_id);
end $$;

comment on function public.cast_notice_poll_vote_v1(uuid, uuid[]) is
  '호출한 회원의 표를 통째로 바꾼다. 빈 배열을 보내면 투표 취소다. 마감 시각은 이 함수가 잠금을 걸고 확인하므로 화면을 우회해도 막힌다.';

-- ----------------------------------------------------------------- add option
-- Adding an option to a poll that is already open.
--
-- The authorization is the union described in the header: the flag, or the
-- creator, or staff. The closed check is here as well as in the vote path,
-- because a poll that has finished must not grow an option nobody can ever
-- vote for — and it takes the same lock for the same reason.
create or replace function public.add_notice_poll_option_v1(
  p_poll_id uuid,
  p_label   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid;
  v_poll  public.notice_polls;
  v_label text;
  v_order integer;
begin
  v_me := public.current_member_id();
  if v_me is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  select * into v_poll
    from public.notice_polls p
   where p.id = p_poll_id
     for update;

  if not found then
    raise exception 'no such poll' using errcode = '42704';
  end if;

  if not (v_poll.allow_option_add or public.notice_poll_can_manage(v_poll)) then
    raise exception 'this poll does not accept new options' using errcode = '42501';
  end if;

  -- clock_timestamp(), NOT now(). now() is the TRANSACTION START time and does
  -- not advance while this statement waits for the lock above — so a voter who
  -- began at 12:00:00, blocked until 12:00:02, and found a deadline of 12:00:01
  -- set by the transaction it was waiting for would compare 12:00:01 <= 12:00:00
  -- and vote anyway. Taking the lock before reading closes_at is necessary and
  -- was not sufficient; the timestamp has to be read after the wait as well.
  if v_poll.closes_at is not null and v_poll.closes_at <= clock_timestamp() then
    raise exception '마감된 투표입니다' using errcode = '42501';
  end if;

  v_label := public.notice_poll_check_label(v_poll.option_kind, p_label);

  select count(*) into v_order
    from public.notice_poll_options o
   where o.poll_id = v_poll.id;

  if v_order >= 30 then
    raise exception '투표 항목은 30개까지 만들 수 있습니다' using errcode = '22023';
  end if;

  -- The same label twice is a duplicate row a member cannot tell apart on
  -- screen, so it is refused rather than created. Case- and space-insensitive,
  -- because "토요일" and "토요일 " are the same option to everybody except the
  -- database.
  if exists (
    select 1 from public.notice_poll_options o
     where o.poll_id = v_poll.id
       and lower(btrim(o.label)) = lower(v_label)
  ) then
    raise exception '이미 있는 항목입니다' using errcode = '23505';
  end if;

  insert into public.notice_poll_options (poll_id, label, sort_order, created_by)
  values (v_poll.id, v_label, v_order, v_me);

  return public.get_notice_poll_v1(v_poll.notice_id);
end $$;

comment on function public.add_notice_poll_option_v1(uuid, text) is
  '열려 있는 투표에 항목을 하나 더한다. 선택항목 추가를 허용한 투표거나, 부르는 사람이 작성자 또는 운영진이어야 한다.';

-- --------------------------------------------------------------------- delete
create or replace function public.delete_notice_poll_v1(p_notice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll public.notice_polls;
begin
  if public.current_member_id() is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  select * into v_poll
    from public.notice_polls p
   where p.notice_id = p_notice_id
     for update;

  -- Deleting a poll that is not there is not an error: his client calls this
  -- whenever a notice is saved with the composer switched off, whether or not
  -- the notice ever had a poll. Raising would turn every ordinary notice edit
  -- into a failure.
  if not found then
    return;
  end if;

  if not public.notice_poll_can_manage(v_poll) then
    raise exception 'only the poll author or staff may delete this poll'
      using errcode = '42501';
  end if;

  -- Options and votes go through the cascades declared above.
  delete from public.notice_polls p where p.id = v_poll.id;
end $$;

comment on function public.delete_notice_poll_v1(uuid) is
  '공지에서 투표를 지운다. 투표가 없으면 아무것도 하지 않는다. 항목과 표는 함께 사라진다.';

-- -------------------------------------------------------------- execute rights
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and 0014's
-- `alter default privileges ... revoke all on functions from anon` does not
-- reach that built-in grant. So all three roles are named explicitly and the
-- grant is re-added for authenticated alone — the footer shape 0050 and 0053
-- use. 0014 left anon holding EXECUTE once already by revoking from public.
--
-- notice_poll_can_manage and notice_poll_check_label are internals: no client
-- calls them, so they are revoked and NOT granted back. They are consulted from
-- inside SECURITY DEFINER bodies, which run with the owner's privileges — and
-- 0043's lesson does not apply, because neither is reached from an RLS policy
-- expression, which is what gets evaluated as the CALLING role.
revoke all on function public.notice_poll_can_manage(public.notice_polls) from public, anon, authenticated;
revoke all on function public.notice_poll_check_label(text, text)         from public, anon, authenticated;

revoke all on function public.get_notice_poll_v1(uuid)   from public, anon, authenticated;
grant execute on function public.get_notice_poll_v1(uuid) to authenticated;

revoke all on function public.save_notice_poll_v1(uuid, text, text, jsonb, boolean, boolean, boolean, timestamptz)   from public, anon, authenticated;
grant execute on function public.save_notice_poll_v1(uuid, text, text, jsonb, boolean, boolean, boolean, timestamptz) to authenticated;

revoke all on function public.cast_notice_poll_vote_v1(uuid, uuid[])   from public, anon, authenticated;
grant execute on function public.cast_notice_poll_vote_v1(uuid, uuid[]) to authenticated;

revoke all on function public.add_notice_poll_option_v1(uuid, text)   from public, anon, authenticated;
grant execute on function public.add_notice_poll_option_v1(uuid, text) to authenticated;

revoke all on function public.delete_notice_poll_v1(uuid)   from public, anon, authenticated;
grant execute on function public.delete_notice_poll_v1(uuid) to authenticated;
