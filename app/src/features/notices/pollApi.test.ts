import { describe, expect, it } from 'vitest'

import {
  canVote,
  isPollClosed,
  nextSelection,
  toPoll,
  votersFor,
  type Poll,
} from './pollApi'

// A payload shaped the way get_notice_poll_v1 builds one. Written as `unknown`
// rather than as a Poll on purpose: toPoll's whole job is to be the boundary
// between what arrived and what the screen may use, and typing the input as the
// output would assume the thing under test.
function payload(over: Record<string, unknown> = {}): unknown {
  return {
    id: 'poll-1',
    notice_id: 'notice-1',
    title: '이번 주 훈련 요일',
    option_kind: 'text',
    allow_multiple: false,
    anonymous: false,
    allow_option_add: false,
    closes_at: null,
    is_closed: false,
    total_voters: 2,
    can_manage: false,
    can_add_option: false,
    options: [
      { id: 'opt-a', label: '토요일', count: 2, voters: ['김수영', '박자유'] },
      { id: 'opt-b', label: '일요일', count: 0, voters: [] },
    ],
    my_option_ids: ['opt-a'],
    ...over,
  }
}

function parsed(over: Record<string, unknown> = {}): Poll {
  const poll = toPoll(payload(over))
  if (!poll) throw new Error('fixture did not parse')
  return poll
}

// noUncheckedIndexedAccess is on, so an index is PollOption | undefined. This
// narrows it by FAILING when the option is missing rather than by casting: an
// assertion about voters that quietly ran against undefined would pass for the
// wrong reason, which is the whole family of defect this file is guarding.
function optionAt(poll: Poll, index: number) {
  const option = poll.options[index]
  if (!option) throw new Error(`fixture has no option at ${index}`)
  return option
}

// ===========================================================================
// THE CLOSING-TIME RULE
// ===========================================================================
//
// The database is where this is enforced — cast_notice_poll_vote_v1 reads the
// poll `for update` and compares closes_at to now(). These assertions cover the
// client's mirror of it, which decides whether the vote control is drawn.
describe('isPollClosed', () => {
  it('never closes a poll with no deadline', () => {
    expect(isPollClosed({ closes_at: null }, new Date('2099-01-01T00:00:00Z'))).toBe(false)
  })

  it('is open a second before the deadline', () => {
    expect(
      isPollClosed({ closes_at: '2026-09-04T12:00:00Z' }, new Date('2026-09-04T11:59:59Z')),
    ).toBe(false)
  })

  // `<=`, matching the SQL. A vote cast in the same instant the poll closes is
  // refused by the database, so the screen must not offer it either.
  it('is closed AT the deadline, not merely after it', () => {
    expect(
      isPollClosed({ closes_at: '2026-09-04T12:00:00Z' }, new Date('2026-09-04T12:00:00Z')),
    ).toBe(true)
  })

  it('is closed after the deadline', () => {
    expect(
      isPollClosed({ closes_at: '2026-09-04T12:00:00Z' }, new Date('2026-09-04T12:00:01Z')),
    ).toBe(true)
  })

  // Fails OPEN, and deliberately: the server refuses a vote on a poll that has
  // really closed, so a screen that guesses wrong here shows a button and gets
  // a refusal. Guessing the other way hides the control on a poll that is fine.
  it('treats an unparseable deadline as no deadline', () => {
    expect(isPollClosed({ closes_at: 'not a date' }, new Date('2099-01-01T00:00:00Z'))).toBe(false)
  })
})

describe('canVote', () => {
  const beforeDeadline = new Date('2026-09-04T11:00:00Z')
  const afterDeadline = new Date('2026-09-04T13:00:00Z')

  it('offers the control on an open poll', () => {
    expect(canVote(parsed({ closes_at: '2026-09-04T12:00:00Z' }), beforeDeadline)).toBe(true)
  })

  // The server's verdict alone. A member who left the page open past the
  // deadline holds a payload that said is_closed:false when it was fetched.
  it('closes the control once the local clock passes the deadline', () => {
    expect(canVote(parsed({ closes_at: '2026-09-04T12:00:00Z' }), afterDeadline)).toBe(false)
  })

  // The other direction: the server says closed, the payload carries no
  // deadline the client can check. Its word is still final.
  it('honours is_closed even with no deadline to compare against', () => {
    expect(canVote(parsed({ is_closed: true, closes_at: null }), beforeDeadline)).toBe(false)
  })
})

