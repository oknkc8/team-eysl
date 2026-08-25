# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TEAM EYSL — a Korean swimming club's member/training-management PWA ("TEAM EYSL Operating Auth", per the `<title>`). The entire application is a single static HTML file with no build step, framework, or backend code in this repo; it talks directly to a Supabase project for data, auth, and server logic.

## Repository reality check

- `index.html` (~3,850 lines) **is** the app: markup, all CSS (one `<style>` block), and all JS (five `<script>` blocks, ~270 flat global functions) in one file.
- `sw.js` — service worker (network-first fetch, web push handling).
- `manifest.webmanifest`, `icon-*.png` — PWA manifest/icons.
- The legacy app has no build step of its own: no bundler, no framework, no tests. Every commit on `upstream` is "Add files via upload" — the president maintains it by uploading edited files through the GitHub web UI. Expect the code to read as iteratively patched rather than designed (functions redefined later in the file to wrap earlier ones, at least one dead stub function, `escAttr` defined twice) — that's the normal state of this file, not a regression you introduced.
- The **rewrite** lives in `app/` and does have tooling: `app/package.json` (Vite, TypeScript, Vitest, ESLint), SQL migrations under `app/supabase/migrations/`, and CI in `.github/workflows/`. Commands run from `app/`; the legacy root stays frozen because it is what production still serves.

## Commands

There's nothing to build, lint, or test — none of those tools are configured. To check a change:
- Open `index.html` directly in a browser, or serve the directory statically (e.g. `npx serve .`, `python3 -m http.server`) and visit it — the app calls Supabase directly, no local server-side code is involved.
- The service worker (`sw.js`) and push notifications only register over `http(s)`; they silently no-op under `file://`, so use a static server if you're testing push/offline behavior.
- `manifest.webmanifest`'s `start_url`/`scope` are both `"/"`, and `sw.js` is registered from the site root — the app expects to be served from a domain root, not a subpath.

### Cache-busting convention (do this whenever you change app behavior)

There's no build hashing, so cache invalidation is manual. Two version strings must be bumped together or previously-installed PWA clients keep running stale cached JS/CSS and a stale service worker:
- `sw.js`: `const VERSION='team-eysl-...'`
- `index.html`, near `</body>`: `navigator.serviceWorker.register('/sw.js?v=...')`

## Architecture

**Screens**: ~28 `<div class="page" id="...">` blocks in the body (`home`, `notice`, `noticeDetail`, `chat`, `dmChat`, `schedule`, `trainingList`, `raceList`, `mypage`, `records`, `attendance`, `media`, `memberDirectory`, `memberApproval`, `memberAdmin`, `attendanceAdmin`, etc.). CSS makes exactly one `.page.active` visible at a time (`display:none` / `display:block`).

**Routing**: a single client-side router, `showPage(id)` (`index.html:1629`), toggles the active page/nav-button classes and inline-dispatches that page's `render*()` function. There's no history/URL routing beyond the browser default — no deep links.

**Boot**: `DOMContentLoaded` runs a `boot` array of render functions near the end of the file (~line 3800) to paint all sections on load.

### Backend: Supabase

Client setup is near the top of the script (`index.html:1143-1147`): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (Supabase's public/publishable anon key — intentionally client-visible by Supabase's design; real access control lives in Supabase Row Level Security policies and Edge Functions, not in this file).

