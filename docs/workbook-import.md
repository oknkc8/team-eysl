# Club workbook import

방장님이 관리하시는 구글 스프레드시트(☆명단(출석부) · ☆대회 기록 · ☆2026 대회)를 읽어
`members` · `activities` · `attendance` · `records` 에 넣는 도구입니다. 원래는 내려받은
`.xlsx` 를 인자로 주고 손으로 한 번 돌리는 물건이었는데, 이제 시트를 직접 받아올 수 있고
스케줄러에 걸어 둘 수도 있습니다.

`app/scripts/import/` 아래에 파서(`parse.ts`) · SQL 생성기(`toSql.ts`) · 소스 판별
(`source.ts`)이 있고, 셋 다 `npm test` 가 도는 트리 안에 있습니다.

## Running it

`app/` 에서 실행합니다.

```bash
npm run db:import -- --summary   # 시트만 읽고 무엇이 들어갈지 세어 봅니다. DB 접속 없음
npm run db:import                # 실제로 넣습니다
npm run db:import -- ~/Downloads/club.xlsx          # 내려받은 파일로
npm run db:import -- https://example.test/w.xlsx    # 임의의 URL 로
```

인자가 없으면 `.env` 의 `EYSL_WORKBOOK_SHEET_ID` 가 가리키는 시트를 받아옵니다.
`http://` 나 `https://` 로 시작하면 URL, 그 밖에는 파일 경로로 봅니다.

**먼저 `--summary` 로 보십시오.** DB 에 붙지 않고 파서가 무엇을 읽었는지, 경고가 몇 개인지만
알려 줍니다. 넣기 전에 확인할 것이 전부 여기 나옵니다.

## Pointing it at a different sheet

`.env` 한 줄입니다. `.env.example` 에 형태가 적혀 있습니다.

```
EYSL_WORKBOOK_SHEET_ID=<시트 URL 의 /d/ 와 /edit 사이 토막>
```

URL 전체가 아니라 **파일 id 만** 넣습니다. 링크는 `scripts/import/source.ts` 가 만듭니다.
id 만 설정 가능하게 둔 이유는, URL 을 통째로 받으면 오타 하나로 임포터가 아무 호스트나
받아오게 되기 때문입니다.

**이 id 는 이름처럼 생겼지만 자격 증명입니다.** 게시된 export 링크는 인증을 요구하지 않아서,
id 를 아는 사람은 누구나 워크북을 내려받을 수 있습니다. 그 안에는 마흔 명의 실명 · 생년월일 ·
전화번호가 들어 있고 **이 저장소는 공개되어 있습니다.** 그래서 DB 비밀번호와 똑같이 `.env`
에만 두고, 코드에 기본값으로 박거나 PR 에 붙이지 않습니다.

## What the import will and will not do

**들어오는 것만 들어옵니다.** 생성되는 모든 구문이 `ON CONFLICT ... DO NOTHING` 입니다.
즉 **새로 생긴 회원 · 새 훈련 날짜 · 새 기록은 반영되고, 이미 들어간 행을 시트에서 고친
것은 영원히 반영되지 않습니다.** 조용히 그렇습니다.

일부러 그렇게 만든 것입니다 — `do update` 로 두면 회원이 앱에서 직접 고친 실명과 운영진이
고친 출석 상태를 임포트가 돌 때마다 시트 값으로 되돌립니다. 이유는
`scripts/import/toSql.ts` 첫 40줄에 다 적혀 있습니다.

다만 **「자동 임포트」를 「앱이 시트를 따라간다」로 읽으면 틀립니다.** 방장님께 넘길 때
이 문장을 같이 전해야 합니다. 시트에서 고친 값을 DB 에 반영하려면 해당 행을 지우고 다시
넣는, 사람이 하는 일이 필요합니다.

## Two guards, both normally silent

임포트는 트랜잭션을 열자마자, 아무것도 쓰기 전에 두 가지를 확인하고 걸리면 전부 되돌립니다.

**Double-count guard.** 시트의 출석 그리드에 이름이 있는 회원 중
`historical_attendance_count_legacy` 나 `historical_late_count_legacy` 가 0 이 아닌 사람이
있으면 거부합니다. **두 카운터를 다 봅니다** — `team_event_rankings_v1` 이 둘 다 더하기
때문입니다(`0016:154-157`).

```
lifetime_present = historical_attendance_count_legacy + count(present|late)
lifetime_late    = historical_late_count_legacy       + count(late)
```

그 카운터가 요약하고 있는 날짜별 그리드를 또 넣으면 같은 출석을 두 번 셉니다. 에러도 안 나고
화면도 멀쩡해 보입니다. **지각왕 쪽이 더 위험합니다** — 두 배가 된 지각 횟수는 그럴듯해
보일 만큼 작아서 아무도 이상하다고 생각하지 않습니다.