// ===========================================================================
// THE ANONYMITY RULE
// ===========================================================================
//
// 0055 already returns voters:null for an anonymous poll. These assertions cover
// the client's refusal to surface names anyway — the case where a payload
// arrives carrying identities it should not have.
describe('anonymity', () => {
  it('keeps the voter list on a poll that is not anonymous', () => {
    const poll = parsed()
    expect(optionAt(poll, 0).voters).toEqual(['김수영', '박자유'])
    expect(votersFor(poll, optionAt(poll, 0))).toEqual(['김수영', '박자유'])
  })

  it('drops the voter list when the poll is anonymous', () => {
    const poll = parsed({ anonymous: true })
    expect(optionAt(poll, 0).voters).toBeNull()
    expect(votersFor(poll, optionAt(poll, 0))).toBeNull()
  })

  // THE ONE THAT MATTERS. The payload is anonymous AND carries names — an older
  // deployment of the RPC, a stubbed response, anything that got the branch
  // wrong. The names must not reach the screen regardless of who sent them.
  it('drops names that arrive on an anonymous poll anyway', () => {
    const poll = parsed({
      anonymous: true,
      options: [{ id: 'opt-a', label: '토요일', count: 2, voters: ['김수영', '박자유'] }],
    })

    expect(optionAt(poll, 0).voters).toBeNull()
    expect(votersFor(poll, optionAt(poll, 0))).toBeNull()
    // And not merely absent from the array — absent from the whole parsed poll,
    // so no other read path can find them either.
    expect(JSON.stringify(poll)).not.toContain('김수영')
  })

  // Counts survive anonymity. Hiding the names must not hide the result, which
  // is the poll.
  it('keeps the counts on an anonymous poll', () => {
    const poll = parsed({ anonymous: true })
    expect(poll.options.map((option) => option.count)).toEqual([2, 0])
    expect(poll.total_voters).toBe(2)
  })

  // The member's own ballot is theirs to see. Without this the screen cannot
  // show their selection or offer 투표 취소 on an anonymous poll.
  it('still returns the caller their own choices on an anonymous poll', () => {
    expect(parsed({ anonymous: true }).my_option_ids).toEqual(['opt-a'])
  })

  // FOUND BY MUTATION, and it is worth saying how. Deleting the
  // `if (poll.anonymous) return null` line from votersFor left every other
  // assertion in this file green, because they all build their poll through
  // toPoll — which had already nulled the names, so votersFor was never once
  // handed a case it could get wrong. Two guards in series, and the tests only
  // ever exercised the first.
  //
  // NoticePoll calls votersFor on a Poll object, so it has to hold the line on
  // its own. This is the only assertion here that reaches it directly.
  it('refuses names on an anonymous poll even when handed them directly', () => {
    const poll: Poll = {
      ...parsed(),
      anonymous: true,
      options: [{ id: 'opt-a', label: '토요일', count: 2, voters: ['김수영', '박자유'] }],
    }

    expect(votersFor(poll, poll.options[0]!)).toBeNull()
  })

  // null and [] are different facts and votersFor collapses only the harmless
  // one. An option nobody picked prints nothing; an anonymous poll prints
  // nothing for a different reason, and neither may print a name.
  it('prints nothing for an option nobody has chosen', () => {
    const poll = parsed()
    expect(optionAt(poll, 1).voters).toEqual([])
    expect(votersFor(poll, optionAt(poll, 1))).toBeNull()
  })
})

describe('toPoll', () => {
  it('returns null for a notice with no poll', () => {
    expect(toPoll(null)).toBeNull()
  })

  it('returns null rather than a half-built poll when the id is missing', () => {
    expect(toPoll({ notice_id: 'notice-1', options: [] })).toBeNull()
  })
})

describe('nextSelection', () => {
  it('replaces the choice in a single-choice poll', () => {
    expect(nextSelection(['opt-a'], 'opt-b', false)).toEqual(['opt-b'])
  })

  it('clears the choice when the chosen option is tapped again', () => {
    expect(nextSelection(['opt-a'], 'opt-a', false)).toEqual([])
  })

  it('adds to the choice in a multi-select poll', () => {
    expect(nextSelection(['opt-a'], 'opt-b', true)).toEqual(['opt-a', 'opt-b'])
  })

  it('unticks one option and leaves the rest in a multi-select poll', () => {
    expect(nextSelection(['opt-a', 'opt-b'], 'opt-a', true)).toEqual(['opt-b'])
  })
})
