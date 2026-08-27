import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SaveState } from '../../components/ui/SaveState'
import { setRaceEntry, type ScheduleEntry } from './api'
import {
  EMPTY_ENTRY,
  NO_SECOND_EVENT,
  RACE_EVENTS,
  RACE_GROUPS,
  normaliseEntry,
  parseEntry,
  relayOptions,
  toggleRelay,
  type RaceEntry,
} from './raceEntry'

/**
 * 대회 신청 — 그룹, 개인종목 두 개, 단체전.
 *
 * His `raceApply` screen, on our activity detail rather than as a page of its
 * own: ours already shows the seat and the 취소 button here, and sending the
 * member somewhere else to say which events they swim would split one decision
 * across two screens.
 *
 * The submit button carries the same tell his does — 대회 신청하기 before there
 * is an entry, 수정 완료 after — because that label is the only thing on screen
 * that says whether the club already knows what you are swimming.
 */

// Declared here rather than imported: SaveState.tsx does not export it, and
// ActivityDetailPage declares its own copy the same way.
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const CARD: React.CSSProperties = {
  background: '#fff',
  borderRadius: 14,
  padding: 16,
  marginTop: 12,
}
const LABEL: React.CSSProperties = { fontSize: 13, fontWeight: 600, display: 'block' }
const SELECT: React.CSSProperties = {
  width: '100%',
  minHeight: 44,
  marginTop: 6,
  marginBottom: 14,
  borderRadius: 10,
  border: '1px solid #d7dade',
  padding: '0 12px',
  fontSize: 15,
  background: '#fff',
}
const CHIP = (on: boolean): React.CSSProperties => ({
  minHeight: 44,
  padding: '0 16px',
  borderRadius: 999,
  border: on ? '1px solid #111317' : '1px solid #d7dade',
  background: on ? '#111317' : '#fff',
  color: on ? '#fff' : '#111317',
  fontSize: 14,
})
const PRIMARY: React.CSSProperties = {
  width: '100%',
  minHeight: 48,
  borderRadius: 12,
  border: 'none',
  background: '#111317',
  color: '#fff',
  fontSize: 16,
  fontWeight: 600,
  marginTop: 4,
}

export function RaceEntryCard({ entry: scheduleEntry }: { entry: ScheduleEntry }) {
  const activityId = scheduleEntry.activity.id
  const stored = parseEntry(scheduleEntry.mine?.details)
  const offered = relayOptions(scheduleEntry.activity.details)

  const [draft, setDraft] = useState<RaceEntry>(stored ?? EMPTY_ENTRY)
  const [state, setState] = useState<SaveStatus>('idle')
  const [failure, setFailure] = useState<string | null>(null)
  const qc = useQueryClient()

  const save = useMutation({
    mutationFn: () => setRaceEntry(activityId, normaliseEntry(draft, offered)),
    onMutate: () => {
      setState('saving')
      setFailure(null)
    },
    onSuccess: async () => {
      setState('saved')
      await qc.invalidateQueries({ queryKey: ['schedule-entry', activityId] })
      await qc.invalidateQueries({ queryKey: ['schedule'] })
    },
    onError: (cause: { message?: string }) => {
      setState('error')
      // 0045 raises in Korean and names the offending field, so its own words
      // are more useful than a generic 저장에 실패했습니다.
      setFailure(typeof cause?.message === 'string' ? cause.message : null)
    },
  })

  return (
    <div style={CARD}>
      <h2 style={{ fontSize: 16, margin: '0 0 14px' }}>대회 신청</h2>

      <label style={LABEL}>
        그룹
        <select
          value={draft.group}
          onChange={(e) => setDraft({ ...draft, group: e.target.value })}
          style={SELECT}
        >
          {RACE_GROUPS.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      </label>

      <label style={LABEL}>
        개인종목 1
        <select
          value={draft.s1}
          onChange={(e) => setDraft({ ...draft, s1: e.target.value })}
          style={SELECT}
        >
          {RACE_EVENTS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>

      <label style={LABEL}>
        개인종목 2
        <select
          value={draft.s2}
          onChange={(e) => setDraft({ ...draft, s2: e.target.value })}
          style={SELECT}
        >
          {[...RACE_EVENTS, NO_SECOND_EVENT].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>

      <span style={LABEL}>
        단체전 참가 <span style={{ fontWeight: 400, color: '#6b7076' }}>(중복 선택 가능)</span>
      </span>
      {offered.length === 0 ? (
        // Not an error and not hidden. `activities.details.relays` is seeded out
        // of band -- his app has no UI that writes it either -- so a race with no
        // relays is the normal case, and a member who expected one should be told
        // why the buttons are missing rather than left looking for them.
        <p style={{ fontSize: 13, color: '#6b7076', margin: '8px 0 14px' }}>
          이 대회는 등록된 단체전 종목이 없습니다.
        </p>
      ) : (
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', margin: '8px 0 10px' }}>
          {offered.map((relay) => (
            <button
              key={relay}
              type="button"
              aria-pressed={draft.relays.includes(relay)}
              onClick={() => setDraft(toggleRelay(draft, relay, offered))}
              style={CHIP(draft.relays.includes(relay))}
            >
              {relay}
            </button>
          ))}
        </div>
      )}

      {offered.length > 0 && (
        <button
          type="button"
          aria-pressed={draft.noRelay}
          onClick={() => setDraft({ ...draft, noRelay: !draft.noRelay, relays: [] })}
          style={{ ...CHIP(draft.noRelay), width: '100%', marginBottom: 14 }}
        >
          단체전 참가 안 함
        </button>
      )}

      <button onClick={() => save.mutate()} disabled={state === 'saving'} style={PRIMARY}>
        {stored ? '수정 완료' : '대회 신청하기'}
      </button>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <SaveState state={state} onRetry={() => save.mutate()} />
      </div>

      {failure && (
        <p style={{ fontSize: 13, color: '#b4232a', margin: '6px 0 0' }}>{failure}</p>
      )}
    </div>
  )
}
