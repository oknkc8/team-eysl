# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TEAM EYSL — a Korean swimming club's member/training-management PWA ("TEAM EYSL Operating Auth", per the `<title>`). The entire application is a single static HTML file with no build step, framework, or backend code in this repo; it talks directly to a Supabase project for data, auth, and server logic.

## Repository reality check

- `index.html` (~3,850 lines) **is** the app: markup, all CSS (one `<style>` block), and all JS (five `<script>` blocks, ~270 flat global functions) in one file.
- `sw.js` — service worker (network-first fetch, web push handling).
- `manifest.webmanifest`, `icon-*.png` — PWA manifest/icons.
- The legacy app has no build step of its own: no bundler, no framework, no tests. Most of `upstream`'s history is "Add files via upload" — **79 of 130 commits, measured 2026-08-31** — because the president maintains it by uploading edited files through the GitHub web UI. **He stopped doing that on 2026-08-26.** Every commit since 08-27 carries a real subject, 41 in a row, and 29 of them landed on 08-30 alone. Two commits are not his at all: `0149d73` and `bd3a7b4` are authored by **`team-eysl-bot`**, a GitHub Action he set up to patch the app shell directly. So "who wrote this" is now a question with two possible answers. Expect the code to read as iteratively patched rather than designed (functions redefined later in the file to wrap earlier ones, at least one dead stub function, `escAttr` defined twice) — that's the normal state of this file, not a regression you introduced.
- The **rewrite** lives in `app/` and does have tooling: `app/package.json` (Vite, TypeScript, Vitest), SQL migrations under `app/supabase/migrations/`, and CI in `.github/workflows/`. Commands run from `app/`; the legacy root stays frozen because it is what production still serves.
- **There is no linter.** `app/package.json` has no eslint dependency and no `lint` script — `npx eslint` silently resolves to an unrelated global v6.4.0 and fails on the config. The only gates that exist are `./node_modules/.bin/tsc --noEmit` (which reads `src` only), `./node_modules/.bin/tsc -p tsconfig.functions.json` (which reads `supabase/functions`), and `./node_modules/.bin/vitest run`. Do not claim a lint pass; three separate agents reported running one before this was checked.

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

The president edits `upstream` mostly by uploading files through the GitHub web UI (79 of 130 commits; the reality check above says when and how that changed), so `upstream/main` can move without warning and without a merge-friendly history. Pull from it; don't expect to rebase onto it cleanly.

**He is still actively building.** 13 commits landed between 2026-08-24 17:11 and 2026-08-25 12:30 alone, adding ~410 lines. Assume upstream has moved since you last looked, and re-check before assuming a feature is missing from his app rather than merely missing from the copy you read.

**`sw.js`'s `VERSION` string is the changelog his commit messages aren't.** He renames it to describe what he just shipped, so the sequence reads as release notes:

```
final50-filters-permissions-events   ← the member-created-활동 permission change
final52-event-pages
final56-verified-history-records
final58-push-reliable
final59-event-top5-yoy
```

Walking `git show <sha>:sw.js | grep VERSION` across `origin/main..upstream/main` is the cheapest way to see what a batch of uploads was actually about — far faster than reading a whole-file diff, and it names his intent rather than yours.

**But the walk tells you only what he meant to do — it is no evidence at all that the file ran.** Verified 2026-08-26: `sw.js` **failed to parse for 29 consecutive releases**, `final47` through `final83`. One character on line 3 — `e.waitUntil(` is closed and `self.addEventListener(` never is.

```
a2afc67  final78-swimming-team-board   node --check -> SyntaxError: missing ) after argument list
265e14d  final85-push-true-reset       node --check -> ok   (first version that parses)
```

A service worker that throws SyntaxError never installs, so for all 31 there was no `pushManager`, no `push` event and no cache. The VERSION string kept getting a new name throughout. The releases he named `push-repair`, `push-autofix` and `push-clean-start` were **fixing push inside a file the browser refused to read.**

So put one step between the walk and any conclusion drawn from it. Do not settle whether something parses by counting brackets by eye — ask `node --check`. A question about a parser is answerable by a parser and by nothing else, and running the real one sweeps every commit in the range for free.

**And the name can be wrong about the contents, not merely about whether they
ran.** `final69-events-gender-first2026` sounds like the gender-split stroke
ranking. It does not contain one: no `stroke_rankings`, no gender split, only an
`openFunEventPage` that predates the feature. The ranking enters at
`final71-event-data-rpc` and reaches its current shape at `final75-medal-rank`.

So **before porting a release by name, grep the release for the thing the name
promises.** One loop settles it:

```bash
for c in $(git log --format=%h --reverse origin/main..upstream/main); do
  printf '%s %s\n' "$c" "$(git show "$c:index.html" | grep -c '<the identifier>')"
done
```

Two traps in reading his diffs. A whole-file re-upload makes reformatting look like change, so separate real behaviour from churn before concluding anything. And an upload can be **truncated**: `3d1be2b` cut `index.html` to 246 lines and `954d9a7` restored it two minutes later, so a per-commit diff across that pair shows enormous phantom changes. Diff cumulatively (`origin/main..upstream/main`) unless you specifically need one commit.

## Workflow rules

**Never commit straight to `dev` or `main`.** Every feature or fix branches off `dev`, gets a PR, and merges back into `dev`.

**Always branch off `dev`, never off another branch that is still in flight.** This is not style. **Every PR here is squash-merged**, so when the branch you forked from lands, its file arrives on `dev` as a *brand-new blob with no ancestry in common with your copy.* Git then sees one path created independently twice and raises an **add/add conflict** on a file neither of you may have meaningfully changed. That is what happened to `chore/ci-migration-numbers`, and it cost more time on 2026-08-26 than any other single thing.

**Three things about that conflict, because the obvious reading of it is wrong in a dangerous direction.**

**A two-dot diff measures staleness, not danger.** `git diff origin/dev..<branch>` compares tips, so it reports everything that landed on `dev` since you forked as *deletions* — even though a merge would never delete them. `CLAUDE.md | 14 --------------` looked like a PR about to revert someone's work; it was not. Reproduced with `git merge-tree --write-tree`, the merged `CLAUDE.md` came out **byte-identical** to `dev`'s. A three-way merge does not drop lines present on one side only. The two-dot diff fires on every branch that is behind, so as an alarm it is **all false positives** — read it as "this branch lacks things `dev` has", which is a reason to look, not a verdict.

**The danger is in the resolution, not in the diff.** An add/add conflict offers whole files, not hunks. Taking "ours" is where work disappears — and it disappears **silently, having never appeared in the diff anyone reviewed**. So the fix is not a better conflict resolution; it is not having the conflict:

```bash
git switch -c fix/<thing> origin/dev
git checkout origin/<stale-branch> -- <the one path you want>
```

The resulting file list *is* the proof. If it names one path, nothing else can have moved.

**And do not infer one artifact's behaviour from a different artifact's output.** The two-dot `--stat` and the merge result are two different products of the same two commits, and reading the first to predict the second produced a confident, wrong, team-wide rule. When the question is "what will the merge do", the answer comes from `git merge-tree`, which performs the merge.

