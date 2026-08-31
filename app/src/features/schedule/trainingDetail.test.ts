import { describe, expect, it } from 'vitest'
import { isEmptyTrainingDetail, toTrainingDetail } from './trainingDetail'

describe('toTrainingDetail', () => {
  it('takes the six fields it owns', () => {
    const d = toTrainingDetail({
      coach: '박코치',
      gear: '오리발, 킥판',
      info: '자유형 위주',
      link: 'https://example.org/plan',
      plan: '1. 웜업 400m\n2. 메인 8x100',
      plan_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      plan_at: '2026-08-27T05:01:53.941019+00:00',
    })
    expect(d.coach).toBe('박코치')
    expect(d.plan).toBe('1. 웜업 400m\n2. 메인 8x100')
    expect(d.plan_by).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  /**
   * The reason this module exists. `details` is shared, and a key belonging to
   * somebody else must not become reachable from a training screen just because
   * it happens to sit in the same object.
   */
  it('drops every key it does not name', () => {
    const d = toTrainingDetail({
      coach: '박코치',
      historical_participants: ['철수', '영희'],
      historical_attendance: { 철수: 'present' },
      source: 'workbook-import',
      participants: [{ id: 'x' }],
    })
    expect(Object.keys(d).sort()).toEqual([
      'coach',
      'gear',
      'info',
      'link',
      'plan',
      'plan_at',
      'plan_by',
    ])
    expect(JSON.stringify(d)).not.toContain('workbook-import')
    expect(JSON.stringify(d)).not.toContain('철수')
  })

  it('reads a missing object, an empty string and a non-string alike', () => {
    expect(toTrainingDetail(null).coach).toBeNull()
    expect(toTrainingDetail(undefined).coach).toBeNull()
    expect(toTrainingDetail({}).coach).toBeNull()
    expect(toTrainingDetail({ coach: '' }).coach).toBeNull()
    // A number where a string belongs is corrupt, not a coach called 42.
    expect(toTrainingDetail({ coach: 42 }).coach).toBeNull()
    expect(toTrainingDetail({ coach: { name: '박' } }).coach).toBeNull()
  })
})

describe('isEmptyTrainingDetail', () => {
  it('is empty when nothing a member would read is set', () => {
    expect(isEmptyTrainingDetail(toTrainingDetail({}))).toBe(true)
    // Authorship alone is not content: a plan that was cleared leaves no card.
    expect(
      isEmptyTrainingDetail(
        toTrainingDetail({ plan_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', plan_at: 'x' }),
      ),
    ).toBe(true)
  })

  it('is not empty when any single field is set', () => {
    for (const key of ['coach', 'gear', 'info', 'link', 'plan']) {
      expect(isEmptyTrainingDetail(toTrainingDetail({ [key]: 'x' })), key).toBe(false)
    }
  })
})
