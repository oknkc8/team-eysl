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
3. Production Branch는 `dev`로 둔다. `main`은 릴리스 라인이라 지금은 올릴 게 없다.

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

Environment는 **Production, Preview, Development 세 개 모두** 체크한다. 빠뜨린 환경은 잘못된 프로젝트를 가리킨다는 친절한 에러를 내지 않는다. `app/src/lib/env.ts:22-28`의 zod 검증이 그냥 throw하고, 화면에는 빌드가 깨진 것처럼 보인다. 원인과 증상이 닮은 구석이 없어서 한참 헤매게 되는 종류의 실패다.

### What must never go into Vercel

`VITE_VAPID_PUBLIC_KEY`는 Vercel에 넣는 게 맞다. 공개키라서 어차피 브라우저가 push 서비스에 그대로 보낸다.

넣으면 안 되는 것은 VAPID **개인키**, 그리고 이름을 무엇으로 붙이든 service role 키다. 둘 다 Supabase 쪽에만 있어야 한다. 특히 `VITE_` 접두어를 붙이면 최악인데, Vite가 그 값을 번들 안에 문자열로 박아서 앱을 여는 모든 사람에게 배포하기 때문이다. 숨겨진 설정값이 아니라 공개된 파일 내용이 된다.

### These are baked in at build time, not read at runtime

`VITE_` 변수는 빌드할 때 번들 안에 문자열로 박힌다. 실행 중에 읽어오는 값이 아니다. 여기서 따라오는 결과가 둘 있다.

- 값을 고쳤으면 **재배포해야 반영된다.** 환경변수만 저장하고 넘어가면 배포된 앱은 옛날 값을 계속 쓴다.
- 변수를 빠뜨려도 **빌드는 성공한다.** Vercel 로그는 초록불인데 앱만 흰 화면인 상태가 되고 원인은 브라우저 콘솔에만 `Missing or invalid environment variables: ...` 형태로 남는다.

### Never point this at the president's project

`VITE_SUPABASE_URL`에는 반드시 우리 dev 프로젝트 주소를 넣는다. 회장님 프로젝트를 넣으면 `app/src/lib/env.ts:35-44`가 앱 시작 시점에 거부해서 화면이 뜨지 않는다. 다만 이건 마지막 안전장치이지 확인 절차가 아니다. 값 자체를 처음부터 우리 것으로 넣어야 한다.

## Step 4. Deploy

Deploy를 누르고 기다린다. 로컬 기준 빌드 자체는 200ms 남짓이고 의존성 설치까지 합쳐도 대개 2분 안에 끝난다.

## Step 5. Verify on the phone

**폰에서 열 주소는 Production 별칭이어야 한다.** Vercel의 Deployment Protection은 기본적으로 preview 주소에 Vercel 로그인을 요구한다. 커밋마다 생기는 preview 링크를 폰에서 열면 앱이 아니라 Vercel 로그인 화면을 보게 된다. Production 별칭을 쓰거나, 이 프로젝트의 preview 보호를 Settings → Deployment Protection에서 꺼라.

주소를 열고 순서대로 확인한다.

1. 로그인 화면이 뜬다.
2. 로그인한 뒤 훈련 상세처럼 안쪽 화면으로 들어가서 **새로고침**한다. 404가 아니라 그 화면이 다시 떠야 한다. 딥링크가 살아 있다는 뜻이다.
3. 주소창에 `/sw.js`를 직접 입력한다. **JavaScript 코드가 보여야 한다.** HTML이 보이면 서비스 워커가 죽은 것이고 이 경우 화면은 전부 멀쩡해 보이는데 오프라인과 푸시만 조용히 안 된다.
4. 공유 → 홈 화면에 추가. 아이콘과 이름이 TEAM EYSL로 잡히는지 본다.

## What will not work after this deploy

**웹 푸시 알림은 오지 않는다.** 알림을 실제로 발송하는 `push-notify` Edge Function과 VAPID 개인키는 Vercel이 아니라 Supabase 쪽에 올라가야 한다. 그건 이 배포와 별개 작업이라 알림 설정 화면에서 구독은 등록되지만 받는 알림은 없다.

## Troubleshooting

**흰 화면.** 환경변수가 빠졌거나 오타다. 브라우저 콘솔에 `Missing or invalid environment variables`가 찍힌다. 고친 뒤에는 재배포해야 한다.

**Preview 주소가 로그인 벽에 막힌다.** Deployment Protection이다. Step 5 첫 문단을 보라.

**폰에 새 배포가 반영되지 않는다.** 이전 서비스 워커가 캐시를 쥐고 있는 것이다. 앱을 완전히 종료했다 다시 연다. Vercel은 정적 파일을 기본적으로 `public, max-age=0, must-revalidate`로 내려주므로 `app/vercel.json`은 이 부분에 손대지 않는다. 해시가 붙어 내용이 바뀔 수 없는 `/assets/` 아래에만 장기 캐시를 건다.

**배포된 앱이 우리가 아는 화면과 다르다.** Root Directory를 확인한다. 레거시 `index.html`이 올라간 것이라면 즉시 배포를 지우고 Step 2부터 다시 한다.

## References

- `app/vercel.json` — SPA rewrite(`/(.*)` → `/index.html`)와 `/assets/` 장기 캐시. Vercel은 rewrite보다 파일 시스템을 먼저 보므로 빌드가 내놓은 파일은 저마다 알아서 이긴다. 제외 목록을 손으로 관리하지 않는 이유가 이것이다.
- `app/src/lib/env.ts:20-44` — 환경변수 검증과 운영 프로젝트 차단
- `.env.example` — 변수별 설명과 VAPID 키 쌍 생성법
- `.github/workflows/guard.yml` — 커밋된 비밀값과 운영 프로젝트 참조를 막는 CI 검사
- [Vercel: rewrites](https://vercel.com/docs/project-configuration/vercel-json#rewrites) — "precedence is given to the filesystem prior to rewrites being applied"