**`main` is our release line** (changed 2026-08-25; it previously mirrored the president's upstream). `dev` merges into it through a `chore/release-vX.Y.Z` PR, and the merge commit gets a matching `vX.Y.Z` tag. Nothing else lands on `main`.

Mirroring upstream on a local branch turned out to buy nothing: `git fetch upstream` gives `upstream/main` as a remote-tracking ref, and every comparison we actually run — `git diff origin/main..upstream/main`, `git show upstream/main:index.html` — works off that ref directly. So `main` was free to become what it is normally for.

Versioning is semver, and the version lives in `app/package.json`. Below 1.0 while the rebuild has gaps a user would notice: dues is deferred, no production Supabase project exists, and push registers but cannot send. A tag says "this state was reviewed and verified", so **do not cut one while a critical or high review finding is open** — the tag is the claim, and an unfixed escalation makes it a false one.

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

Four things that cost real time when skipped:

- **A teammate's idle notification is not a report.** Their final message does not reach the lead automatically — ask for the full deliverable via `SendMessage` (bare name, no `@session` suffix) or it is lost.
- **An agent's self-report is not verification.** Demand file:line evidence and re-check the load-bearing claims yourself before acting on them.
- **Hand out migration numbers up front; do not let agents pick.** Checking `ls` and the ledger immediately before writing narrows the race, it does not close it — `0020` and `0024` were each claimed twice on 2026-08-25, the second collision forty-eight seconds apart, by parties who had both just checked. Resolving it afterwards means renaming a file, deleting a ledger row and re-applying, with a window where the ledger and the directory disagree. Assign `0031` to one agent and `0032` to the next in their briefs, or give only one of them the task.

  **Where you look before handing a number out is the other half of the rule.** A local `ls` is not an answer — a worktree cannot see another worktree's unmerged files. That is exactly the 2026-08-26 failure: a directory listing was read in one worktree and the number judged free. There are two places to look.

  - `public.schema_migrations` — everything already applied is here, and because the dev database is shared, every branch's work collects in it.
  - `app/supabase/migrations/` on **every remote branch** — files not yet applied but whose names somebody has already claimed. **`git fetch` first**, or the refs you are reading are as stale as the listing you were trying to avoid.
  - `git worktree list`, then that directory in each — a file written five minutes ago in a sibling worktree and not yet pushed appears in **neither** of the two places above.

  **And a duplicated number raises no error anywhere today.** `schema_migrations` is keyed on the full filename rather than the number, so `0036_a.sql` and `0036_b.sql` sit down as two perfectly ordinary rows. Nothing complains on apply, in CI, or in review — which is a gap in CI rather than a law of nature, since a duplicate numeric prefix is trivially detectable by a machine that looks once. Until that check exists, reading the filenames side by side is what finds it. The number is still the lead's to assign; these are the places to look before assigning one.
- **Never reconstruct a function body from a report.** `CREATE OR REPLACE` on an existing function is the same trap as porting the result parser: writing 0024 from a teammate's description silently dropped `p_user_agent` and changed the conflict target from `(member_id, endpoint)` to `(endpoint)` — the first would have broken the client's call, the second the device cap, and both would have applied cleanly. Read the current definition out of the migration that owns it and change only the line you came to change.

## PR review loop

Every PR follows the same cycle, and it repeats without asking for approval between rounds:

1. Open the PR (template filled, `/humanize-korean 가볍게` on the body).
2. Self-review with codex: `gpt-5.6-sol`, `model_reasoning_effort=medium` for routine diffs, `high` when the diff touches auth, RLS, migrations, or money.
3. Post the verdict as a PR comment — findings and their severity, in Korean.
4. Fix every critical and high finding, push to the same branch, and note the fix in the thread.
5. Merge into `dev` only when **all three** hold: CI is green, no critical or high finding is left open, and anything the change claims to do has actually been exercised (a migration applied and queried back, a screen loaded, a test run). Mediums and lows may ship with a note saying why they were deferred.

**One step in this loop cannot be performed at all here.** `/humanize-korean` is installed as a plugin skill (`~/.claude/plugins/cache/im-not-ai/humanize-korean/…`) and is **absent from the available-skills list**, which carries every other plugin's skills. Both the bare name and the qualified `humanize-korean:humanize-korean` answer `Unknown skill` — verified 2026-08-26 from a subagent and from the lead session alike.

So there is nobody here to hand it to. Until that changes: **do the light pass by hand** — read the Korean prose once for the constructions the skill targets, fix what is stiff, and **leave the template's checkbox unticked with the reason written in it.** Do not tick it, and do not quietly skip it. The intent of the rule stands; the tool named in it does not currently exist for us, and a checklist ticked by convention has stopped being a check.

Note the shape of how that was nearly recorded wrongly, **twice, in opposite directions**. First: three searches came back empty — `~/.claude/skills`, `~/.claude/commands`, the project `.claude` — and the conclusion drawn was *"not installed on this machine"* when the honest claim was much narrower, *not in the three directories checked, under the name tried.* A plugin skill lives in none of those three. Then, correcting that, the lead asserted the pass was **the lead's to run** — without trying it, and it fails there too. Both errors are the same move: a claim about the world inferred from a claim about one's own search. The rule two sections above catches both, in two halves — a check that finds nothing must first prove it was capable of finding something, and **an assertion that somebody else can do a thing is worth exactly as much as a check that they can.**

A review finding is not fixed because the diff changed — it is fixed when the fix is verified the same way the defect was found. Grants were the lesson: `revoke ... from public` looked correct and left `anon` holding EXECUTE until the live ACL was queried.

**A revoke goes wrong in both directions, and the second one is the quiet one.**

```
0014   revoke ... from public          left anon holding EXECUTE      <- kept what it should not
0043   revoke ... from authenticated   took EXECUTE something needed  <- removed what it must not
```

`0043` widened three storage helpers and revoked `public, anon, authenticated` from each with no matching grant, reasoning that they are called by storage policies and by each other, never by a browser. The second half is true and **the conclusion does not follow: an RLS policy expression is evaluated as the CALLING role.** When a member uploads a file it is `authenticated` that executes `is_my_media_object_path()` inside `team_files_insert`'s WITH CHECK. `SECURITY DEFINER` decides whose privileges the *body* runs with; it does not excuse the caller from needing EXECUTE.

So the revoke broke **every upload in the app** — media, 자료실 and notice attachments, not merely the new library — with `permission denied for function is_my_media_object_path`. **The migration applied cleanly and nothing failed until the next upload.**

**Neither the migration text nor the diff showed it.** Both read as correct, because "revoke then grant to authenticated" is the right idiom for an RPC the browser calls and these did not look like that. What found it was the live ACL with the changed functions set beside their unchanged siblings:

```
is_my_avatar_object_path     postgres=X | service_role=X | authenticated=X
is_my_team_file_path         postgres=X | service_role=X | authenticated=X
team_file_is_readable        postgres=X | service_role=X | authenticated=X
is_my_media_object_path      postgres=X | service_role=X                     <- changed
media_object_is_claimed      postgres=X | service_role=X                     <- changed
team_file_library_allows_me  postgres=X | service_role=X                     <- changed
```

**You do not have to know the correct ACL to see that only three differ.** That is the general move and it costs one query: after changing an object, list it next to the objects you did not change and look for the column that stopped matching.

Three later cases sharpened the same rule, each one a thing that reading the code could not have caught:

**A green status line can mean "nothing happened".** A first attempt at the offer sweep called `COMMIT` inside a procedure driven by `pg_cron`. That is illegal — pg_cron wraps each job in an explicit transaction — but a tick with no expired offers returns before reaching the COMMIT and logs `succeeded | CALL`. Two green runs in `cron.job_run_details` meant only that there had been no work:

```
05:30  succeeded | CALL                                  <- no work; proves nothing
05:35  succeeded | CALL                                  <- no work; proves nothing
05:40  failed | invalid transaction termination … COMMIT <- real work arrived
05:50  succeeded | 1 row                                 <- after the fix
```

It was found by planting stale offers and waiting for a real scheduled tick. **A scheduled job is only verified by a run that had something to do.**

**A view's grants are the whole gate.** `authenticated=arwdDxtm` on a table is unremarkable — RLS is what refuses. The identical string on a view means the opposite, because there is no RLS behind it: `member_public_v` was auto-updatable, DEFINER-mode, exposed `role`, and let any approved member PATCH themselves to `master_admin` (closed in `0019`). Three grant audits printed that string and read it as ordinary. When auditing, **split views from tables and read them under different rules.**

**`npx tsc --noEmit` does not report the truth on this machine.** A wrapper rewrites its output to "TypeScript compilation completed" and swallows real errors; twelve of them sat behind that for hours while `npm run build` was failing. Run `./node_modules/.bin/tsc --noEmit` and check the exit code. The same caution applies to any tool whose output looks suspiciously tidy.

**A staff session reads more rows than a member's, and `.single()` turns that into a lockout.** `getMyMember()` selected from `members` with no filter and `.maybeSingle()`. `members_read` is `auth_user_id = auth.uid() OR is_staff()`, so a member got one row and an admin got the whole roster — PostgREST answered `PGRST116, "Cannot coerce the result to a single JSON object"`, react-query parked it in `query.error` that nothing read, and `RequireAuth` sat on its spinner forever. **The console was completely clean.** Every admin, including the president, was locked out of the entire app.

Reproducing it needs a staff session **and** two or more members at once, which is why 381 unit tests never saw it and why it took a browser. Two rules fall out. Any query whose result count depends on the caller's role must filter by identity explicitly — `.eq('auth_user_id', …)`, not "the policy will handle it"; `schedule/api.ts` already said this in a comment and `auth/api.ts` was the one place that forgot. And **a swallowed query error looks exactly like a slow network**: if a screen can render a spinner forever, something is discarding an error.

**`grep` under-reports in this environment, and a false "no matches" reads exactly like a clean result.** A wrapper reformats grep output here, and it drops hits: `grep -l "default privileges" app/supabase/migrations/*.sql` returned 11 files where a Python scan of the same glob found 12. Another agent hit a worse case the same day — 0 matches against files that contained 19.

This is the most dangerous tool failure on the list, because every other one announces itself. An absent match is indistinguishable from an absence, and "I grepped and found nothing" has been offered as evidence throughout this project. **Cross-check any load-bearing negative with a second tool** — Python, `rg` directly, or reading the file — before writing "there is no X".

**The same wrapper rewrites `git` and `gh`, and it invents plausible answers rather than failing.** Verified 2026-08-26: `git status --short` printed the single word `ok` in a clean tree, and `gh pr list --state open --json …` printed `[]` while PR #8 was open — `gh pr list --state all` printed `[]` too, so even "there have never been any PRs" was on offer. The GitHub API returned the PR immediately.

`[]` is worse than `ok`, because `ok` is obviously not git's output and an empty JSON array is exactly what the real command prints when there is nothing to list. The failure mode is identical to grep's and reaches further: **any workflow decision made from a listing** — no open PRs so nothing to review, no matches so the feature is missing, clean tree so nothing to commit. Prefix with `rtk proxy` to get the real output, or ask the GitHub API directly. Never let a wrapper's empty listing be the reason you skipped a step.

**`gh pr create` invents a reason rather than failing.** Two measurements on 2026-08-26. It answered `No commits between dev and <branch>` for a branch that was genuinely one commit ahead — `gh api repos/oknkc8/team-eysl/compare/dev...<branch>` returned `{"status":"ahead","ahead_by":1}` at the same moment. And it answered `Head sha can't be blank, Base sha can't be blank, … Head ref must be a branch` for two refs that both existed on the remote.

That is the dangerous half: not a failure but a plausible wrong answer. "No commits between" reads as *you forgot to commit*, and sends you to re-push a branch that was never the problem.

So when PR creation claims there are no commits or no refs, **check with `gh api repos/<owner>/<repo>/compare/<base>...<head>` before believing it.** Two things get past it: adding `--repo oknkc8/team-eysl` explicitly, which is the cheaper thing to try first, and POSTing to `gh api repos/<owner>/<repo>/pulls` directly, which created PR #18 immediately after `pr create` had refused.

**A check that finds nothing and then declares a pass is worse than no check.** The two entries above are instances of one failure, and this repository met it in six shapes on 2026-08-26 alone.

- `grep` returned 11 of 12. In another case it returned 0 against files containing 19.
- `gh pr list` printed `[]` for an open PR. `--state all` printed `[]` too.
- `git show` piped into `sha256sum` produced `e3b0c442…` — **the hash of the empty string.** Nothing was compared; the file was never read.
- A failed `cd` left a 0-byte file behind, and scanning that file read as "there are no Edge Functions".
- A schema extractor matched a stub earlier in the file, printed `Tables: 0`, and then announced `UNION PRESERVED`.
- A conflict-marker scan reported three `-- =========` comment banners as conflicts. That is the same failure running backwards — a check that finds what is not there burns an hour and can talk somebody into "resolving" a healthy file.

What they share is that **the result is indistinguishable from "there was nothing to find"**. So the rule is one line: when a check returns zero, **first establish that the check was capable of finding something.** That the input was not empty, that the pattern hits a known positive, that the tool actually ran.

The general form, of which the hash is the memorable instance: **anything that must not be empty gets its size or row count checked before its content is trusted.** `wc -c` on the file, `len()` on the list, a `count(*)` on the query, an `assert` on the extracted block. A comparison of two empty things succeeds.

`e3b0c442…` is worth memorising because it is that failure wearing a disguise — the sha256 of the empty string, produced when `git show` writes its error to stderr and `sha256sum` hashes nothing. It is a well-formed 64-character hash and it means "nothing was read". **Treat it as an automatic failure in any verification pipeline.**

**That rule has a false-positive mode, and it is the mirror image of the hash.** `wc -c < file` returned **0** for a 49,714-byte file — but only when chained into the same call, behind the wrapped redirect that had just written it. `sha256sum` in that same call returned the correct hash, and run separately, python, `os.stat`, `ls -l` and `wc -c` all agreed on 49,714. The wrapper's redirect finishes asynchronously, so a size check chained behind it reads the file too early.

The direction is the whole point. `e3b0c442…` is an empty result that means a real problem; this is an **empty result that means nothing is wrong** — so the rule above, applied literally, condemns a healthy file and sends somebody hunting a defect that does not exist.

The rule stands, with one condition attached: **do not chain a size check into the same call as a wrapped redirect that produced the file.** Check it in a separate call. What made this diagnosable was `sha256sum` being right in the same breath that `wc -c` was wrong — one tool reading early, not a file that was empty. Two tools side by side found it; either one alone would have concluded the file was empty.

**Count what your cause explains against what you observed.** On 2026-08-26 a signup rate limit was found to be real — a 417ms refusal carrying an error code, a retry timer and a Korean sentence — and was then offered as the explanation for about forty failing e2e tests. It explained nine. Seeding never calls `register_member`, and exactly one spec touches the signup RPC, so thirty seconds of reading would have settled it. The reading did not happen because the artefact was so specific that it felt like proof of more than it proved.

**That is this section's failure running in the opposite direction.** Everywhere above, the danger is an **empty** result that looks like an absence. Here it is a **very specific** result that looks wider than it is. Both end an investigation early, and the arithmetic is the cheap guard against the second one: nine against forty fails on sight.

**And a workaround deserves the same scepticism as the code it works around.** In that same episode the neighbour's preview server was verified to be real, the port genuinely taken, and `reuseExistingServer` genuinely capable of returning a green run against somebody else's bundle — every claim about the problem checked. Then a two-line override was trusted without checking whether it reached everything, and it did not: it moved the first browser and left every second browser on the old port, because the fixtures import the base URL as a **constant** rather than reading the resolved config. **Every claim about the problem was checked and no claim about the fix was**, and that asymmetry is the whole of it.

**And even the real compiler never looks at `app/supabase/functions/`.** `app/tsconfig.json` has `"include": ["src", "vite.config.ts"]`, so the Edge Function source is outside every gate this repo has: tsc does not read it, and vitest transpiles the tests beside it without typechecking. A type error in `push-notify/index.ts` would be caught by nothing and would first surface as a failed deploy or a runtime error in production.

That makes "typecheck passes" narrower than it sounds, and it is the kind of claim that gets repeated because it was true about the part somebody happened to be looking at. **Say which tree you checked, not just that the check was green.**

`npm run typecheck:functions` (`app/tsconfig.functions.json`) now covers that second tree, and it is worth knowing exactly how far it reaches. It catches everything about **our** code — wrong property names, wrong argument counts, a value of the wrong type moving between `index.ts`, `send.ts`, `payload.ts` and `endpoint.ts`. It does **not** catch us being wrong about Deno or about `web-push`: neither is installed here, so both are hand-declared in `supabase/functions/_shims/`, and a wrong declaration is a check that agrees with the mistake. `supabase-js` is the exception — it maps to the real installed package, so those types are genuine. Deno is not installed, so `deno check` remains the thing this stands in for rather than replaces, and the function's runtime behaviour still rests on the Docker edge-runtime harness under `tmp/pushverify/`, which is a test, not a typecheck.

**Both typecheck commands have to be run; neither implies the other.** `npm run typecheck` reads `src`, `npm run typecheck:functions` reads `supabase/functions`, and a green one says nothing about the other tree.

**`member_link_summary_v1` is left out of `src/types/database.ts` on purpose, and `npm run db:types` silently puts it back.** It is granted EXECUTE to **no client role** — the live ACL on 2026-08-26 is `{postgres=X/postgres,service_role=X/postgres}`, with no `authenticated` and no `anon`. The browser therefore cannot call it, and keeping it out of the types means calling it by mistake **breaks the compile instead of throwing at runtime in front of a 총관리자.**

`db:types` overwrites the whole file, so that decision leaves no trace inside it: after regenerating, check whether this function came back and take it out again.

**This is one deliberate exception, not a policy.** Do not generalise it into "strip every ungranted function" — `gen-types.sh` is supposed to describe the whole schema, and a rule that quietly narrows it would make the generated file lie about the database. If another function ever earns the same treatment, it earns its own line here.

**The worktree anchor moves to a different worktree mid-session.** Seen twice on 2026-08-26. Once, `git add … && git commit` ran in **`feat/admin-claim`** instead of `fix/media-delete-orphans`; the other time, `claim2`'s `git mv` succeeded in `admin-claim` and the very next `git commit` ran in **`fix/media-delete-orphans`**. **Neither committed anything, and that is purely because the other tree happened to be clean.** Had it been dirty, somebody else's work would have gone in under our commit message.

It takes two forms, and they need different detection.

- **Split** — git and the shell point at different places. A relative `git add` then fails with a `pathspec` error, so it is comparatively visible.
- **Whole-session move** — `pwd` and `git rev-parse` **agree with each other and both point somewhere wrong.** A check that compares the two will never catch this one.

**Checking beforehand cannot prevent it.** The move can happen between the check and the command, so two separate calls guarantee nothing about each other. The branch has to be proven **inside the very shell that does the work.**

```bash
git branch --show-current | grep -qx <branch> && git <cmd>
```

This form is the one to use because it **refuses** when it is wrong. `git rev-parse --abbrev-ref HEAD && git <cmd>` only prints the branch and then runs anyway, so it is caught only if a person reads the output.

**A guard that reports has to be read by somebody; a guard that short-circuits cannot be misread.** That distinction matters more than the command itself — whenever building a new check, decide what happens on failure first, then pick the form.

The guard fired for real while this paragraph was being written, stopping a commit from landing in `feat/admin-claim`. Separately, the worktree directory itself came back on another agent's branch; what saved the work then was not the guard but **committing and pushing after every edit**. The guard protects where a commit lands, not whether the checkout is still yours.

**But git itself is not lying — and an earlier version of this section said it was.** The claim that `git status` and `git log` report the wrong branch was investigated and disproved. `claim2` followed the `.git` pointer in 14 worktrees to read each `HEAD` file directly, then ran `branch --show-current`, `rev-parse --abbrev-ref HEAD` and `status --short --branch` in every one of them, bare and substituted: **70 readings, zero disagreements**, the multi-line `status` included. Every reading that looked wrong was true about a different directory.

**Each git command is honest about wherever it is standing at that instant. The anchor is what moves.** Three sightings on 2026-08-26, each with somebody's work in reach:

- The lead believed it was in `free-board` and was standing in `chore/e2e-parallel-isolation` — another agent's tree, holding 161 uncommitted lines. A `CLAUDE.md` edit sat beside them for five minutes.
- `claim2`'s shell was anchored in `enrol`, also not its own, **holding one unpushed commit.** Nothing was lost only because there was nothing to commit.
- `badges2` drifted through six trees in one session — `strokes`, `free-board`, `admin-claim`, `cinum`, `porting`, `enrol` — and one `git add` of three paths ran in the wrong one. Harmless only because those paths were unmodified there.

**In all three, what prevented harm was the state of the tree that was landed in, not any defence.** The lead's edit sat beside 161 uncommitted lines and happened not to disturb them; `claim2`'s tree held an unpushed commit and there happened to be nothing to add; `badges2`'s three paths happened to be unmodified where the `git add` really ran. No tool refused anything in any of the three.

**So do not read "nothing happened" as evidence that something protected you.** It usually means the tree you drifted into was quiet at that moment, which is a fact about somebody else's working state and not a property of your setup. The same drift onto a dirty tree writes another agent's uncommitted work into your commit.

Keeping the disproved version would have been worse than writing nothing. It teaches people to distrust `git status`, and **the accident still happens to someone who distrusts it**: `status` honestly reports a stranger's branch, and the reader has no way to tell the branch is a stranger's.

**What the guard does not cover.** It compares against a branch name, so it protects a **change**. It cannot protect a path that **reads** while the anchor is wrong and then decides from what it read. That is the path that caught the lead, who was reading and editing rather than committing, so the guard had nowhere to fire.

**`git -C <absolute path>` is not the escape hatch it looks like.** It is available in some sessions and refused in others, and where it is refused the refusal *follows* the drift rather than correcting it. Measured by `badges2` while the anchor was wrong:

| command | result |
|---|---|
| `pwd` | `…/worktrees/free-board` — drifted; the assigned tree was `badges-medals` |
| `git -C …/badges-medals rev-parse` | **refused**: "must target its own worktree" |
| `git -C …/free-board rev-parse` | allowed → `chore/e2e-parallel-isolation` |

The guard's notion of "its own worktree" **is** the drifting anchor, so `-C` was permitted only toward where the drift had already gone and refused toward the real tree. Where `-C` is available, prefer it: it looks at the right place rather than merely refusing the wrong one. Where it is refused, use `EnterWorktree` and then confirm the move happened with `pwd` + `branch` + `HEAD`, not with the tool's success line.

**And `board2` narrowed exactly when `-C` works, which turns out to be the unhelpful half.** It succeeds when the anchor is sound and you are reading *another* tree. It is refused when you have drifted and are trying to reach **your own** tree — because at that moment your own tree is the "shared checkout" as far as the harness is concerned. **So it is missing precisely when it is needed, and present only when it was not.**

**The recovery that does work is `EnterWorktree`, then the work.** `board2` recovered that way four times in a single turn, and `claim2` did the same and confirmed the move with `pwd` + `branch` + `HEAD` rather than the tool's success line. Treat `-C` as a convenience for reading somebody else's tree from a healthy session, not as a remedy for drift.

**And settle a branch switch by SHA, never by its success message.** `git switch -C` once printed its success line while `HEAD` had not moved. That is consistent with the anchor explanation — it may well have switched a different tree — so the only claim worth writing down is the operational one: after switching, compare `git rev-parse HEAD` against the SHA you expected.

**The read path is not a hypothetical, and the reading that drifts may be your verification.** Writing this very section, `badges2` patched `CLAUDE.md` in `lead-docs-pr`, confirmed in python that all 37 lines were additions and every original line survived, and then ran `git diff --numstat origin/dev -- CLAUDE.md` to confirm it. The answer was **`0 76` — nothing added, 76 lines deleted.** The anchor had moved to `admin-claim`/`feat/notice-attachments` between the write and the check, so git honestly described *that* tree's file. Re-entering the right worktree and asking again gave `37 0`.

Two things make this the sharpest instance on the page. **`pwd` and `git rev-parse --show-toplevel` agreed with each other and were both wrong** — the whole-session move described above, which no comparison between them can catch. And the wrong answer was not merely wrong but **alarming**: "you deleted 76 lines" is exactly the reading that provokes a `checkout --` or a `reset --hard`, so believing it would have destroyed the work it was meant to protect. **Prove the location in the same call as the check** — `echo $(git branch --show-current)` beside the diff — for reads as well as for writes.

**A second way to be handed alarming false deletions: diff against a `dev` that moved.** Checking the same file an hour later, `git diff --numstat origin/dev -- CLAUDE.md` reported **17 added, 26 deleted** — and those 26 were content from a PR that had merged between the fetch and the check, which the branch simply did not carry yet. Nothing had been deleted. Asking about the branch's **own** base instead, `git diff HEAD -- CLAUDE.md`, answered `14 0`, which was the truth.

The two look identical on the terminal and share no cause: one is the anchor moving under you, the other is the base moving ahead of you. **Both are avoided by asking about your own change rather than about a moving reference** — make `git diff HEAD` the habit, and keep `origin/dev` comparisons for the question they actually answer, which is how far behind you are.

**`ps` is the worst of these, and the reason is that its lie is the answer you wanted.** `git status` printing `ok` is obviously not git's output. `gh pr list` printing `[]` at least looks odd for a repo with open PRs. But `ps | grep <anything>` returning nothing looks exactly like *"that program is not running"* — so it **confirms rather than contradicts**, and an investigation stops. Every "I checked, nothing was running" in this project's history was produced this way.

**Read `/proc` instead.** `ls -d /proc/[0-9]* | wc -l` for a count, `/proc/<pid>/comm` and `/proc/<pid>/cmdline` for what a process is. Nothing sits between those files and the truth. `rtk proxy ps` also works, but it puts a wrapper in the path and wrappers are the subject.

**And the interception depends on how the command is invoked, which is why two people measuring the same thing disagree.** Measured on 2026-08-26, same shell, seconds apart:

```
bare      ps -e | wc -l        31        <- wrong
$( )      ps -e | wc -l      1100        correct
          ls -d /proc/[0-9]* | wc -l
                             1100        ground truth

bare      wc -l < file          0        <- wrong
$( )      wc -l < file         31        correct
bare      wc -l   file         31        correct
```

**The wrapper intercepts the command as typed; it does not reach inside `$( )` command substitution.** So the same query gives two different answers depending on where you put it, and the bare form — the one you type when you are checking something quickly — is the one that lies.

That has a cheap consequence worth using: **run it bare and substituted, and if they disagree, the bare one is wrong.** It also means a verification that happens to wrap everything in `$( )` will fail to reproduce a real bug and can talk you into telling a colleague their correct finding is mistaken. That nearly happened while this paragraph was being written.

Two more from the same session. **`cat` fabricated a truncation count**: a 31-line file printed with `... (1065 lines truncated)` appended, and 31 + 1065 is 1096 against a real 1080 — **the invented number nearly reconciled the two figures being compared**, which is worse than an obvious lie because it manufactures exactly the reassurance that ends an investigation. And the standing rule about `pwtest` rows still holds — **a row count means nothing without a paired "is a runner active" check** — but `ps` cannot supply that second half, so pair it with `/proc`.

**A wrapper can also forge line numbers while reporting the content correctly.** `grep -n` placed `<codex_delegation>` at line 454, and `sed -n '445,462p'` duly printed that very block — in a file where it actually lived at **line 371 of 384**. Content right, coordinates wrong, which makes it the only member of this family that survives a spot-check: you read what was printed, recognise it, and therefore believe the number that arrived with it.

Harmless while reading; dangerous the moment you write. `sed -i '454s/…/…/'` edits a real line, the wrong one, and exits 0.

**So do not address a file by line number.** Anchor an edit on unique surrounding text — which is what the Edit tool does — and where a line number is genuinely needed, take it from the Read tool or from python rather than from a wrapped `grep -n`.

**`| tail -N` on a test summary is a false-green generator.** `vitest` prints the file tally and the test tally on adjacent lines, and `tail` keeps the wrong one:

```
$ vitest run 2>&1 | tail -4
      Tests  532 passed (532)          <- reads as a clean run

what tail dropped, one line above:
 Test Files  2 failed | 30 passed (32)
```

Every other trap in this section is a tool answering about the wrong input. This one is different and worse: **the tool answered correctly and the reader was handed the wrong half.** Nothing was broken, nothing was wrapped, and the output was true.

Grep for what you mean — `vitest run 2>&1 | grep -E "Test Files|Tests "` — and never take the last N lines of a summary whose failure line comes first.

**And the thing that actually caught it was arithmetic, not output.** 532 was lower than the 555 from before the merge, and a merge that adds a migration cannot remove tests. Had the numbers happened to line up, the run would have been reported green. So: **a count that moved the wrong way is a failure to investigate, not a curiosity.** Three separate agents arrived at that habit on 2026-08-26 — a test tally, a column count going 9 to 10, and this — which makes it the most reliable check any of us has, and it is not a check at all. It is noticing.

**A suite that needs `app/.env` passes for every developer and fails only where nobody is watching.** `vitest run` on a fresh checkout dies before its first assertion: `endpoint.rule.test.ts` imports `MAX_PUSH_DEVICES` from `src/features/push/api.ts`, that pulls in `src/lib/env.ts`, and `env.ts` zod-validates `import.meta.env` at module load and throws `Missing or invalid environment variables: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY`. What satisfies it locally is `app/.env` — git-ignored, so present on every machine that has ever been set up and absent everywhere else.

**Do not read that as being about one file.** The door is not `endpoint.rule.test.ts`; it is **any test whose import graph reaches `src/lib/env.ts`**, however indirectly. On 2026-08-26 there were two — `achievements.test.ts` joined it through the achievements feature — and the number grows with every feature that imports from `src/lib`. A reader who checks the one filename named here, on a tree where the other one is the problem, concludes this section does not apply to them.

The way to find today's set is to make the condition and look, not to grep for a name:

```
mv app/.env app/.env.off && npx vitest run; mv app/.env.off app/.env
```

The local pass is therefore not evidence about CI, and the failure direction is the awkward one: it is green for everyone who could notice and red only in the place nobody watches until a PR is already open. Reading the workflow would never have found it. It took copying the tree without `.env` and running the suite there, which is the general move — **to predict a fresh checkout, make one.**

`.github/workflows/app.yml` supplies two synthetic values scoped to the Unit tests step alone rather than to the job. Job-wide would have been shorter and would have quietly guaranteed that a step which genuinely needs real configuration passes anyway; granting the env only where the need was demonstrated keeps every other step failing honestly.

### A write that succeeds without writing anything

Everything above is a **read** that returned nothing and looked like an absence.
The write side has the same failure, and it is quieter.

```
BEGIN
INSERT 0 0     <- here
COMMIT
```

`INSERT 0 0`. The transaction succeeded, `ON_ERROR_STOP` did not fire, `COMMIT`
printed. A `cross join lateral` had selected zero members because the `pwtest%`
rows had been cleaned up in between - and **an INSERT that matches nothing is not
an error, it is an ordinary zero-row insert.**

Without reading the count back, the next step was photographing an empty screen -
and an empty screen does not look like a failure, it looks like *"there must not
be any data yet."* So: **a successful `INSERT`/`UPDATE`/`DELETE` does not mean rows
were affected, and `COMMIT` does not mean the intended thing happened.** Read it
back with `select count(*)`.

### `str.replace` fails silently in both directions

Patch scripts are how source gets edited here, because the worktree pin bounces
`Write`/`Edit` at random. One line makes them safe:

```python
n = src.count(old)
assert n == 1, 'anchor appears %d times, expected exactly 1' % n
src = src.replace(old, new)
```

**Both directions are needed and both fired within ten minutes.** Without the
assertion, an import was added on an anchor that did not exist in that file: zero
matches, the script printed success, the file was rewritten unchanged, and only
`tsc` caught it. With the assertion, a patch to `details?: unknown` followed by a
closing brace was refused because it matched **three** places in one file - it
would have silently retyped `ActivityRow` and `ApplicationRow` as a side effect of
editing `ActivityInput`.

This is the `0024` trap in a different costume. There, a function body was
reconstructed from a description and lost `p_user_agent`; here a block is replaced
from memory and lands nowhere. Both are **failing to confirm the target is the
thing you think it is.** Pair it with `assert len(src) > 0` after reading, so an
empty read cannot be written over a real file.

### A pipe replaces the exit code with the last command's

`tsc --noEmit | head` reports `head`'s status, which is `0` whether or not the
compiler found errors - and the errors scroll past looking like ordinary output.
Redirect to a file and check `$?`, or read `${PIPESTATUS[0]}`. **Any tool whose
exit code you care about must not be the left-hand side of a pipe.** Same family as
the `| tail -N` false green above: the tool answered honestly and the shell threw
the answer away.

### Some APIs answer the question next to the one you asked

Three, all met while photographing screens:

| asked | actually answered |
|---|---|
| `waitForLoadState('networkidle')` | the network went quiet - **not** that the screen finished rendering |
| `scrollIntoViewIfNeeded()` | the element's *label* was visible, so nothing was "needed"; the input stayed behind the fixed nav |
| `screenshot({fullPage: true})` | the whole document - painting `position: fixed` chrome through the middle of it |

The first one's fix generalises: our `Shimmer` sets `aria-busy="true"`, so
`expect(page.locator('[aria-busy="true"]')).toHaveCount(0)` means *rendered*, names
no screen's content, and cannot rot when a caption changes. **Prefer a wait that
asserts the state you mean over one that asserts a proxy for it.**

### Empty because the data is missing, or empty because the code is right

These need opposite responses, and telling them apart is the whole of it.

Three screens photographed empty in one sitting on 2026-08-27. **All three were
empty because our code was correct:**

- 월간 활동 요약 showed `0회 / 0%` - the fixture's attendance is anchored to March
  and July, so August is legitimately empty.
- 나의 대회 신청 내역 was blank - every seeded race falls on days 10-12 and 20-22,
  and the run was on the 27th, so `hasFinished` correctly removed 신청하기.
- The board list read as junk - `cleanup.sql` scopes by `author_id`, not a title
  prefix, so natural titles are torn down identically and the epoch suffix that made
  it look like test debris was never needed.

Seeding more data fixes none of them: **the question was wrong, not the answer.**
Compare the `INSERT 0 0` case above, which *is* missing data and *is* fixed by
seeding. Treating the second kind as the first leads to seeding harder, watching it
stay empty, and eventually suspecting code that was right all along.

And the assertion that let all three through was the same one:
`expect(h1).toBeVisible()` is **true of an empty screen**. An assertion that cannot
fail on the emptiness you are guarding against is not guarding against it.

### Words on a screen are not code, so no gate is aiming at them

Two people hit this independently. It is a different family from everything above -
not *"a check that cannot find it"* but **"no check is looking at this layer."**

- A record-upload screen said 「파일은 이 기기 안에서만 읽습니다. **서버로 올라가지
  않으며**...」. It was true when written. **A PR made it false** - the same PR whose
  author had that file open.
- A notice-attachment failure said 「목록에서 제거하고 다시 올려주세요」. A retry fix
  made that false too: failed files now re-upload on save. It survived three review
  passes.

```
typecheck   passes - it is a string
tests       pass   - nothing asserts the sentence
review      passes - reviewers check that the code is right, not that the code
                     agrees with the Korean beside it
git diff    silent - the line was never touched, so it never appears
```

**The dangerous case is not somebody else's stale copy. It is your own change making
a sentence false that you did not edit** - precisely what a diff cannot show, because
a diff shows what changed and this is a thing that *should* have changed and did not.

So when you change behaviour, **search for sentences that describe that behaviour**
instead of trusting the diff. One of the two was found by accident; the other was
found because a screenshot had to be taken - which is a reason to keep the screenshot
step even where nobody asked for a picture.

### A gate that never touched the code path at all

`safeObjectName` left Korean in storage object keys, and Supabase Storage rejects
those with `400 InvalidKey`. **Five upload paths were broken for Korean filenames** -
media, 자료실, notice attachments, result sheets, chat - which is the default case in
this club. Four were already merged. Two agents reproduced it independently.

Every gate was green, and honestly so:

```
typecheck, all trees   pass - it is a string
unit tests             pass - they assert what safeObjectName RETURNS, never that
                              storage accepts it
browser e2e            pass - not one of them uploads a file
```

**The `team-files` bucket held zero objects.** No test in the repository had ever
sent bytes to storage.

**Code that talks to an external service is unverified until one test makes that
round trip.** Asserting its inputs and outputs as tightly as you like says nothing
about whether the other side accepts them. Three cheap symptoms: **is there zero data
on the far side** (bucket objects, table rows), **is there a test that makes the round
trip**, and **does that test assert the response.** Zero is the strongest of the
three - an empty destination after months means nobody has walked the path end to
end, and green gates then are not evidence of safety but evidence that the gates do
not reach it.

### Two migrations that `create or replace` the same function

`create or replace` rewrites the whole body; it is not a delta. When two in-flight
migrations both redefine one function **the later one erases the earlier**, and
"later" means two different things:

- **a fresh database** applies in filename order, so the higher number wins
- **the shared dev database** applies in *wall-clock* order, so whoever re-applied
  most recently wins - and re-applying an older migration silently reverts a newer one

Two rules, and the second is the one that gets skipped:

1. **Writing:** include the union, not your delta - carry the other migration's arm
   even if it has not merged.
2. **After applying:** read the live definition back and confirm your arm survived -
   `select prosrc from pg_proc where proname = '<function>';`

Without step 2 nobody learns their migration was quietly undone.

### Applying an unmerged migration to the shared dev database

It is legitimate - verifying a migration requires applying it. But **from that moment
every agent's e2e reflects somebody's unmerged branch**, and the schema and the
deployed code point at different commits.

This cost a full investigation: notices could not be created, in the app as well as in
tests, because an unmerged migration had revoked `notices_write` in favour of an RPC
that only the unmerged code calls. The investigator scanned all 41 migrations on their
own branch, found the policy created and never dropped, and concluded somebody had
hand-edited the database. **A reasonable inference, and wrong** - the file was on a
branch their `ls` could not see, which is the same blind spot that makes a local
listing useless for claiming a migration number.

So: **when the live database disagrees with the migrations, suspect an unmerged
migration before suspecting a hand edit.** The question is answerable only across every
branch:

```bash
git log --all -S '<policy or function name>' -- app/supabase/migrations/
```

The duty runs the other way too: **if you apply an unmerged migration to the shared
database, tell the team**, or somebody else pays for a state only you can see.

### A new worktree starts with three things missing, not one

The fresh-checkout trap above is about `app/.env`. A new worktree is missing three:

```
node_modules            absent -> ./node_modules/.bin/tsc: No such file or directory
<worktree>/.env         absent -> scripts/psql.sh refuses with ".env not found"
<worktree>/app/.env     absent -> vitest dies in env.ts's zod validation
```

**There are two `.env` files and they are different.** The root one drives the psql
scripts; `app/.env` drives vite and vitest. **psql working tells you nothing about
whether vitest will run.** Each satisfies a different gate, and one succeeding does not
license an inference about the others - which is the same shape as "say which tree you
checked" two sections up.

This is `.gitignore` behaving correctly, so it is a cost to pay rather than a defect to
fix, but knowing it in advance saves three separate failures.

### Ask git by a named ref, not by `HEAD`

While the anchor is drifting, `git rev-parse HEAD` answers about whatever tree it is
standing in - honestly, which is the problem. **Asking by branch name gets the right
answer regardless of where the command is standing**, because the name resolves through
the ref rather than through the current directory. Same lesson as `git -C`, and cheaper
than either that or `EnterWorktree`.

### `cleanup.sql` cannot see a signup row that has no auth user

One `pwtest` member survived every teardown for **3.8 days**, outliving many full suite
runs. Two agents each read `pwtest members = 1`, correctly paired it with a liveness
check, and correctly left it alone - because a run really was live both times.

It is unreachable for a structural reason:

```
nickname       pwtest.../98/남/관악
status         pending
auth_user_id   NULL          <- the reason
```

`cleanup.sql` reaches button-created accounts through a `pwtest%@eysl.local` **auth
join**, and reaches the fixed fixtures by their known ids. This row has neither: its id
is random and it has no auth user for the join to find, so it falls between both arms.

Any signup path that writes a `members` row without an `auth.users` row produces one.
Until the predicate covers it, **`pwtest members = 1` is that row** - and everybody who
applies the liveness rule correctly will find no runner, conclude "leak", and spend the
time again.

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
| ~~Admin attendance check-in never persisted~~ — **fixed upstream 2026-08-30** | was `setAtt`/`togglePaid`, state in `attRecords` | Fixed by a **new path beside the old one, not by repairing it**. `setAtt` is still memory-only; `saveAttendanceEvent(id)` resolves nicknames through `team_roster` and upserts into `attendance`, behind an explicit 출석 저장 button. So a check-in is still lost if the admin never presses save. **Ours must persist on the tap.** And the commit that claims this fix does not contain it — see the sidecar section below. |
| Notice comments overwrite each other | `addComment()` `:2001` | Whole jsonb array replaced from a stale client copy, so concurrent comments silently destroy one another. Author is stored as a nickname string, not `member_id`. |
| Training capacity race | `applyTraining()` `:2384` | Browser decides seat-vs-waitlist and computes `wait_order` from a cached count, then sends it. Simultaneous applicants overbook or collide on order. |
| Attribute-context XSS in an admin render path | *(location withheld)* | A member-controlled value reaches a script context unescaped. A near-identical render a few lines away escapes correctly, so this is an omission rather than a policy. |
| Most admin routes have no router guard | `showPage()` `:1629-1648` | Only two of the admin screens check a role; the rest rely on drawer link visibility (`applyRole()` `:1813`), which is presentation, not access control. |
| Waitlist offer expiry may never advance | `:1330`, `:2399`, `:2410` | UI promises "자동으로 다음 대기자에게 기회가 넘어갑니다" but the client only *filters out* expired offers; nothing promotes the next person. Whether a server-side job exists is UNVERIFIED. |
| `activities.details.participants/waitlist/offer` is dead data | written `:3590`, read `:1206`, overwritten `:1312` | `loadPersistentContent` rebuilds participants from `activity_applications` on every load, so the jsonb copy is write-only. Two sources of truth; the table is the real one. |
| Editing a past training erases its backfilled attendance register | `registerSchedule()` `upstream:3817-3826` | Verified 2026-08-25. `details` is rebuilt from scratch on every save. It carries `participants`/`waitlist`/`relays` forward from the old row and **not** `historical_participants`/`historical_attendance`, so one edit to a backfilled past training destroys the register. Same family as the comment overwrite, and newer: the historical keys only appeared on 2026-08-24. |

Line numbers above are against **`origin/main:index.html` (3,846 lines)** unless marked `upstream:`. `upstream/main` is now 4,257 lines and every number below ~1100 has shifted; re-locate by function name rather than trusting the offset.

**Not verifiable from this repo** (needs the president's Supabase dashboard): whether RLS actually enforces anything, the source of all 14 RPCs and the 3 Edge Functions, and whether `member_history_v4` returns real per-event attendance or merely synthesizes from the `members.historical_*` counters. Treat every claim about server-side enforcement as an assumption until checked — and do not probe production authorization to find out, since that system isn't ours.

## Where upstream has moved (verified 2026-08-25, extended 2026-08-26)

Four of his recent changes contradict something we had already decided or built. The scope rule applies to these exactly as it does to the rest: what he shipped **is** the spec, and where we differ, we move.

**But his diff is intent, not observed behaviour — check before you treat it as a spec.** `upstream/main:index.html:1624` reads `historicalTrainingRes?.error ? [] : (historicalTrainingRes?.data||[])`, and that identifier appears **exactly once in the whole file** — at that use. Nothing declares it. Optional chaining guards a null *value*, not an undeclared binding, so the line throws `ReferenceError` on every call.

It sits mid-way through `loadPersistentContent()`, so everything after it is dead: waitlist offers never render, the localStorage cache never refreshes, media, member avatars and notice attachments never load. `loginMember()` awaits it inside a try whose catch shows `로그인 중 오류가 발생했습니다` — **a fresh login fails outright**. A resumed session degrades silently.

`final64` had it right (`const historicalTrainingPromise = dbClient.rpc('get_historical_training_people_v1')` feeding a seventh `Promise.all` slot); `final66-app-icon` deleted the declaration and left the consumer.

**It ran from `final66` to `final91` — 19 releases — and `final92-unregistered-roster` (`59a67e3`) fixed it.**

*(That number was first written here as 26, and separately guessed at as 27, both by subtracting `66` from `91`. **His release numbers are not dense.** 67, 68, 74, 82, 84, 88 and 90 never shipped, so the run is 66, 69, 70, 71, 72, 73, 75, 76, 77, 78, 79, 80, 81, 83, 85, 86, 87, 89, 91 — nineteen. Counted by walking every commit and asking each one whether `index.html` used `historicalTrainingRes` without declaring it. **Subtracting two version numbers is arithmetic about a naming scheme, not a count of releases**, and the walk costs one loop.*

*The first walk filtered to commits touching `index.html` and got the same 19 — but it also silently dropped `final59`, a release that changed only `sw.js`. That filter was wrong for the question being asked: a release that ships an untouched broken file still ships the bug. **The answer surviving the removal of a bad filter is evidence; the filter agreeing with the answer would not have been.**)* At `final91` the consumer sat at `index.html:1631` while `loadPersistentContent()` destructured six slots where `final64` destructured seven, so anything downstream of that line had never executed. `final92` put the seventh slot back and gave it a source:

```diff
- const [noticeRes,activityRes,memberRes,applicationRes,historyRes,raceHistoryRes]=await Promise.all([
+ const [noticeRes,activityRes,memberRes,applicationRes,historyRes,raceHistoryRes,historicalTrainingRes]=await Promise.all([
+  dbClient.rpc('team_attendance_canonical_v1')
```

Declared at `1572`, used at `1632`, and the same at the tip (`final93-owner-time`, `4475128`).

**So the question below has a version boundary, and it is the whole of its meaning.** It applies to **`final66` through `final91`**. From `final92` on, `loadPersistentContent()` runs to completion and downstream code is observed behaviour again — porting from it under the old rule would throw away a working reference and re-decide semantics he has already settled.

That boundary is the point worth keeping. **A rule derived from a bug expires when the bug is fixed, and nothing announces it** — this one was written on 2026-08-26 and was already false the same day. Any rule of this shape needs the version it was measured at written beside it, so the next reader can check whether it still holds instead of inheriting it.

The lesson for us is narrow and important: **a feature we are porting may never have run in his app.** `final62-history-all-participants` and `final64-canonical-training-attendance` are both downstream of this, so reconstruct them from the `bc3523d` snapshot and do not assume he has validated their semantics against real data. Reported to the president separately; his own breakage, not exploitable, so naming the line here is safe.

**So, when porting from a release between `final66` and `final91`, ask this first: is the feature's read path downstream of `index.html:1631`?** It is a mechanical question, not a judgement — find where the screen gets its data and see whether that runs inside `loadPersistentContent()` after the throwing line, or from somewhere else. (At `final92` and later the line no longer throws, so the answer is always "not downstream".)

| answer | what you are porting from |
|---|---|
| **downstream** | Nothing. The code has never executed, so there is no observed behaviour to match. **The semantics are ours to decide, and the decisions go in the migration header marked as ours** — a reader in six weeks has to be able to tell a port from a choice. |
| **not downstream** | A working reference. His app really does behave this way, so a difference between his screen and ours is a bug in ours. |

Two worked examples, because the answer does not follow from how central the feature looks:

- 영법별 랭킹 (`0041`) is **not** downstream. `openFunEventPage` hangs off an `onclick` and calls its own RPC, and it reads nothing `loadPersistentContent()` populates — the payload carries nicknames directly, so there is no `members` lookup to be starved. One grep for the call sites settled it.
- His push subscription path is also **not** downstream, for the same structural reason — which is how we know its failure was a separate fault (`sw.js` could not parse) rather than another symptom of this one. Two independent faults were live at once from `final66` to `final83`, and assuming a single cause would have found the wrong one.

The grep is for call sites, not for the definition. At `final92`, `openFunEventPage` appears four times: three `onclick` attributes and the definition. **What matters is who calls it, not where it lives** — and the count differs between releases, so read it out of the release you are porting rather than carrying a number across.

**And no member of his club received a push notification before `final85`** — but the reason is not the obvious one, and the obvious one is wrong.

`sw.js` fails to parse in **56 consecutive versions**, `final14-auth` through `final83-push-clean-start`. The cause is one character on line 3, where `e.waitUntil(` is closed and `self.addEventListener(` never is.

*(This said **57** until it was measured. 57 is real, but it counts **commits that touched `sw.js`** and fail to parse; the sentence calls them versions, and two of those commits shared one VERSION string. Re-measured over the whole history: 73 distinct VERSION strings ever existed, **56** of them unparsable, occupying positions 11 through 66 of the sequence with no parsable version among them — so **consecutive is right, and only the number was wrong.***

***Consecutive was checked by printing the sequence, not inferred from the count.** A count cannot establish consecutiveness: 56 broken out of 73 is equally consistent with them being scattered. Two separate claims live in that sentence and they need two separate measurements.*

***And the unit that survives the filter is the one to quote.** Walking every commit instead of only those touching `sw.js` moves the commit figures — 74 → 80 commits carrying a `sw.js`, 57 → 62 of them unparsable — while the version count stays **56 either way**. A quantity that changes when you change which commits you look at is describing your walk; a quantity that does not is describing his releases. Same filter defect, same conclusion, as the `index.html` walk above.)*

**A file that fails to parse is a rejected update, not an uninstall.** A member already holding a working worker keeps it; the browser simply declines the new one. So "there was no worker" would be false, and the conclusion has to rest on something else. It does:

```
480259d  final12-profile-role      parses   addEventListener('push')  0   <- last installable worker
1d60225  final14-auth              FAILS                              0   <- break enters here
1cf1697  final16-push-status…      FAILS                              1   <- push handling first appears
…        54 more failing versions, all with a push handler
265e14d  final85-push-true-reset   parses                             1   <- first file that does both
```

**The last worker that could install had no push handler, and every file that had one was rejected.** Push handling and a parsable file were never the same file until `final85`. That is why the run of five push releases — `push-repair` · `push-autofix` · `push-server-register` · `push-clean-start` — ends exactly there: he rewrote `sw.js` from scratch and the bracket went with it.

Reproduce it over the whole history rather than the slice we can see; sweeping only `origin/main..upstream/main` gives 29 and reads as though the fault began at our fork point. Note the path filter is **gone** from the loop below — it is what produced the 57, and `-- sw.js` answers "which commits edited this file", not "which releases shipped it broken":

```bash
for c in $(git log --format=%h --reverse upstream/main); do
  git show "$c:sw.js" > /tmp/sw.js
  printf '%s ' "$c"; node --check /tmp/sw.js && echo ok
done
```

Two things follow. His push problem and his notice-push problem have **different causes** — the first is a worker that could not install, the second is `historicalTrainingRes` throwing, and from `final66` to `final83` both were live at once. And our own `push-notify` 500 is a third, separate problem, so **there is nothing to take from those five releases.**

**"이벤트" no longer means what it means in our code.** In his app the third activity kind is now labelled **기타**, and **이벤트** was reassigned to a rankings hub — a different feature entirely (출석왕 · 지각왕 · 단축왕). The database token stays `event`; only the Korean label changed, and he left the stored value alone too. Ours still renders '이벤트' for the kind, which now names the wrong thing to anyone reading both apps.

**Any approved member may create a 기타 activity** (`canCreateActivityType` / `canEditActivityItem`, `upstream:3761-3762`): the creator alone may edit or delete it, while 훈련 and 대회 stay staff-only. Our `activities_write` is `is_staff()` for every kind (`0001:182-184`), which simply refuses them.

Two things to know before implementing it. His client sends `created_by` from the browser (`upstream:3831`) — ours must derive it server-side, because a client that can name the creator can claim someone else's row. And **he did not lock the kind selector**: there is no `aType.disabled` anywhere in his file, so nothing in his client stops a member from re-saving their 기타 as a 훈련. Whether his RLS catches that is not knowable from here. Ours must, and `using`/`with check` have to be closed as a pair for it to hold on UPDATE.

**`activities.details` now carries canonical data, which revises the rule above it.** `historical_participants` (nickname array) and `historical_attendance` (nickname → status map) hold the club's paper attendance registers for trainings that predate the app. Unlike `participants`/`waitlist`/`offer` — still dead data, still rebuilt from `activity_applications` every load — these are **read-only canonical**: `index.html` reads them at `upstream:1300-1301` and writes them nowhere, so he backfills through the dashboard or SQL.

**Our schema holds them already, and the sentence that used to stand here was wrong.** It said "our schema cannot hold them — `attendance.member_id` is a FK to `members`, so a past participant who never had an account cannot be stored at all." The FK asks for a **member row**, not an account, and a member row needs no `auth_user_id`. Measured 2026-08-26:

```
members | no_login | with_login        attendance | for_no_login
     41 |       36 |          5               249 |          198
```

**79% of every attendance row we hold belongs to somebody who has never logged in** — the 36 whose rows came from the club spreadsheet, the same population `0035` counted in its own header. They reach the roster too: `0030` widened it to `activity_applications ∪ attendance`, and on the activity with the most attendance that returns 19 people of whom 17 have no login.

Two lessons, and the second is the transferable one. `attendance_for_activity_v1`'s owner is **`0030`**, not the `0001:258-269` this file used to cite — **a `create or replace` leaves the old line reference looking valid**, so re-find a function by name before trusting a line number attached to it. And the claim itself had been repeated for two days without anybody running `select count(*) filter (where auth_user_id is null)`, which is the whole check. **A schema claim is answerable by the schema; ask it before writing the claim down.**

What was genuinely missing was narrower: staff could *mark attended* a member who cannot sign in (`attendance_mark_v1` takes `p_member_id`) but could not *enrol* one, because `apply_to_activity` derives the member from the session and there was no staff-side path. `0042` adds one, and refuses to waitlist such a member — `offer_seat_to_next_waitlister()` picks by `wait_order` without asking whether the person can answer, so queueing an unreachable member parks a live seat for 12 hours per turn at everyone else's expense.

**He removed the admin bypass from media management** (`canManageMediaOwner`, `upstream:2930`): owner-only now, where it used to be `isAdminUser() || owner`. **Closed in `0021`** — `media_folders_update`, `media_files_update` and `media_files_delete` are owner-only, `media_folders` has no DELETE policy at all (deletion goes through `delete_media_folder_v1`, which checks ownership), and the screens no longer offer staff a control the database would refuse. The cost is real and is his to revisit: no admin can take down another member's folder or file from inside the app any more.

`0021` settled the other half of the same question too. **Creation in 미디어 and 자료실 is open to every approved member**, because his app is: `createFolder` (`upstream:2939`), `uploadToFolder` (`upstream:2946`) and `uploadResourceFiles` (`upstream:2960`) carry no role check, their buttons are always rendered (`upstream:1185-1187`), and `applyRole` (`upstream:1984-1994`) never touches a media control. Our screens had hidden all three behind `isStaff()` while RLS admitted anyone — the legacy flaw rebuilt — so the screens moved, not the policy. What `0021` did add is ours: an object may only be written at `<own member id>/(media|resources)/<name>`, and only where a `media_files` row already claims that exact path, so the bucket can no longer hold bytes nothing points at. `team_files_delete` keeps its staff arm on purpose — a folder owner cannot sweep another member's object, so somebody has to be able to.

## His app is no longer one file, and three of the pieces are dead

Measured at `upstream/main` `bd3a7b4`, 2026-08-31.

`index.html` is still there, but **13 sidecar `.js` files now sit beside it**, and
`index.html` **references none of them** — all 13 score 0 in it. They are reached
one way only: `sw.js` precaches them and injects them.

```
13 sidecars
   10  named by sw.js  ->  they really run, in any browser that installs the worker
    3  named by nothing at all:
          enhancements-v93.js        12,955 bytes
          notice-fix-v95.js           7,032 bytes
          attendance-sync-v104.js     1,417 bytes
```

**All 13 parse, and so does `sw.js`** (`node --check`, exit 0). That matters twice
over. The 56-version bracket era documented above is **finished** — the worker
installs now, so the 10 injected files are genuinely live. And the three dead ones
are dead by **non-reference, not by syntax**: `enhancements-v93.js` is nearly 13KB
of perfectly valid code that nothing loads.

**So "does it parse" is no longer the question to ask about his code.** It was the
right question while one character on line 3 broke everything; it now answers `ok`
for a file that has never run. The question is whether anything names the file, and
`grep -c '<basename>' sw.js index.html` settles it in one command.

**And a commit message can promise a fix that its own diff does not contain.** This
is the sharpest instance yet, because both halves shipped on the same day:

```
f639033  cutepms123-blip  2026-08-30  "Persist admin attendance changes"
         -> attendance-sync-v104.js | 33 +++   and nothing else
            that file is one of the three nothing references

0149d73  team-eysl-bot    2026-08-30  "Persist attendance and late-fee status"
         -> index.html | 97 +++ 5 ---          the actual fix
```

The commit whose subject names the defect **shipped dead code**; the fix arrived in
a different commit, by a different author, through a different mechanism. `sw.js`'s
VERSION string and `historicalTrainingRes` were the first two members of this family
and both were about a *release* being misdescribed. This one is a single commit
misdescribing itself, which no amount of reading subject lines can catch. **Read the
diff, then check that the file the diff touches is reachable.**

### Two changes to the gap list

**활동 댓글 + 푸시 is a real gap, and it is his.** `activity-comments-v98.js` is one
of the 10 that run: an `activity_comments` table, comments on the application screen
of 훈련·대회·기타, and a `push-notify` call on each new comment. On our side
`activity_comments`, `activityComment` and `ActivityComment` are **0 files** across
the 155 under `app/src`, against `useState` at 37 files and `notice_comments` at 2
as positive controls. The zero is real. It is already assigned —
`feat/activity-comments` holds `0050`.

**활동 취합본 runs the scope rule backwards: he deleted it, and we still have it.**
`remove-aggregation-v113.js` strips the menu and the page with a MutationObserver,
and the v114 patch workflow enforces the removal in CI with
`if grep -q "활동 취합본" index.html; then exit 1`. That is a verified deliberate
deletion, not an omission. The scope rule says an implemented feature is a
requirement — but that rule reads from *his* app, and his app now says no. **Ask him
before removing ours.** A feature he cut and we kept is a question for him, not a
defect to quietly fix.

## External integrations

`myranking.co.kr` (Korean swim ranking site) is **off-limits to automated access**. Its `robots.txt` is `User-agent: * / Disallow: /` for everything except Google/Naver/Daum/Bing, with an operator comment stating they enforce it server-side with rate limits. Do not build a fetcher or scraper against it regardless of scale. The legitimate paths are (a) written permission from the operator, or (b) the better option anyway: meet result sheets are already public documents that the club already possesses, and myranking is itself just an OCR aggregator of them — so the automation win is the *parser*, not a fetch. `whoisfast.com` has a permissive robots.txt but masks athlete names by one character, so it cannot supply the 실명 the record matcher keys on. `data.go.kr` publishes no swim-record dataset.

<codex_delegation>
Global `~/.claude/CLAUDE.md` already carries the full ruleset — do not duplicate it here. Project-specific only:

- Verified on this machine 2026-08-24: `codex-cli 0.147.0`, model `gpt-5.6-sol`.
- Background sessions on this repo are forced into a git worktree, where a `codex exec "$(cat prompt.md)"` written inline is refused ("too complex to verify"). Put the invocation in a wrapper `.sh` and run it as one plain command instead.
- Canonical call (the `-o` artifact is the source of truth, never stdout):
  `codex exec -m gpt-5.6-sol -c model_reasoning_effort="high" --json -o /path/verdict.txt "$PROMPT"`
- 2026-08-24, this repo: the `codex:rescue` skill returned a contentless `"Complete."` twice in a row despite 51 real `tool_uses` and 10+ min runtime; a `SendMessage` resume produced the same. A *completed* status with an empty result means the delivery channel failed, not that the work is absent. One retry, then drop the codex track and verify load-bearing facts directly.
- **A missing `-o` artifact is not a delivery failure.** The rule above turns on the word *completed*: until the run reports completion, an absent or short artifact is indistinguishable from work still in progress. Reading it as a failure nearly discarded eight minutes of a live #22 re-review on 2026-08-26. The cheapest discriminator is the log's mtime against the clock — **`stat -c '%n %s bytes  mtime %y' <log>`**, which works today. **`ls -l --time-style=…` does not**: it printed empty output for a file already known to exist, which reads exactly like "no such file". Where mtime is ambiguous, parse the `--json` log — a run still going ends on `item.started` / `command_execution` / `web_search` with only short `agent_message`s (139–206 chars), while the verdict is a single closing `agent_message` of several thousand.
</codex_delegation>

### HTML rendering convention

Dynamic HTML is built as template literals assigned to `.innerHTML`, escaped through `escHtml()`/`escAttr()` helpers (`index.html:1649` / `1657`; note `escAttr` is redefined a second time at `1975` — same behavior, just duplicated). When adding new `innerHTML` output, escape any value that ultimately comes from user/DB input the same way. Some existing call sites skip escaping (e.g. the home-page "next up" card at `index.html:1971` and notice title/body in `renderNoticeDetail`/`renderHome` around `1962-1965`) — don't copy those as a pattern.