- **Auth**: Supabase Auth sessions (`dbClient.auth.getSession()/signOut()`), gated by a `members` record fetched via `rpc('get_my_member')`. Members carry `status` (`approved`/`blocked`/`rejected`) and a role (`currentUser.actualRole`, e.g. `master_admin`). Flow lives in `loginMember()` (~1731), `initAuth()` (~1791), `logout()` (~1818).
- ⚠️ **Admin gating is client-side only** — `isMasterAdmin()` (`index.html:1820`, checks `currentUser.actualRole==='master_admin'`) is used throughout to hide/show admin UI. That's UX convenience, not enforcement; anything sensitive must actually be enforced by Supabase RLS/Edge Functions, since this check is trivially bypassable in the browser.
- **Direct table access** (`dbClient.from(...)`): `notices`, `activities`, `activity_applications`, `records`, `media_folders`, `media_files`, `push_subscriptions`.
- **`messages`** is never `.from()`-queried — it is reached two other ways: a Supabase **Realtime** subscription for INSERTs (`dbClient.channel('eysl-chat-…').on('postgres_changes', {table:'messages'})`, `index.html:2120`) and, for reads/sends, the `chat-api` Edge Function plus `chat_list_v4`. Easy to miss when inventorying tables by grepping `.from(` alone.
- **RPCs** (`dbClient.rpc(...)`): `get_my_member`, `get_member_approval_queue`, `get_activity_application_people`, `respond_waitlist_offer`, `set_my_real_name`, `set_my_avatar_path`.
- **Edge Functions** (`${SUPABASE_URL}/functions/v1/<name>`, called via `fetch`): `push-notify`, `manage-member-approval`, `chat-api` — chat and membership-approval logic run server-side here, not via direct table queries. Their source lives in the Supabase project, not in this repo.
- **Local caching only** (not source of truth): `localStorage` keys `eysl-core-cache`, `eysl-chat-cache`, `eysl-dm-preview-cache` hold JSON snapshots so the UI can paint instantly before a fresh fetch resolves.

### Web push

VAPID public key is hardcoded at `index.html:1341`. Subscribe/unsubscribe (~1350-1565) uses `reg.pushManager.subscribe/getSubscription`, persists the subscription row to `push_subscriptions`, and sends via the `push-notify` Edge Function. `sw.js` handles the `push` (show notification) and `notificationclick` (focus/open to `data.url`) events.

### Third-party libraries (CDN `<script>` tags, no local copies)

- `@supabase/supabase-js@2` — the client described above.
- `xlsx@0.18.5` (SheetJS) — parses uploaded Excel files for bulk swim-record import (`extractExcelResults`, ~line 3038+).
- `pdfjs-dist@3.11.174` — parses uploaded PDF files for record import (worker configured `index.html:958-959`, usage ~line 3084+).

## Repo topology

`origin` is **oknkc8/team-eysl**, a fork we own (ADMIN). `upstream` is **cutepms123-blip/team-eysl**, the club president's original — we have READ only there and must never assume push access. Work happens on `dev` and branches off it. Both repos are **public**, so no key, token, or `.env` may ever be committed.

The president edits `upstream` by uploading files through the GitHub web UI (every upstream commit is "Add files via upload"), so `upstream/main` can move without warning and without a merge-friendly history. Pull from it; don't expect to rebase onto it cleanly.

## Workflow rules

**Never commit straight to `dev` or `main`.** Every feature or fix branches off `dev`, gets a PR, and merges back into `dev`. `main` exists only to track the president's upstream — don't develop on it.

**Commit subjects and PR titles both carry a Conventional Commits prefix**, drawn from the same set as the branch prefix:

| Prefix | Use for | Branch |
|---|---|---|
| `feat:` | new user-facing capability | `feat/…` |
| `fix:` | defect repair | `fix/…` |
| `docs:` | documentation only | `docs/…` |
| `chore:` | tooling, config, workflow, deps | `chore/…` |
| `refactor:` | behavior-preserving restructure | `refactor/…` |
| `test:` | tests only | `test/…` |

So a branch `fix/attendance-persist` carries commits like `fix: persist admin attendance check-ins` and opens a PR titled the same way.

**Commit subjects are one line.** Prefix, then an imperative phrase in English. No body, no `Co-Authored-By`, no `Claude-Session` trailer, no attribution to any AI tool.

```
fix: persist admin attendance check-ins        ← good
docs: add CLAUDE.md with architecture map      ← good
Fixed the attendance thing (+ 12 line body)    ← no prefix, past tense, has a body
```

**Headings are English; prose is Korean.** That split applies to PR bodies, README, guides, and ADRs alike — every title, section heading, and subheading in English (Summary / Purpose / Changes / Verification / References), with the text under them written in Korean. PR titles are English too.

Fill in every section of `.github/PULL_REQUEST_TEMPLATE.md`; write "해당 없음" rather than deleting a section. Code identifiers, commit subjects, and inline code comments stay in English.

**`/humanize-korean` strips translationese from Korean prose. Match the effort to the text:**

| Text | Call |
|---|---|
| README, guides, ADRs — anything substantial | Full run (`/humanize-korean`), which diagnoses then rewrites |
| PR body | One light pass right before opening the PR: `/humanize-korean 가볍게` — a final check, not a rewrite |
| Commit subjects, short replies, inline comments | Skip — too short to be worth a call |

