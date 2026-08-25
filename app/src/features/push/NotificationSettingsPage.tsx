import { useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { useCurrentUser } from '../auth/useCurrentUser'
import { disablePush, enablePush, forgetDevice, readPushStatus, type PushDevice } from './api'
import { describeDevice, type PushState } from './support'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const DATE_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
})

/**
 * How each state is worded, and what can be done about it.
 *
 * One table rather than a chain of conditionals in the markup, because the
 * point of this screen is that it never says 알림 받는 중 unless that is true —
 * and a rule kept in one place is a rule that can be read.
 */
const STATE_COPY: Record<
  PushState,
  { title: string; detail: string; tone: 'on' | 'off' | 'warn'; action: 'enable' | 'disable' | null }
> = {
  on: {
    title: '이 기기에서 알림 받는 중',
    detail: '공지·일정·채팅 알림이 이 기기로 전송됩니다.',
    tone: 'on',
    action: 'disable',
  },
  off: {
    title: '알림 꺼짐',
    detail: '알림을 켜면 이 기기로 새 소식을 받아볼 수 있습니다.',
    tone: 'off',
    action: 'enable',
  },
  'needs-repair': {
    title: '알림 등록이 만료됐습니다',
    detail: '이 기기의 구독 정보가 서버에 저장된 것과 다릅니다. 다시 등록해야 알림이 도착합니다.',
    tone: 'warn',
    action: 'enable',
  },
  blocked: {
    title: '알림이 차단돼 있습니다',
    detail:
      '브라우저나 기기 설정에서 TEAM EYSL 알림을 허용한 뒤 이 화면으로 돌아와주세요. 앱에서는 다시 물어볼 수 없습니다.',
    tone: 'warn',
    action: null,
  },
  'needs-install': {
    title: '홈 화면에 추가해주세요',
    detail:
      '아이폰·아이패드는 홈 화면에 추가한 TEAM EYSL 앱에서만 알림을 받을 수 있습니다. 공유 버튼에서 "홈 화면에 추가"를 눌러주세요.',
    tone: 'warn',
    action: null,
  },
  unsupported: {
    title: '이 기기에서는 알림을 지원하지 않습니다',
    detail: '다른 브라우저나 기기에서 알림을 켜면 그 기기로 받아볼 수 있습니다.',
    tone: 'off',
    action: null,
  },
  unconfigured: {
    title: '알림이 아직 설정되지 않았습니다',
    detail: '이 빌드에 알림 공개 키(VITE_VAPID_PUBLIC_KEY)가 없습니다. 관리자에게 알려주세요.',
    tone: 'warn',
    action: null,
  },
}

const TONE = {
  on: { background: '#edf7f2', color: '#11805b' },
  warn: { background: '#fff0d6', color: '#925900' },
  off: { background: '#eef0f2', color: '#6b7178' },
} as const

