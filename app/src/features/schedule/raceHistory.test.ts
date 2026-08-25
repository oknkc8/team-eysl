import { describe, it, expect } from 'vitest'
import { dedupeRaceHistory, isFinished, isWaiting, type RaceHistoryRow } from './raceHistory'

const row = (over: Partial<RaceHistoryRow> = {}): RaceHistoryRow => ({
  title: '봄 대회',
  activity_date: '2026-03-14',
  status: '종료',
  source: 'application',
  ...over,
})

describe('dedupeRaceHistory', () => {
  it('leaves distinct meets alone, newest first', () => {
    const rows = dedupeRaceHistory([
      row({ title: '봄 대회', activity_date: '2026-03-14' }),
      row({ title: '가을 대회', activity_date: '2026-09-20' }),
    ])
    expect(rows.map((r) => r.activity_date)).toEqual(['2026-09-20', '2026-03-14'])
  })

  // The president's rule: same title and same date is the same meet, and the
  // live application is the one that survives (upstream-index.html:2741).
  it('keeps the live application when a history row names the same meet', () => {
    const rows = dedupeRaceHistory([
      row({ source: 'history', status: '참가' }),
      row({ source: 'application', status: '종료' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('application')
    expect(rows[0].status).toBe('종료')
  })

  it('applies that precedence regardless of the order the server sent them in', () => {
    const application = row({ source: 'application' })
    const history = row({ source: 'history' })
    expect(dedupeRaceHistory([application, history])[0].source).toBe('application')
    expect(dedupeRaceHistory([history, application])[0].source).toBe('application')
  })

  // Two meets can share a name across years — a club runs 봄 대회 every spring —
  // so the date has to be part of the key or last year's entry disappears.
  it('does not merge the same title in different years', () => {
    const rows = dedupeRaceHistory([
      row({ activity_date: '2026-03-14' }),
      row({ activity_date: '2025-03-15' }),
    ])
    expect(rows).toHaveLength(2)
  })

  it('does not merge different titles on the same day', () => {
    const rows = dedupeRaceHistory([row({ title: '봄 대회' }), row({ title: '봄 기록회' })])
    expect(rows).toHaveLength(2)
  })

  // A source we do not recognise is still a race this member swam, so it is
  // ranked last rather than dropped.
  it('keeps an unknown source but lets a known one win', () => {
    const rows = dedupeRaceHistory([row({ source: 'somethingelse' })])
    expect(rows).toHaveLength(1)

    const both = dedupeRaceHistory([row({ source: 'somethingelse' }), row({ source: 'history' })])
    expect(both).toHaveLength(1)
    expect(both[0].source).toBe('history')
  })

  it('handles an empty history', () => {
    expect(dedupeRaceHistory([])).toEqual([])
  })

  it('does not mutate the array it was given', () => {
    const input = [row({ activity_date: '2025-01-01' }), row({ activity_date: '2026-01-01' })]
    dedupeRaceHistory(input)
    expect(input.map((r) => r.activity_date)).toEqual(['2025-01-01', '2026-01-01'])
  })
})

describe('status helpers', () => {
  // Read off the server's status rather than comparing dates in the browser:
  // the server decides in Asia/Seoul, so a member abroad sees the same answer.
  it('recognise the three statuses the RPC emits', () => {
    expect(isFinished(row({ status: '종료' }))).toBe(true)
    expect(isFinished(row({ status: '신청완료' }))).toBe(false)
    expect(isWaiting(row({ status: '대기' }))).toBe(true)
    expect(isWaiting(row({ status: '신청완료' }))).toBe(false)
  })
})