The light pass is deliberately conservative and reports "이미 좋습니다" when the text needs nothing, so a clean PR body costs one quick call and no edits.

## Feature team

Non-trivial feature work runs through a standing team of subagents, spawned in parallel from one message. Small mechanical edits don't need it — a new screen, a schema change, or anything touching auth does.

| Role | Agent type | Owns |
|---|---|---|
| Architect | `oh-my-claudecode:architect` (opus) | stack decisions, module boundaries, where authority lives |
| PM | `oh-my-claudecode:planner` (opus) | scope, phasing, what ships in this slice |
| DBA | `everything-claude-code:database-reviewer` | schema, RLS policies, constraints, migration safety |
| UX | `oh-my-claudecode:designer` | IA, routes, component composition, states and save feedback |
| Reviewer | codex `gpt-5.6-sol` via CLI | adversarial second opinion; see `<codex_delegation>` |

Two things that cost real time when skipped:

- **A teammate's idle notification is not a report.** Their final message does not reach the lead automatically — ask for the full deliverable via `SendMessage` (bare name, no `@session` suffix) or it is lost.
- **An agent's self-report is not verification.** Demand file:line evidence and re-check the load-bearing claims yourself before acting on them.

## PR review loop

Every PR follows the same cycle, and it repeats without asking for approval between rounds:

1. Open the PR (template filled, `/humanize-korean 가볍게` on the body).
2. Self-review with codex: `gpt-5.6-sol`, `model_reasoning_effort=medium` for routine diffs, `high` when the diff touches auth, RLS, migrations, or money.
3. Post the verdict as a PR comment — findings and their severity, in Korean.
4. Fix every critical and high finding, push to the same branch, and note the fix in the thread.
5. Merge into `dev` only when **all three** hold: CI is green, no critical or high finding is left open, and anything the change claims to do has actually been exercised (a migration applied and queried back, a screen loaded, a test run). Mediums and lows may ship with a note saying why they were deferred.

A review finding is not fixed because the diff changed — it is fixed when the fix is verified the same way the defect was found. Grants were the lesson: `revoke ... from public` looked correct and left `anon` holding EXECUTE until the live ACL was queried.

Reviews are cheap here because the diffs are small; keep them small so this stays true.

## Environments

`.env` is git-ignored and must stay that way — this repo is public. `.env.example` documents the shape.

We have our own Supabase project for **dev**; its ref and connection details live in `.env`, not here. The club president's separate project is production — we have no access to it and must never point a preview build at it. The legacy `index.html` still hardcodes his publishable key, so any deploy built from this repo without swapping keys writes to real member data. `.github/workflows/guard.yml` enforces that his project ref appears nowhere except that one frozen file.

Connection notes, verified 2026-08-24: free-tier direct connections (`db.<ref>.supabase.co`) are IPv6-only and unreachable from this host — use the session pooler (`aws-0-<region>.pooler.supabase.com:5432`, user `postgres.<ref>`). Our dev project is in Singapore rather than Seoul, so expect ~70-80ms more round-trip than a Seoul project would give.

## Scope rule

**A feature that exists in `index.html` is a requirement, not a candidate for removal.** The president built every one of them deliberately; its presence in the code *is* the spec. Never propose dropping a feature to save rebuild effort, and never treat "probably nobody uses this" as a reason — usage lives in the production database, which we cannot read, so that claim is unverifiable by us.

A broken feature (notice comments losing data, attendance not persisting) is a **bug to fix**, not a reason to delete the feature.

What can be decided on technical grounds is *sequencing* — e.g. rebuild chat last, because its `chat-api` server logic isn't readable from this repo and guessing at it first would be wasteful. Cost estimates are information to hand the president; scope decisions are his.

## Known production defects

All verified in source. Do not quietly "fix" them as a side effect of other work — several are user-visible data loss and need to be reported to the president deliberately.

**Locations are withheld for the two that are exploitable**, and stay withheld. This repo is public and these defects sit in someone else's running app holding real member data; naming the file, line, and the input that reaches them would publish a working recipe against people who never agreed to that. The data-loss entries keep their references because they harm the owner rather than arm an attacker. If you need an exploitable one's location to do the work, find it in the source — don't write it back into this file.

