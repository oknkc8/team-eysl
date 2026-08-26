import { Link, useParams } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { MemberAvatar } from '../members/MemberAvatar'
import { useRosterById } from './ChatPage'
import { Composer, ConnectionNotice } from './Composer'
import { MessageThread } from './MessageThread'
import { useChatRoom } from './useChatRoom'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

/**
 * One 1:1 conversation.
 *
 * Only this half of chat gets a route of its own, so a conversation can be
 * linked to and reopened. Which member it is comes from the URL rather than
 * from state left behind by the list, which is what the legacy app relied on
 * (`currentDm`, a module-level nickname string).
 */
export function DmPage() {
  const { memberId = '' } = useParams()
  const { user } = useCurrentUser()

  // RequireAuth holds this screen until the member row has loaded.
  if (!user) return null

  return (
    <div className="page">
      <Link to="/chat" className="backLink">
        ← 채팅
      </Link>

      {/* send_message_v1() refuses a dm addressed to the sender, so this screen
          would be a composer whose every send fails. Saying so is better than
          offering it. */}
      {memberId === user.id ? (
        <div style={{ ...CARD, marginTop: 12, color: '#6b7178', fontSize: 13 }}>
          자기 자신과는 대화할 수 없습니다.
        </div>
      ) : (
        <Conversation myMemberId={user.id} otherMemberId={memberId} />
      )}
    </div>
  )
}

function Conversation({
  myMemberId,
  otherMemberId,
}: {
  myMemberId: string
  otherMemberId: string
}) {
  const room = useChatRoom({ room: { kind: 'dm', otherMemberId }, myMemberId })
  const roster = useRosterById()
  const other = roster.get(otherMemberId)

  return (
    <div>
      <div style={{ ...CARD, marginTop: 12, display: 'flex', alignItems: 'center', gap: 11 }}>
        {other ? (
          <>
            <MemberAvatar member={other} />
            <div>
              <h1 style={{ fontSize: 18, letterSpacing: -0.6, margin: 0 }}>{other.nickname}</h1>
              {other.team_role && (
                <p style={{ fontSize: 11, color: '#6b7178', margin: '3px 0 0' }}>
                  {other.team_role}
                </p>
              )}
            </div>
          </>
        ) : (
          // The roster is still loading, or this member is no longer approved —
          // member_public_v lists only approved members. Either way the thread
          // below is still theirs to read.
          <h1 style={{ fontSize: 18, letterSpacing: -0.6, margin: 0, color: '#6b7178' }}>
            1:1 대화
          </h1>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <ConnectionNotice status={room.status} onRefresh={room.query.refetch} />

        <div style={{ ...CARD, minHeight: 240 }}>
          <AsyncSection
            query={room.query}
            isEmpty={(messages) => messages.length === 0}
            loading={<Shimmer rows={4} />}
            empty="아직 주고받은 메시지가 없습니다"
            error="메시지를 불러오지 못했습니다"
          >
            {(messages) => (
              <MessageThread
                messages={messages}
                myMemberId={myMemberId}
                roster={roster}
                onRetry={room.retry}
                onDismiss={room.dismiss}
              />
            )}
          </AsyncSection>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <Composer
          onSend={room.send}
          saveState={room.saveState}
          placeholder={other ? `${other.nickname}님에게 보내기` : '메시지 보내기'}
        />
      </div>
    </div>
  )
}
