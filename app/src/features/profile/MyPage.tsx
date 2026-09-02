import { useRef, useState, type ChangeEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { MemberAvatar } from '../members/MemberAvatar'
import { MyAchievements } from '../achievements/MyAchievements'
import { ROLE_LABEL } from '../members/api'
import { supabase } from '../../lib/supabase'
import { viewerKey } from '../../lib/queryKeys'
import { useSession } from '../auth/SessionProvider'
import {
  getMyProfile,
  removeMyAvatar,
  setMyRealName,
  uploadMyAvatar,
  validateAvatarFile,
  type MyProfile,
} from './api'

type SaveKind = 'idle' | 'saving' | 'saved' | 'error'

export function MyPage() {
  const { session } = useSession()
  const query = useQuery({
    queryKey: viewerKey(['my-profile'], session?.user.id),
    queryFn: getMyProfile,
  })

  return (
    <div className="page">
      <h1 className="title">마이페이지</h1>

      <AsyncSection
        query={query}
        loading={<Shimmer rows={3} />}
        error="내 정보를 불러오지 못했습니다"
      >
        {(profile) => <Profile profile={profile} />}
      </AsyncSection>
    </div>
  )
}

function Profile({ profile }: { profile: MyProfile }) {
  return (
    <>
      <PhotoCard profile={profile} />
      <RealNameCard profile={profile} />

      {/* Above 내 메뉴, where he puts it (upstream:1289-1292): the badges are
          the reason to open 마이페이지, and a list of links is not. It fetches
          on its own, so a failed achievements call cannot blank the profile. */}
      <MyAchievements />

      <h2 className="listDivider">내 메뉴</h2>
      <nav className="list">
        <Tile to="/records" title="나의 기록" desc="개인 최고 기록과 변화" />
        <Tile to="/schedule/mine" title="나의 대회 신청 내역" desc="신청한 대회와 지난 참가 기록" />
        <Tile to="/attendance" title="출석 현황" desc="출석·지각 기록 보기" />
        <Tile to="/activity" title="월간 활동 요약" desc="달마다 훈련·대회·출석률" />
        {/* 반기 회비와 세션 참가비는 성격이 달라 화면 안에서 두 묶음으로 나뉘어
            있다. 여기서는 한 줄로 안내한다. */}
        <Tile to="/dues" title="내 회비" desc="반기 회비와 세션 참가비 납부 기록" />
        <Tile to="/events" title="이벤트" desc="출석왕·지각왕·기록 단축왕" />
      </nav>

      <h2 className="listDivider">설정</h2>
      <nav className="list">
        <Tile to="/settings/notifications" title="푸시 알림" desc="이 기기로 알림 받기" />
      </nav>

      <div className="actions">
        <button onClick={() => void supabase.auth.signOut()} className="btn outline">
          로그아웃
        </button>
      </div>
    </>
  )
}

/**
 * 프로필 사진.
 *
 * The refusal for an oversized or non-image file is raised before the upload
 * starts, so a member on a phone is not left watching a progress bar for a file
 * that was never going to be accepted.
 */
function PhotoCard({ profile }: { profile: MyProfile }) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<SaveKind>('idle')
  const [error, setError] = useState<string | null>(null)

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['my-profile'] })
    // The same face appears on every roster-shaped screen.
    await qc.invalidateQueries({ queryKey: ['roster'] })
    await qc.invalidateQueries({ queryKey: ['me'] })
  }

  const upload = useMutation({
    mutationFn: (file: File) => uploadMyAvatar({ memberId: profile.id, file }),
    onMutate: () => {
      setError(null)
      setState('saving')
    },
    onSuccess: async () => {
      setState('saved')
      await invalidate()
    },
    onError: (cause: Error) => {
      setError(cause.message || '프로필 사진 업로드에 실패했습니다.')
      setState('error')
    },
  })

  const remove = useMutation({
    mutationFn: removeMyAvatar,
    onMutate: () => {
      setError(null)
      setState('saving')
    },
    onSuccess: async () => {
      setState('saved')
      await invalidate()
    },
    onError: () => {
      setError('프로필 사진 삭제에 실패했습니다.')
      setState('error')
    },
  })

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Cleared so picking the same file twice still fires a change event.
    e.target.value = ''
    if (!file) return

    const refusal = validateAvatarFile(file)
    if (refusal) {
      setError(refusal)
      setState('error')
      return
    }
    upload.mutate(file)
  }

  const busy = state === 'saving'

  return (
    <section>
      <div className="profile">
        <MemberAvatar
          member={{ nickname: profile.nickname, short_name: null, avatar_url: profile.avatar_url }}
          size={56}
        />
        <div className="grow">
          <b>{profile.nickname}</b>
          <p>{ROLE_LABEL[profile.role]}</p>
        </div>
        <SaveState state={state} />
      </div>

      <div className="actions">
        <button onClick={() => inputRef.current?.click()} disabled={busy} className="btn outline">
          프로필 사진 변경
        </button>
        {profile.avatar_path && (
          <button
            onClick={() => {
              if (window.confirm('프로필 사진을 삭제할까요?')) remove.mutate()
            }}
            disabled={busy}
            className="btn amber"
          >
            사진 삭제
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          hidden
          onChange={onPick}
        />
      </div>

      {error && (
        <p role="alert" className="authMsg error">
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * 기록 연동 — his own heading for this card (upstream:1124).
 *
 * The sentence under the field is the point. `matchRealName`
 * (records/parser/roster.ts) compares the name printed on a result sheet against
 * this column exactly, and members without a 실명 never enter the roster it
 * searches — so a swimmer who leaves this blank watches their own times land as
 * unmatched rows somebody else has to resolve. Nothing on his screen says so,
 * and a member has no way to guess it.
 */
function RealNameCard({ profile }: { profile: MyProfile }) {
  const qc = useQueryClient()
  const [realName, setRealName] = useState(profile.real_name ?? '')
  const [state, setState] = useState<SaveKind>('idle')
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => setMyRealName(realName.trim()),
    onMutate: () => {
      setError(null)
      setState('saving')
    },
    onSuccess: async () => {
      setState('saved')
      await qc.invalidateQueries({ queryKey: ['my-profile'] })
      await qc.invalidateQueries({ queryKey: ['me'] })
    },
    onError: (cause: { message?: string }) => {
      // set_my_real_name_v1 raises in Korean, so its message is showable as-is.
      setError(cause.message || '실명 저장에 실패했습니다.')
      setState('error')
    },
  })

  const unchanged = realName.trim() === (profile.real_name ?? '').trim()
  const disabled = state === 'saving' || unchanged

  return (
    <section className="card realNameCard">
      <div className="cardHead">
        <h2>기록 연동</h2>
        <SaveState state={state} onRetry={() => save.mutate()} />
      </div>

      <div className="realNameRow">
        <input
          className="field"
          aria-label="본인 실명"
          placeholder="본인 실명"
          maxLength={30}
          autoComplete="name"
          value={realName}
          onChange={(e) => setRealName(e.target.value)}
        />
        <button onClick={() => save.mutate()} disabled={disabled} className="btn primary">
          저장
        </button>
      </div>

      <p className="fieldNote">
        대회 결과지는 실명으로 기록을 찾습니다. 실명을 넣지 않으면 본인 기록이 자동으로 연결되지
        않아요.
      </p>

      {!profile.real_name && <p className="authMsg warn">아직 실명을 등록하지 않으셨어요.</p>}

      {error && (
        <p role="alert" className="authMsg error">
          {error}
        </p>
      )}
    </section>
  )
}

function Tile({ to, title, desc }: { to: string; title: string; desc: string }) {
  return (
    <Link to={to} className="row">
      <div className="grow">
        <b>{title}</b>
        <p>{desc}</p>
      </div>
    </Link>
  )
}