| Defect | Where | Note |
|---|---|---|
| Admin attendance check-in never persisted | `setAtt`/`togglePaid` `index.html:3780-3781`, state in `attRecords` `:1178` | No DB call anywhere in the path, and no attendance table exists. Lost on every refresh. |
| Notice comments overwrite each other | `addComment()` `:2001` | Whole jsonb array replaced from a stale client copy, so concurrent comments silently destroy one another. Author is stored as a nickname string, not `member_id`. |
| Training capacity race | `applyTraining()` `:2384` | Browser decides seat-vs-waitlist and computes `wait_order` from a cached count, then sends it. Simultaneous applicants overbook or collide on order. |
| Attribute-context XSS in an admin render path | *(location withheld)* | A member-controlled value reaches a script context unescaped. A near-identical render a few lines away escapes correctly, so this is an omission rather than a policy. |
| Most admin routes have no router guard | `showPage()` `:1629-1648` | Only two of the admin screens check a role; the rest rely on drawer link visibility (`applyRole()` `:1813`), which is presentation, not access control. |
| Waitlist offer expiry may never advance | `:1330`, `:2399`, `:2410` | UI promises "자동으로 다음 대기자에게 기회가 넘어갑니다" but the client only *filters out* expired offers; nothing promotes the next person. Whether a server-side job exists is UNVERIFIED. |
| `activities.details.participants/waitlist/offer` is dead data | written `:3590`, read `:1206`, overwritten `:1312` | `loadPersistentContent` rebuilds participants from `activity_applications` on every load, so the jsonb copy is write-only. Two sources of truth; the table is the real one. |

**Not verifiable from this repo** (needs the president's Supabase dashboard): whether RLS actually enforces anything, the source of all 14 RPCs and the 3 Edge Functions, and whether `member_history_v4` returns real per-event attendance or merely synthesizes from the `members.historical_*` counters. Treat every claim about server-side enforcement as an assumption until checked — and do not probe production authorization to find out, since that system isn't ours.

## External integrations

`myranking.co.kr` (Korean swim ranking site) is **off-limits to automated access**. Its `robots.txt` is `User-agent: * / Disallow: /` for everything except Google/Naver/Daum/Bing, with an operator comment stating they enforce it server-side with rate limits. Do not build a fetcher or scraper against it regardless of scale. The legitimate paths are (a) written permission from the operator, or (b) the better option anyway: meet result sheets are already public documents that the club already possesses, and myranking is itself just an OCR aggregator of them — so the automation win is the *parser*, not a fetch. `whoisfast.com` has a permissive robots.txt but masks athlete names by one character, so it cannot supply the 실명 the record matcher keys on. `data.go.kr` publishes no swim-record dataset.

<codex_delegation>
Global `~/.claude/CLAUDE.md` already carries the full ruleset — do not duplicate it here. Project-specific only:

- Verified on this machine 2026-08-24: `codex-cli 0.147.0`, model `gpt-5.6-sol`.
- Background sessions on this repo are forced into a git worktree, where a `codex exec "$(cat prompt.md)"` written inline is refused ("too complex to verify"). Put the invocation in a wrapper `.sh` and run it as one plain command instead.
- Canonical call (the `-o` artifact is the source of truth, never stdout):
  `codex exec -m gpt-5.6-sol -c model_reasoning_effort="high" --json -o /path/verdict.txt "$PROMPT"`
- 2026-08-24, this repo: the `codex:rescue` skill returned a contentless `"Complete."` twice in a row despite 51 real `tool_uses` and 10+ min runtime; a `SendMessage` resume produced the same. A *completed* status with an empty result means the delivery channel failed, not that the work is absent. One retry, then drop the codex track and verify load-bearing facts directly.
</codex_delegation>

### HTML rendering convention

Dynamic HTML is built as template literals assigned to `.innerHTML`, escaped through `escHtml()`/`escAttr()` helpers (`index.html:1649` / `1657`; note `escAttr` is redefined a second time at `1975` — same behavior, just duplicated). When adding new `innerHTML` output, escape any value that ultimately comes from user/DB input the same way. Some existing call sites skip escaping (e.g. the home-page "next up" card at `index.html:1971` and notice title/body in `renderNoticeDetail`/`renderHome` around `1962-1965`) — don't copy those as a pattern.
