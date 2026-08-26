-- 0037 — 자유게시판 글 수정에서 분실 갱신(lost update)을 막는다.
--
-- WHAT WAS WRONG. 0033's update_board_post_v1 takes the row lock before it
-- decides anything, so two concurrent edits execute in a definite ORDER — and
-- that is all the lock buys. It writes `title` and `body` wholesale from
-- whatever the form held, with no statement about which version that form was
-- built from. So an author editing one post in two tabs, or on a phone and a
-- laptop, has the second save overwrite the first, and BOTH report success.
--
-- This is the same family as the defect the rebuild exists to repair. His
-- addComment (index.html:2001) loses comments because it writes back a whole
-- jsonb array built from a stale client copy; this would lose a post body
-- because it writes back a whole row built from a stale form. Different
-- mechanism, identical experience: the member typed something, it said saved,
-- it is gone.
--
-- WHAT THIS DOES. The caller now says which version it is editing, and the
-- function compares that under the lock it already holds. A mismatch is refused
-- rather than written.
--
-- WHY THE THREE-ARGUMENT VERSION IS DROPPED RATHER THAN LEFT ALONE. Adding a
-- parameter creates an OVERLOAD; it does not replace anything. PostgREST picks
-- an overload by the keys in the JSON body, so leaving the old one in place
-- would mean a request carrying only p_post_id/p_title/p_body still reaches the
-- version with no check — the unsafe path would remain reachable by anyone who
-- simply omitted the new field, which is exactly the shape of a fix that does
-- not fix anything. There is one way to update a post, and it is checked.
--
-- WHY NOT A version COLUMN. `updated_at` is already on the table and already
-- read by the screen, and 0033's header explains why the column set is his
-- exactly: a future cutover should read his rows rather than a translation of
-- them. The one thing a timestamp lacks against a counter is a guarantee that
-- it always MOVES — now() is transaction-start time, so two writes beginning in
-- the same microsecond could stamp the same value and a stale third write would
-- then match. The update below closes that by construction; see its comment.
--
-- DELETE IS DELIBERATELY UNCHANGED. Removing a post is not a lost update: the
-- author's intent is that the row goes away, and it does not matter what the
-- text said when they last looked. Adding an expectation there would only
-- invent a conflict for somebody trying to delete something twice.

-- ==================================================== replace, not overload
drop function if exists public.update_board_post_v1(uuid, text, text);

create or replace function public.update_board_post_v1(
  p_post_id             uuid,
  p_title               text,
  p_body                text,
  p_expected_updated_at timestamptz
)
returns public.board_posts
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me   uuid := public.current_member_id();
  v_post public.board_posts%rowtype;
  v_row  public.board_posts;
begin
  if v_me is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  -- No opt-out. A null expectation is refused rather than treated as "skip the
  -- check", because an optional guard is one a caller drifts away from — and
  -- the caller that forgets is the one that reintroduces the defect.
  if p_expected_updated_at is null then
    raise exception 'expected updated_at is required' using errcode = '22023';
  end if;

  -- Locked before anything is decided, so the row this function judges is the
  -- row it then writes. Without it a concurrent delete lands between the two
  -- and the UPDATE silently touches nothing.
  select * into v_post from public.board_posts where id = p_post_id for update;
  if not found then
    raise exception 'no such post' using errcode = '42704';
  end if;

  -- Authorship BEFORE staleness, on purpose. A member who may not edit this
  -- post should be told that and nothing else; answering "it changed elsewhere"
  -- first would confirm the row exists and leak when it was last touched to
  -- somebody with no business editing it.
  if v_post.author_id <> v_me then
    raise exception 'not your post' using errcode = '42501';
  end if;

  -- The whole point of this migration, and it is inside the lock so no write
  -- can slip between the comparison and the UPDATE.
  --
  -- Its errcode is deliberately distinct from 42704 above: the person editing
  -- needs to know WHICH happened, because the two ask opposite things of them —
  -- "somebody changed this, here it is, reconcile" against "this is gone, stop
  -- typing". The client keys off the SQLSTATE in PostgREST's `code`, not off
  -- the HTTP status.
  --
  -- DETAIL carries the row the conflict was against, so the screen can show the
  -- current text from this one answer. A refetch instead would be a second
  -- round trip that could itself land after a third edit — the value shown
  -- would then not be the value that was compared.
  if v_post.updated_at <> p_expected_updated_at then
    raise exception 'post changed elsewhere'
      using errcode = 'PT409',
            detail  = jsonb_build_object(
                        'title',      v_post.title,
                        'body',       v_post.body,
                        'updated_at', v_post.updated_at
                      )::text;
  end if;

  update public.board_posts
     set title      = public.board_post_text(p_title, 'title', 120),
         body       = public.board_post_text(p_body,  'body',  10000),
         -- greatest(...), not a bare now(), and this is what makes the timestamp
         -- safe to use as a version. now() is TRANSACTION-start time, so two
         -- updates beginning in the same microsecond would stamp the same value
         -- and a stale third write would then compare equal and be accepted.
         -- Taking one microsecond past the value being replaced makes the column
         -- strictly increasing per row by construction, whatever the clock does.
         -- It also keeps updated_at > created_at, which is what 수정됨 reads.
         updated_at = greatest(now(), v_post.updated_at + interval '1 microsecond')
   where id = p_post_id
  returning * into v_row;

  -- author_id is not in the SET list at all, so an edit cannot walk a post over
  -- to somebody else one column at a time.
  return v_row;
end $$;

comment on function public.update_board_post_v1(uuid, text, text, timestamptz) is
  '자유게시판 글 수정. 작성자만 호출할 수 있고, 수정하려는 판본의 updated_at을 함께 보내야 한다. 그 사이 다른 곳에서 먼저 수정됐으면 PT409로 거절하고 현재 내용을 DETAIL에 담아 돌려준다.';

-- ========================================================== execute rights
-- DROP took the old function's grants with it, and the new signature starts
-- with none of its own. 0026 closed the default privileges that once left
-- anon holding EXECUTE on a fresh function, so the revoke is belt and braces —
-- and cheap enough that the next reader does not have to know 0026 exists.
revoke all on function public.update_board_post_v1(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.update_board_post_v1(uuid, text, text, timestamptz)
  to authenticated;