**터지는 범위는 여섯 칸 중 둘입니다.** legacy 항은 `0016:154-157` 에만 있고, `h1_present` ·
`h2_present` · `h1_late` · `h2_late`(`0016:158-169`)는 `marks` 만으로 계산해서 legacy 항이
없습니다. 그래서 상·하반기 랭킹은 멀쩡하고 lifetime 두 칸만 망가집니다.

**다만 「lifetime 만 노출된다」는 말은 틀립니다.** `0016:176-181` 의 unpivot 이 여섯 쌍을 전부
내보내고 `pairs` 가 전부 클라이언트까지 갑니다. 정확한 표현은 「legacy 항을 가진 것이 lifetime
둘뿐」이지 「노출되는 것이 lifetime 둘뿐」이 아닙니다. 피해 범위는 같지만 이유가 반대이고,
틀린 쪽을 적어 두면 다음 사람이 h1/h2 는 화면에 안 나온다고 믿게 됩니다.

**지금은 걸릴 일이 없습니다.** 2026-09-03 실측으로 회원 47명 전원이 두 카운터 모두 0 이고
두 컬럼의 최댓값도 0 입니다. 누군가 시트의 상반기/지각/하반기/지각 칸을 그대로 채워 넣고
임포터를 다시 돌리는 날을 위한 덫이지, 매번 일을 하는 검사가 아닙니다. **한 번도 안 터졌다고
지우지 마십시오** — 안 터지는 것이 정상 동작입니다.

**Identity-drift guard.** 시트에 있는 회원이 **다른 닉네임으로 이미 DB 에 있으면** 거부합니다.
실명과 생년월일이 둘 다 같은 것으로 판정합니다.

이건 이론이 아니라 2026-09-02 에 실제로 터진 것입니다. 이미 임포트되어 있던 dev DB 에 시트를
다시 넣었더니 회원 6명이 새로 생겼고, **그중 4명이 이미 있던 회원과 실명·생년월일이 같았습니다.**
같은 사람이 둘이 되고, 출석 46행과 기록 일부가 복제된 쪽에 붙었습니다. 모든 구문은 성공했고
아무 경고도 없었습니다.

원인은 **임포트의 신원 키가 사람이 손으로 고치는 셀**이라는 데 있습니다.
`on conflict (lower(nickname))` 이니 닉네임이 신원이고, 그 닉네임은 시트의 짧은이름 칸에서
나옵니다. 방장님이 그 칸을 다듬으면 같은 사람이 다른 사람이 됩니다.

**손으로 한 번 돌릴 때보다 스케줄에 걸었을 때 훨씬 위험합니다.** 지켜보는 사람 없이
이름이 정리될 때마다 회원이 하나씩 복제되고, 랭킹과 출석은 그 복제본을 셉니다.

가드는 **고치지 않고 멈춥니다.** 두 행을 합칠지 한쪽 이름을 바꿀지는 그 사람의 출석과 기록이
어디에 남을지를 정하는 일이라 임포터가 결정할 수 없습니다.

한계 두 가지도 알고 쓰십시오. 시트에 실명과 생년월일이 **둘 다** 있는 회원만 봅니다. 그리고
실명은 앱에서 `set_my_real_name` 으로 고칠 수 있으니, 스스로 이름을 고친 회원은 시트 표기와
달라져서 이 가드에 안 걸립니다. 근본 해결은 **시트가 바꿀 수 없는 신원** — 시트에 이미 있고
지금은 아무것도 싣지 않는 `번호` — 이고, 스키마 변경이라 다음 사람 몫입니다.

## Idempotence

두 번 돌려도 아무것도 변하지 않아야 합니다. 행 수만 세면 이걸 확인할 수 없습니다 —
덮어쓰는 upsert 도 행 수는 그대로 두니까요. 그래서 `updated_at` 까지 포함한 지문을 뜹니다.

```bash
npm run db:import:verify            # .env 의 시트로
npm run db:import:verify -- <path>  # 파일로
```

임포트를 두 번 돌리고 지문을 비교합니다. 인자 없는 형태를 쓰십시오 — 스케줄러가 쓰는 것과
같은 경로를 지나갑니다.

**이 스크립트가 증명하는 것은 「2회차가 1회차와 같다」이지 「1회차가 아무것도 안 했다」가
아닙니다.** 1회차 뒤에 지문을 뜨기 때문입니다. 시트가 DB 보다 앞서 있으면 1회차가 행을
넣고, 그래도 PASS 가 나옵니다. 정말로 아무 일도 없었는지 보려면 돌리기 **전에** 행 수를
따로 세 두십시오. 2026-09-02 에 이걸 안 해서 6명·46행·66건이 들어간 것을 나중에야
알았습니다.

## Scheduling