export function NotificationSettingsPage() {
  const { user } = useCurrentUser()
  const qc = useQueryClient()
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [problem, setProblem] = useState<string | null>(null)
  // Reported rather than swallowed: the row is gone so notifications have
  // stopped, but the browser still holds an endpoint, and a member who later
  // wonders why 알림 끄기 left something behind deserves to have been told.
  const [endpointLingers, setEndpointLingers] = useState(false)

  const memberId = user?.id ?? ''
  const query = useQuery({
    queryKey: ['push-status', memberId],
    queryFn: () => readPushStatus(memberId),
    enabled: memberId !== '',
    // Read fresh every visit. The browser can drop a subscription at any time
    // and a cached 알림 받는 중 is exactly the lie this screen must not tell.
    staleTime: 0,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['push-status', memberId] })

  const toggle = useMutation({
    mutationFn: async (next: 'enable' | 'disable') => {
      if (next === 'disable') return disablePush(memberId)
      await enablePush(memberId)
      return { browserUnsubscribed: true }
    },
    onMutate: () => {
      setState('saving')
      setProblem(null)
      setEndpointLingers(false)
    },
    onSuccess: async (outcome) => {
      setEndpointLingers(!outcome.browserUnsubscribed)
      setState('saved')
      await refresh()
    },
    onError: (error: Error) => {
      setProblem(error.message)
      setState('error')
    },
  })

  const remove = useMutation({
    mutationFn: forgetDevice,
    onMutate: () => {
      setState('saving')
      setProblem(null)
    },
    onSuccess: async () => {
      setState('saved')
      await refresh()
    },
    onError: (error: Error) => {
      setProblem(error.message)
      setState('error')
    },
  })

  if (!user) return null

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <Link to="/" style={{ fontSize: 12, color: '#6b7178', textDecoration: 'none' }}>
        ← 홈
      </Link>
      <h1 style={{ fontSize: 26, letterSpacing: -1.2, margin: '12px 0 0' }}>알림 설정</h1>

      <div style={{ marginTop: 16 }}>
        <AsyncSection
          query={query}
          loading={<Shimmer rows={2} />}
          error="알림 상태를 확인하지 못했습니다"
        >
          {(status) => {
            const copy = STATE_COPY[status.state]
            const action = copy.action
            return (
              <>
                <section style={CARD}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '4px 10px',
                      borderRadius: 999,
                      fontSize: 12,
                      ...TONE[copy.tone],
                    }}
                  >
                    {copy.title}
                  </span>
                  <p style={{ fontSize: 13, color: '#6b7178', lineHeight: 1.7, margin: '11px 0 0' }}>
                    {copy.detail}
                  </p>

                  {action && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        flexWrap: 'wrap',
                        marginTop: 14,
                      }}
                    >
                      <button
                        onClick={() => toggle.mutate(action)}
                        disabled={state === 'saving'}
                        style={{
                          minHeight: 44,
                          padding: '0 18px',
                          borderRadius: 13,
                          border: action === 'disable' ? '1px solid #a33' : 'none',
                          background: action === 'disable' ? '#fff' : '#111317',
                          color: action === 'disable' ? '#a33' : '#fff',
                          fontSize: 13,
                        }}
                      >
                        {action === 'disable'
                          ? '알림 끄기'
                          : status.state === 'needs-repair'
                            ? '다시 등록'
                            : '알림 켜기'}
                      </button>
                      <SaveState state={state} />
                    </div>
                  )}

                  {/* The browser's own refusal, specific enough to act on:
                      알림 권한이 허용되지 않았습니다 and 앱 준비가 끝나지
                      않았습니다 call for different things from the member. */}
                  {problem && (
                    <p style={{ fontSize: 12, color: '#a33', margin: '11px 0 0', lineHeight: 1.6 }}>
                      {problem}
                    </p>
                  )}
                  {endpointLingers && (
                    <p
                      style={{ fontSize: 12, color: '#925900', margin: '11px 0 0', lineHeight: 1.6 }}
                    >
                      서버 등록은 지웠지만 브라우저 구독이 남아 있습니다. 브라우저 알림 설정에서
                      직접 해제해주세요.
                    </p>
                  )}
                </section>

                <DeviceList
                  devices={status.devices}
                  busy={state === 'saving'}
                  onForget={(device) => {
                    const name = describeDevice(device.user_agent)
                    if (!window.confirm(`${name} 기기의 알림 등록을 지울까요?`)) return
                    remove.mutate(device.id)
                  }}
                />
              </>
            )
          }}
        </AsyncSection>
      </div>

      {/* Said on the page, not only in a commit message. A member who turns
          notifications on and then receives none should learn why here. */}
      <p style={{ fontSize: 11, color: '#6b7178', lineHeight: 1.7, margin: '18px 2px 0' }}>
        지금은 알림을 보내는 서버가 아직 준비되지 않았습니다. 이 화면에서 등록해두면 서버가
        준비되는 대로 이 기기로 알림이 도착합니다.
      </p>
    </div>
  )
}

function DeviceList({
  devices,
  onForget,
  busy,
}: {
  devices: PushDevice[]
  onForget: (device: PushDevice) => void
  busy: boolean
}) {
  return (
    <section style={{ marginTop: 16 }}>
      <h2 style={{ fontSize: 14, margin: '0 2px 9px' }}>등록된 기기 {devices.length}개</h2>

      {devices.length === 0 ? (
        <p style={{ ...CARD, fontSize: 13, color: '#6b7178', margin: 0 }}>
          아직 등록된 기기가 없습니다.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
          {devices.map((device) => (
            <li
              key={device.id}
              style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}
            >
              <div style={{ flex: 1, minWidth: 160 }}>
                <b style={{ fontSize: 13 }}>{describeDevice(device.user_agent)}</b>
                {device.isThisDevice && (
                  <span
                    style={{
                      marginLeft: 7,
                      padding: '2px 8px',
                      borderRadius: 999,
                      fontSize: 11,
                      ...TONE.on,
                    }}
                  >
                    이 기기
                  </span>
                )}
                <p style={{ fontSize: 11, color: '#6b7178', margin: '5px 0 0' }}>
                  {DATE_FORMAT.format(new Date(device.updated_at))} 등록
                </p>
              </div>
              <button
                onClick={() => onForget(device)}
                disabled={busy}
                style={{
                  minHeight: 44,
                  padding: '0 14px',
                  borderRadius: 13,
                  border: '1px solid #e1e5ea',
                  background: '#fff',
                  color: '#a33',
                  fontSize: 12,
                }}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
