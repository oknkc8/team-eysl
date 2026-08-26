# Deploy the rebuild to Vercel

## Summary

`app/`을 Vercel에 올려 휴대폰에서 열기까지의 절차다. Vercel 계정은 네가 갖고 있으니 아래 단계는 직접 밟아야 한다.

빌드 설정은 `app/vercel.json`에 이미 들어 있다. 대시보드에서 손댈 것은 **Root Directory**와 **환경변수** 둘뿐이고 나머지는 그 파일이 알아서 지정한다.

끝나면 `https://<프로젝트이름>.vercel.app` 주소가 나온다. HTTPS라서 서비스 워커와 홈 화면 추가가 정상적으로 동작한다.

## Before you start

- Vercel 계정. GitHub 로그인이면 된다.
- `oknkc8/team-eysl` 접근 권한.
- 우리 dev Supabase 프로젝트의 URL과 publishable 키. 로컬 `app/.env`에 이미 있고 Supabase 대시보드에서도 볼 수 있다.

## Step 1. Import the repository

1. [vercel.com/new](https://vercel.com/new) 접속
2. `oknkc8/team-eysl` 선택

**Import 화면에는 브랜치를 고르는 칸이 없다.** Vercel은 저장소 기본 브랜치인 `main`으로 가져오고, 배포 대상 브랜치는 만들고 나서 바꾼다. 그 절차는 Step 6에 있다.

`main`으로 한 번 배포되어도 상관없다. Root Directory만 `app`이면 `main`에도 `app/`이 있으니 정상 앱이 뜬다. 커밋이 조금 뒤처져 있을 뿐이다.

## Step 2. Set the Root Directory

**Root Directory에 `app`을 입력한다. 이 문서에서 제일 중요한 한 줄이다.**

비워두면 Vercel이 저장소 최상단을 본다. 그 자리에는 `package.json`이 없고 레거시 `index.html`만 있어서 Vercel은 이걸 평범한 정적 사이트로 판단하고 그대로 배포한다. 그 파일에는 회장님 운영 프로젝트 주소가 하드코딩돼 있다. 즉 칸 하나를 비워둔 대가로 **회장님의 실제 회원 데이터에 쓰는 앱이 우리 도메인에 올라간다.** 화면상으로는 멀쩡히 잘 뜨기 때문에 알아채기도 어렵다.

`app`으로 지정하면 Vercel이 `app/vercel.json`을 읽고 거기 적힌 대로 빌드한다. Framework, Build Command, Output Directory는 그 파일이 이미 정해두었으니 대시보드에서 따로 채우지 않아도 된다.

## Step 3. Set environment variables

Import 화면의 Environment Variables 섹션에서 넣는다. 나중에 넣으려면 Settings → Environment Variables다.

| Name | 필수 | 어디서 가져오나 |
|---|---|---|
| `VITE_SUPABASE_URL` | 필수 | Supabase 대시보드 → **우리 dev 프로젝트** → Project Settings → Data API → Project URL. `https://<ref>.supabase.co` 형태다. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | 필수 | 같은 화면의 API Keys → publishable(anon) 키. `sb_publishable_`로 시작한다. |
| `VITE_VAPID_PUBLIC_KEY` | 선택 | 웹 푸시용 VAPID 공개키. 로컬 `app/.env`에 있는 값과 같다. 비워두면 알림 설정 화면만 "설정되지 않음"이라고 뜨고 나머지 기능은 그대로 돌아간다. |

세 값 모두 로컬 `app/.env`에 이미 있으니 거기서 그대로 복사해도 된다. 어느 프로젝트인지 헷갈리면 루트 `.env`의 `SUPABASE_PROJECT_REF`가 우리 것이다.

Environment는 **Production, Preview, Development 세 개 모두** 체크한다. 환경을 빠뜨려도 잘못된 프로젝트를 가리킨다는 친절한 에러는 나오지 않는다. `app/src/lib/env.ts:22-28`의 zod 검증이 그냥 throw하고 화면에는 빌드가 깨진 것처럼 보인다. 원인과 증상이 닮은 구석이 없어서 한참 헤매게 되는 종류의 실패다.

### What must never go into Vercel

`VITE_VAPID_PUBLIC_KEY`는 Vercel에 넣는 게 맞다. 공개키라서 어차피 브라우저가 push 서비스에 그대로 보낸다.

넣으면 안 되는 것은 VAPID **개인키**, 그리고 어떤 이름을 붙이든 service role 키다. 둘 다 Supabase 쪽에만 있어야 한다. 특히 `VITE_` 접두어를 붙이면 최악인데, Vite가 그 값을 번들 안에 문자열로 박아서 앱을 여는 모든 사람에게 배포하기 때문이다. 숨겨진 설정값이 아니라 공개된 파일 내용이 된다.

### These are baked in at build time, not read at runtime

`VITE_` 변수는 빌드할 때 번들 안에 문자열로 박힌다. 실행 중에 읽어오는 값이 아니다. 여기서 따라오는 결과가 둘 있다.

- 값을 고쳤으면 **재배포해야 반영된다.** 환경변수만 저장하고 넘어가면 배포된 앱은 옛날 값을 계속 쓴다.
- 변수를 빠뜨려도 **빌드는 성공한다.** Vercel 로그는 초록불인데 앱만 흰 화면인 상태가 되고 원인은 브라우저 콘솔에만 `Missing or invalid environment variables: ...` 형태로 남는다.

### Never point this at the president's project

`VITE_SUPABASE_URL`에는 반드시 우리 dev 프로젝트 주소를 넣는다. 회장님 프로젝트를 넣으면 `app/src/lib/env.ts:35-44`가 앱 시작 시점에 거부해서 화면이 뜨지 않는다. 다만 이건 마지막 안전장치이지 확인 절차가 아니다. 값 자체를 처음부터 우리 것으로 넣어야 한다.

## Step 4. Deploy

Deploy를 누르고 기다린다. 로컬 기준 빌드 자체는 200ms 남짓이고 의존성 설치까지 합쳐도 대개 2분 안에 끝난다.

## Step 5. Verify on the phone

**폰에서 열 주소는 Production 별칭이어야 한다.** Deployment Protection은 기본적으로 preview 주소에 Vercel 로그인을 요구한다. 커밋마다 생기는 preview 링크를 폰에서 열면 앱이 아니라 Vercel 로그인 화면이 뜬다. Production 별칭을 쓰거나, 이 프로젝트의 preview 보호를 Settings → Deployment Protection에서 꺼라.

### Check which app got deployed — before logging in

**로그인하기 전에 이것부터 한다.** 주소창에 `/registerSW.js`를 직접 입력한다.

- **JavaScript 코드가 보이면** 새 앱이다. 다음으로 넘어간다.
- **404가 뜨거나 HTML이 보이면 레거시가 배포된 것이다.** 로그인하지 말고 즉시 배포를 지운 뒤 Step 2로 돌아간다.

이 검사를 로그인 앞에 두는 이유가 있다. 레거시가 잘못 배포되면 그것은 **회장님 운영 프로젝트에 붙은 앱**이고, 거기에 로그인하는 순간 우리가 손대면 안 되는 실제 회원 데이터를 건드리게 된다. 알아채는 시점이 로그인 뒤라면 이미 늦다.

**하필 `registerSW.js`인 이유도 있다.** 레거시에도 정상적인 `sw.js`가 있고 서비스 워커도 등록한다. 그래서 `/sw.js`가 JavaScript인지 보는 것으로는 두 앱을 구분하지 못한다 — 잘못 배포돼도 통과한다. `registerSW.js`는 새 앱의 빌드만 내놓는 파일이라 이쪽이 판별에 쓸 수 있는 검사다.

### Then the rest

1. 로그인 화면이 뜬다.
2. 로그인한 뒤 훈련 상세처럼 안쪽 화면으로 들어가서 **새로고침**한다. 404가 아니라 그 화면이 다시 떠야 한다. 딥링크가 살아 있다는 뜻이다.
3. 주소창에 `/sw.js`를 직접 입력한다. **JavaScript 코드가 보여야 한다.** HTML이 보이면 리라이트가 서비스 워커를 삼킨 것이고, 이 경우 화면은 전부 멀쩡해 보이는데 오프라인과 푸시만 조용히 안 된다. (앞의 판별 검사와 목적이 다르다. 이쪽은 리라이트 설정을 본다.)
4. 공유 → 홈 화면에 추가. 아이콘과 이름이 TEAM EYSL로 잡히는지 본다.

## Step 6. Point production at `dev`

여기까지 왔으면 `main`이 배포돼 있다. 우리가 실제로 보고 싶은 것은 `dev`다.

```
Settings → Git → Production Branch → dev → Save
```

바꾼 뒤 Deployments 탭에서 최근 배포의 `⋯` → **Redeploy**를 누른다. 이후로는 `dev`에 머지될 때마다 자동으로 다시 배포된다.

`main`을 릴리스 라인으로 쓰기로 한 규칙은 그대로다. `main`에는 `chore/release-vX.Y.Z` PR로만 들어가고, 그때까지 실물로 확인할 대상은 `dev`다.

## What will not work after this deploy

**웹 푸시는 배포돼 있지만, 실제로 폰에 뜬 적은 아직 없다.** 발송 쪽 준비는 끝났다 — `push-notify` Edge Function이 올라가 있고, VAPID 키 쌍과 트리거 비밀값이 프로젝트 비밀값으로 등록돼 있고, 0022의 트리거가 함수를 부를 때 쓰는 금고 두 행도 들어가 있다. 비밀값 검사는 세 방향으로 몰아서 확인했다: 비밀값 없이 부르면 401, 틀린 값으로 부르면 401, 맞는 값으로 부르면 인증을 통과해 본문 검증까지 간다.

확인되지 않은 것은 그 다음 구간이다. **구독한 기기가 아직 하나도 없어서, 브라우저 구독부터 실제 알림이 뜨기까지를 끝까지 밟아본 적이 없다.** 이 배포에서 폰으로 알림 설정을 켜는 것이 그 첫 시도가 된다.

`VITE_VAPID_PUBLIC_KEY`를 Vercel에 넣지 않았다면 알림 설정 화면이 키가 없다고 표시하고 구독 자체가 시작되지 않는다.

iOS는 홈 화면에 추가한 뒤에야 알림을 허용한다. Step 5의 4번을 먼저 하고 알림을 켜야 한다.

## Troubleshooting

**흰 화면.** 환경변수가 빠졌거나 오타다. 브라우저 콘솔에 `Missing or invalid environment variables`가 찍힌다. 고친 뒤에는 재배포해야 한다.

**Preview 주소가 로그인 벽에 막힌다.** Deployment Protection이다. Step 5 첫 문단을 보라.

**폰에 새 배포가 반영되지 않는다.** 이전 서비스 워커가 캐시를 쥐고 있는 것이다. 앱을 완전히 종료했다 다시 연다. Vercel은 정적 파일을 기본적으로 `public, max-age=0, must-revalidate`로 내려주므로 `app/vercel.json`은 이 부분에 손대지 않는다. `/assets/` 아래는 해시가 붙어 내용이 바뀔 수 없으니 거기에만 장기 캐시를 건다.

**배포된 앱이 우리가 아는 화면과 다르다.** Root Directory를 확인한다. 레거시 `index.html`이 올라간 것이라면 즉시 배포를 지우고 Step 2부터 다시 한다.

## References

- `app/vercel.json` — SPA rewrite(`/(.*)` → `/index.html`)와 `/assets/` 장기 캐시. Vercel은 rewrite보다 파일 시스템을 먼저 보므로 빌드가 내놓은 파일은 저마다 알아서 이긴다. 제외 목록을 손으로 관리하지 않는 이유다.
- `app/src/lib/env.ts:20-44` — 환경변수 검증과 운영 프로젝트 차단
- `.env.example` — 변수별 설명과 VAPID 키 쌍 생성법
- `.github/workflows/guard.yml` — 커밋된 비밀값과 운영 프로젝트 참조를 막는 CI 검사
- [Vercel: rewrites](https://vercel.com/docs/project-configuration/vercel-json#rewrites) — "precedence is given to the filesystem prior to rewrites being applied"
