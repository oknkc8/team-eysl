import type { RosterMember } from './api'

type Identity = Pick<RosterMember, 'nickname' | 'short_name' | 'avatar_url'>

// short_name is the club's own abbreviation and is the better initial where it
// exists; the nickname's first character is the fallback. Spread rather than
// slice(0, 1) so an emoji or a surrogate pair is not cut in half.
function initial(member: Pick<RosterMember, 'nickname' | 'short_name'>): string {
  const source = member.short_name?.trim() || member.nickname.trim()
  return [...source][0] ?? '?'
}

/**
 * A face, or the initial standing in for one.
 *
 * Both branches occupy the same box, so a roster where half the club has
 * uploaded a photo still reads as one tidy column. The initial is not a
 * placeholder waiting for an image — signAvatars() gives up quietly on a path
 * it cannot sign, so this is frequently the final rendering.
 */
export function MemberAvatar({ member, size = 44 }: { member: Identity; size?: number }) {
  const box = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    objectFit: 'cover',
  } as const

  // Empty alt, not the nickname: the name is already beside it in every caller,
  // so announcing it twice only makes the row longer to listen to.
  if (member.avatar_url) return <img src={member.avatar_url} alt="" style={box} />

  return (
    <div
      aria-hidden="true"
      style={{
        ...box,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#eef0f2',
        color: '#6b7178',
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initial(member)}
    </div>
  )
}
