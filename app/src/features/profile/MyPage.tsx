import { useRef, useState, type ChangeEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { MemberAvatar } from '../members/MemberAvatar'
import { ROLE_LABEL } from '../members/api'
import { supabase } from '../../lib/supabase'
import {
  getMyProfile,
  removeMyAvatar,
  setMyRealName,
  uploadMyAvatar,
  validateAvatarFile,
  type MyProfile,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const BUTTON = {
  minHeight: 44,
  padding: '0 14px',
  borderRadius: 13,
  fontSize: 13,
  border: '1px solid #e1e5ea',
  background: '#fff',
  color: '#111317',
} as const

type SaveKind = 'idle' | 'saving' | 'saved' | 'error'

export function MyPage() {
  const query = useQuery({ queryKey: ['my-profile'], queryFn: getMyProfile })

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: '0 0 16px' }}>마이페이지</h1>

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

      <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '24px 0 9px' }}>
        내 메뉴
      </h2>
      <nav style={{ display: 'grid', gap: 9 }}>
        <Tile to="/records" title="나의 기록" desc="개인 최고 기록과 변화" />
        <Tile to="/schedule/mine" title="나의 대회 신청 내역" desc="신청한 대회와 지난 참가 기록" />
        <Tile to="/attendance" title="출석 현황" desc="출석·지각 기록 보기" />
        <Tile to="/events" title="이벤트" desc="출석왕·지각왕·기록 단축왕" />
      </nav>

      <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '24px 0 9px' }}>설정</h2>
      <nav style={{ display: 'grid', gap: 9 }}>
        <Tile to="/settings/notifications" title="푸시 알림" desc="이 기기로 알림 받기" />
      </nav>

      <button
        onClick={() => void supabase.auth.signOut()}
        style={{ ...BUTTON, width: '100%', marginTop: 18 }}
      >
        로그아웃
      </button>
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
    <section style={{ ...CARD, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <MemberAvatar
          member={{ nickname: profile.nickname, short_name: null, avatar_url: profile.avatar_url }}
          size={56}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 16 }}>{profile.nickname}</b>
          <p style={{ fontSize: 11, color: '#6b7178', margin: '3px 0 0' }}>
            {ROLE_LABEL[profile.role]}
          </p>
        </div>
        <SaveState state={state} />
      </div>

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        <button onClick={() => inputRef.current?.click()} disabled={busy} style={BUTTON}>
          프로필 사진 변경
        </button>
        {profile.avatar_path && (
          <button
            onClick={() => {
              if (window.confirm('프로필 사진을 삭제할까요?')) remove.mutate()
            }}
            disabled={busy}
            style={{ ...BUTTON, borderColor: '#925900', color: '#925900', background: '#fff0d6' }}
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
        <p role="alert" style={{ color: '#a33', fontSize: 12, margin: 0 }}>
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
    <section style={{ ...CARD, marginTop: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 9,
          marginBottom: 10,
        }}
      >
        <h2 style={{ fontSize: 14, margin: 0 }}>기록 연동</h2>
        <SaveState state={state} onRetry={() => save.mutate()} />
      </div>

      <div style={{ display: 'flex', gap: 7 }}>
        <input
          aria-label="본인 실명"
          placeholder="본인 실명"
          maxLength={30}
          autoComplete="name"
          value={realName}
          onChange={(e) => setRealName(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 44,
            padding: 12,
            borderRadius: 13,
            border: '1px solid #e1e5ea',
            fontSize: 14,
          }}
        />
        <button
          onClick={() => save.mutate()}
          disabled={disabled}
          style={{
            ...BUTTON,
            border: 0,
            background: disabled ? '#e1e5ea' : '#11805b',
            color: disabled ? '#6b7178' : '#fff',
          }}
        >
          저장
        </button>
      </div>

      <p style={{ fontSize: 12, color: '#6b7178', margin: '10px 0 0', lineHeight: 1.6 }}>
        대회 결과지는 실명으로 기록을 찾습니다. 실명을 넣지 않으면 본인 기록이 자동으로 연결되지
        않아요.
      </p>

      {!profile.real_name && (
        <p
          style={{
            fontSize: 12,
            margin: '10px 0 0',
            padding: '8px 10px',
            borderRadius: 12,
            background: '#fff0d6',
            color: '#925900',
          }}
        >
          아직 실명을 등록하지 않으셨어요.
        </p>
      )}

      {error && (
        <p role="alert" style={{ color: '#a33', fontSize: 12, margin: '10px 0 0' }}>
          {error}
        </p>
      )}
    </section>
  )
}

function Tile({ to, title, desc }: { to: string; title: string; desc: string }) {
  return (
    <Link
      to={to}
      style={{
        display: 'block',
        padding: 14,
        minHeight: 44,
        border: '1px solid #e1e5ea',
        borderRadius: 18,
        background: '#fff',
        textDecoration: 'none',
        color: '#111317',
      }}
    >
      <b style={{ fontSize: 14 }}>{title}</b>
      <p style={{ fontSize: 11, color: '#6b7178', margin: '4px 0 0' }}>{desc}</p>
    </Link>
  )
}