`app/scripts/import-club-workbook-scheduled.sh` 가 스케줄러가 부르는 진입점입니다. 인자 없는
임포트에 로그 · 락 · PATH 보정을 더한 것뿐입니다. 로그는 `~/Library/Logs/team-eysl/import.log`
에 0600 으로 쌓이고, **저장소 안을 로그 경로로 주면 거부합니다** — 로그에 회원 데이터가
들어가고 이 저장소는 공개이기 때문입니다.

macOS launchd 로 거는 방법:

```bash
sed 's#__REPO__#'"$(cd /path/to/team-eysl && pwd -P)"'#' \
  app/scripts/launchd/com.eysl.workbook-import.plist \
  > ~/Library/LaunchAgents/com.eysl.workbook-import.plist
# plist 안의 PATH 를 이 머신의 node · psql 위치로 고칩니다
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.eysl.workbook-import.plist
```

확인 · 즉시 실행 · 제거:

```bash
launchctl print     gui/$(id -u)/com.eysl.workbook-import
launchctl kickstart -p gui/$(id -u)/com.eysl.workbook-import
launchctl bootout   gui/$(id -u)/com.eysl.workbook-import
```

기본값은 월요일 06:00 주 1회이고, `RunAtLoad` 가 켜져 있어 **설치하는 순간 한 번 돕니다.**

**설치하기 전에 identity-drift 문제를 먼저 정리하십시오.** 위에 적은 대로 지금은 시트의
짧은이름이 바뀔 때마다 회원이 복제됩니다. 가드가 그걸 조용한 복제 대신 요란한 실패로
바꿔 놓기는 했지만, 그러면 스케줄 실행이 사람이 손댈 때까지 계속 실패합니다.

### Why not GitHub Actions

이 저장소는 공개고, 공개 저장소의 Actions 로그도 공개입니다. 그리고 이 작업은 자격 증명이
**둘** 필요합니다 — dev DB 비밀번호와 워크북 시트 id. 실행 출력 자체도 회원 데이터입니다
(파서 경고가 시트 행을 인용합니다).

같은 판단을 이 저장소는 이미 한 번 내렸습니다. `.github/workflows/app.yml:195-201`:

> This repository is public. Putting the dev database password into Actions secrets to make
> those tests run in CI would recreate, by hand, exactly the exposure guard.yml exists to
> prevent — and it would do it on the one project we can actually damage.

Playwright 를 CI 에서 안 돌리는 이유가 그대로 여기에 적용되고, 자격 증명이 하나 더 늘어납니다.

### Why not a Supabase Edge Function

pg_cron 1.6.4 와 pg_net 0.20.4 가 우리 프로젝트에 깔려 있으니 기술적으로는 가능합니다.
하지만 임포터는 파서 785줄과 SQL 생성기이고, vitest 79개가 지금 돌고 있습니다. 이걸
`supabase/functions/` 로 옮기면 **`CLAUDE.md` 가 「얕게만 검사된다」고 적어 둔 트리**로
들어갑니다 — Deno 는 이 머신에 없고 타입은 손으로 쓴 shim 이며, shim 이 틀리면 그 검사는
실수에 동의합니다.

그리고 psql 로 흘려보내는 검토 가능한 SQL 이, 상시 자격 증명을 든 함수의 직접 쓰기로
바뀝니다. 몇 행 덧붙이는 작업치고는 영구적으로 늘어나는 면적이 큽니다. 요구사항은 **검증된
임포터를 자동화하는 것**이지 다시 쓰는 것이 아니었습니다.

### What the local runner costs

솔직하게 적어 둡니다. **이 머신이 깨어 있고 이 사용자가 로그인해 있을 때만 돕니다.** launchd
는 자는 동안 놓친 실행을 다음 로그인 때 한 번 따라잡을 뿐, 놓친 만큼 몰아 돌리지 않습니다.
아무도 앉아 있지 않은 곳에서 돌아야 한다면 그건 비공개 저장소나 상시 가동 머신을 두는
호스팅 결정이고, 이 스크립트가 덮을 수 있는 문제가 아닙니다.

## Files

| File | What it is |
|---|---|
| `app/scripts/import/source.ts` | 파일이냐 URL 이냐, 시트 id → 링크, 받은 바이트가 xlsx 인지 |
| `app/scripts/import/parse.ts` | 워크북 → `ClubData`. 시트 3장만 읽는 allowlist |
| `app/scripts/import/toSql.ts` | `ClubData` → SQL 한 벌. 가드 둘도 여기서 나갑니다 |
| `app/scripts/import/run.ts` | CLI. SQL 은 stdout 으로만 나가고 파일이 되지 않습니다 |
| `app/scripts/import-club-workbook.sh` | `_env.sh` 를 태우고 psql 로 흘려보내는 래퍼 |
| `app/scripts/import-club-workbook-scheduled.sh` | 스케줄러용 진입점 |
| `app/scripts/launchd/com.eysl.workbook-import.plist` | launchd 템플릿 |
| `app/scripts/import/verify-idempotence.sh` | 두 번 돌리고 지문 비교 |
