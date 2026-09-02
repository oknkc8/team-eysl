import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import {
  addRaceAttachment,
  getRaceAttachmentUrl,
  listRaceAttachments,
  MAX_RACE_ATTACHMENTS,
  removeRaceAttachment,
  type RaceAttachment,
} from './raceAttachmentApi'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const NOTE = { fontSize: 12, color: '#6b7178', margin: '10px 0 0', lineHeight: 1.6 } as const

/**
 * 대회요강 · 편성표, on the 대회 detail screen.
 *
 * Every approved member reads; only 운영진 upload and remove. That split is
 * presentation of a rule enforced elsewhere and it is worth naming which:
 * add_race_attachment_v1 and remove_race_attachment_v1 both check is_staff()
 * inside a SECURITY DEFINER body, and race_attachments carries no write policy
 * and no write grant at all. Hiding the controls here is a courtesy to the
 * member, not the gate — legacy `applyRole()` treated exactly this kind of
 * visibility as access control and that is the flaw this rebuild exists to
 * remove.
 */
export function RaceAttachments({ activityId }: { activityId: string }) {
  const { user } = useCurrentUser()
  const qc = useQueryClient()
  const staff = isStaff(user)

  const query = useQuery({
    queryKey: ['race-attachments', activityId],
    queryFn: () => listRaceAttachments(activityId),
    enabled: !!activityId,
  })

  const rows = query.data ?? []

  // Nothing to show and nothing to offer: a member looking at a 대회 with no
  // 요강 yet should see the screen they saw before this feature existed, not an
  // empty card explaining what is absent.
  if (!staff && !query.isPending && !query.isError && rows.length === 0) return null

  return (
    <section style={{ ...CARD, marginTop: 14 }}>
      <h2 style={{ fontSize: 15, margin: 0 }}>대회 자료</h2>

      <AsyncSection
        query={query}
        loading={<Shimmer rows={1} />}
        error="대회 자료를 불러오지 못했습니다"
      >
        {(attachments) =>
          attachments.length === 0 ? (
            <p style={NOTE}>아직 올린 자료가 없습니다.</p>
          ) : (
            <ul className="list" style={{ marginTop: 10 }}>
              {attachments.map((attachment) => (
                <AttachmentRow
                  key={attachment.id}
                  attachment={attachment}
                  activityId={activityId}
                  canRemove={staff}
                />
              ))}
            </ul>
          )
        }
      </AsyncSection>

      {staff && (
        <UploadRow
          activityId={activityId}
          count={rows.length}
          onChanged={async () => {
            await qc.invalidateQueries({ queryKey: ['race-attachments', activityId] })
          }}
        />
      )}
    </section>
  )
}

function AttachmentRow({
  attachment,
  activityId,
  canRemove,
}: {
  attachment: RaceAttachment
  activityId: string
  canRemove: boolean
}) {
  const qc = useQueryClient()
  const [openError, setOpenError] = useState<string | null>(null)
  const [removeState, setRemoveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  // Signed when it is opened rather than when the list renders, so a page left
  // open overnight does not hold a pile of live URLs, and a link copied out of
  // the DOM stops working in a minute.
  async function open() {
    setOpenError(null)
    try {
      const url = await getRaceAttachmentUrl(attachment.storage_path)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      setOpenError('파일을 열지 못했습니다.')
    }
  }

  const remove = useMutation({
    mutationFn: () => removeRaceAttachment(attachment.id),
    onMutate: () => setRemoveState('saving'),
    onSuccess: async () => {
      setRemoveState('saved')
      await qc.invalidateQueries({ queryKey: ['race-attachments', activityId] })
    },
    onError: () => setRemoveState('error'),
  })

  return (
    <li>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <button onClick={() => void open()} className="row" style={{ flex: 1, minWidth: 0 }}>
          <span className="grow" style={{ wordBreak: 'break-all' }}>
            {attachment.file_name}
          </span>
        </button>
        {canRemove && (
          <button
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="linkButton"
            aria-label={`${attachment.file_name} 삭제`}
          >
            삭제
          </button>
        )}
        <SaveState state={removeState} />
      </div>
      {openError && (
        <p role="alert" style={{ ...NOTE, color: '#a33' }}>
          {openError}
        </p>
      )}
    </li>
  )
}

function UploadRow({
  activityId,
  count,
  onChanged,
}: {
  activityId: string
  count: number
  onChanged: () => Promise<void>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const upload = useMutation({
    mutationFn: (file: File) => addRaceAttachment({ activityId, file }),
    onMutate: () => {
      setState('saving')
      setMessage(null)
    },
    onSuccess: async (outcome) => {
      // The row exists either way — the RPC committed it before the bytes were
      // sent, because the claim gate requires the row first. A failed upload is
      // therefore reported as a failure with the row left in place, which is
      // the recoverable state: re-uploading to the same key is accepted.
      setState(outcome.uploaded ? 'saved' : 'error')
      if (!outcome.uploaded) {
        setMessage('첨부 항목은 만들어졌지만 파일이 올라가지 않았습니다. 삭제 후 다시 시도해주세요.')
      }
      await onChanged()
    },
    onError: (error: unknown) => {
      setState('error')
      // The RPC's own words. Its two refusals a staffer can actually hit — the
      // cap and a non-대회 activity — are Korean sentences raised with 22023, so
      // showing the message is more use than a generic line would be.
      setMessage(error instanceof Error ? error.message : '파일을 올리지 못했습니다.')
    },
  })

  const full = count >= MAX_RACE_ATTACHMENTS
  const busy = state === 'saving'
  const inputId = `race-attachment-${activityId}`

  function pick(files: FileList | null) {
    const chosen = files?.[0]
    // One at a time, deliberately: each file is its own RPC call and its own
    // row, so a batch would need per-file failure reporting for a screen that
    // holds at most eight.
    if (chosen) upload.mutate(chosen)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <label
          htmlFor={inputId}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: 44,
            padding: '0 18px',
            borderRadius: 13,
            background: busy || full ? '#e1e5ea' : '#111317',
            color: busy || full ? '#6b7178' : '#fff',
            fontSize: 13,
          }}
        >
          {busy ? '올리는 중…' : '자료 올리기'}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          disabled={busy || full}
          onChange={(e) => pick(e.target.files)}
          // Visually hidden rather than absent, so the styled label is the
          // control while the input keeps its own focus and keyboard behaviour.
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
          }}
        />
        <SaveState state={state} />
      </div>

      <p style={NOTE}>
        {count}/{MAX_RACE_ATTACHMENTS}개
        {full && ' · 더 올리려면 기존 자료를 먼저 삭제해주세요'}
      </p>

      {message && (
        <p role="alert" style={{ ...NOTE, color: '#a33' }}>
          {message}
        </p>
      )}
    </div>
  )
}
