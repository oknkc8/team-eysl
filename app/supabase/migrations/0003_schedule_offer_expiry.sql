-- 0003 — actually run the waitlist offer sweep.
--
-- 0001 created expire_stale_offers() and left a comment saying "run this on a
-- schedule". Nothing ever did. Verified against the live database: pg_cron was
-- available (1.6.4) but not installed, no cron job existed, and no client called
-- the function — only the generated TypeScript type referenced it.
--
-- That is precisely the legacy defect we set out to fix. The old UI promises
-- "자동으로 다음 대기자에게 기회가 넘어갑니다" and nothing advances the queue; we
-- rebuilt the mechanism and then also left it unwired. Building the machinery is
-- not the same as shipping the behavior.

create extension if not exists pg_cron with schema extensions;

-- Every five minutes. Offers carry a 12-hour window, so the exact tick does not
-- matter; what matters is that a lapsed offer moves on without anyone watching.
-- Unschedule first so re-running this migration does not stack duplicate jobs.
do $$
begin
  perform cron.unschedule('expire-stale-offers');
exception
  when others then null;  -- no such job yet
end $$;

select cron.schedule(
  'expire-stale-offers',
  '*/5 * * * *',
  $job$ select public.expire_stale_offers(); $job$
);

comment on function public.expire_stale_offers() is
  '만료된 대기자 오퍼를 정리하고 다음 순번에게 넘긴다. pg_cron이 5분마다 실행한다.';
