# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TEAM EYSL — a Korean swimming club's member/training-management PWA ("TEAM EYSL Operating Auth", per the `<title>`). The entire application is a single static HTML file with no build step, framework, or backend code in this repo; it talks directly to a Supabase project for data, auth, and server logic.

## Repository reality check

- `index.html` (~3,850 lines) **is** the app: markup, all CSS (one `<style>` block), and all JS (five `<script>` blocks, ~270 flat global functions) in one file.
- `sw.js` — service worker (network-first fetch, web push handling).
- `manifest.webmanifest`, `icon-*.png` — PWA manifest/icons.
- There is no `package.json`, no bundler, no framework, no test suite, no linter, and no CI. Every commit in `git log` is "Add files via upload" — this repo has historically been maintained by uploading edited files through the GitHub web UI, not from a local git workflow. Expect the code itself to read as iteratively patched rather than designed (functions redefined later in the file to wrap earlier ones, at least one dead stub function, `escAttr` defined twice) — that's the normal state of this file, not a regression you introduced.

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

<codex_delegation>
Global `~/.claude/CLAUDE.md` already carries the full ruleset — do not duplicate it here. Project-specific only:

- Verified on this machine 2026-08-24: `codex-cli 0.147.0`, model `gpt-5.6-sol`.
- Sessions on this repo run inside a git worktree. A `codex exec "$(cat prompt.md)"` written inline is refused by worktree isolation ("too complex to verify"). Put the invocation in a wrapper `.sh` and run it as one plain command instead.
- Canonical call (the `-o` artifact is the source of truth, never stdout):
  `codex exec -m gpt-5.6-sol -c model_reasoning_effort="high" --json -o /path/verdict.txt "$PROMPT"`
- 2026-08-24, this repo: the `codex:rescue` skill returned a contentless `"Complete."` twice in a row despite 51 real `tool_uses` and 10+ min runtime; a `SendMessage` resume produced the same. A *completed* status with an empty result means the delivery channel failed, not that the work is absent. One retry, then drop the codex track and verify load-bearing facts directly.
</codex_delegation>

### HTML rendering convention

Dynamic HTML is built as template literals assigned to `.innerHTML`, escaped through `escHtml()`/`escAttr()` helpers (`index.html:1649` / `1657`; note `escAttr` is redefined a second time at `1975` — same behavior, just duplicated). When adding new `innerHTML` output, escape any value that ultimately comes from user/DB input the same way. Some existing call sites skip escaping (e.g. the home-page "next up" card at `index.html:1971` and notice title/body in `renderNoticeDetail`/`renderHome` around `1962-1965`) — don't copy those as a pattern.
