import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import {
  CATEGORY_LABEL,
  countRecordsFromUpload,
  deleteRecordUpload,
  listRecordUploads,
  type RecordUpload,
} from './api'

// 결과지 목록. The other half of 결과지 업로드: the upload screen files a sheet,
// this one says which sheets are on file and takes one back off.
//
// Taking it off is the point. records.upload_id is a FK with ON DELETE CASCADE
// (0004), so removing a sheet removes every record it produced — the undo a
// mistaken import has never had, because nothing ever set upload_id until now.

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const TAG = {
  display: 'inline-block',
  padding: '3px 9px',
  borderRadius: 999,
  fontSize: 12,
} as const

const BTN = {
  minHeight: 44,
  padding: '0 14px',
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  background: '#fff',
  fontSize: 13,
} as const

export function RecordUploadListPage() {
  const query = useQuery({ queryKey: ['record-uploads'], queryFn: listRecordUploads })

  return (
    <div className="page">
      <Link to="/admin/records/upload" className="backLink">
        ← 결과지 업로드
      </Link>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: '12px 0 6px' }}>결과지 목록</h1>
      <p style={{ fontSize: 12, color: '#6b7178', margin: '0 0 16px' }}>
        올린 결과지와, 그 파일에서 나온 기록입니다. 결과지를 지우면 그 기록도 함께 사라집니다.
      </p>

      <AsyncSection
        query={query}
        isEmpty={(rows) => rows.length === 0}
        loading={<Shimmer rows={3} />}
        empty="올린 결과지가 없습니다"
        error="결과지 목록을 불러오지 못했습니다"
      >
        {(rows) => (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
            {rows.map((upload) => (
              <li key={upload.id}>
                <UploadCard upload={upload} />
              </li>
            ))}
          </ul>
        )}
      </AsyncSection>
    </div>
  )
}

function UploadCard({ upload }: { upload: RecordUpload }) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // Asked only when 삭제 is pressed, not for every card on the list: it is one
  // count query per upload and the number is only needed at the moment somebody
  // is deciding. It is also the whole content of the confirmation — "이 결과지를
  // 지울까요" is a different question from "기록 37건을 함께 지울까요".
  const affected = useQuery({
    queryKey: ['record-upload-count', upload.id],
    queryFn: () => countRecordsFromUpload(upload.id),
    enabled: confirming,
  })

  const remove = useMutation({
    mutationFn: () => deleteRecordUpload(upload.id),
    onMutate: () => setFailure(null),
    onSuccess: () => {
      setConfirming(false)
      void qc.invalidateQueries({ queryKey: ['record-uploads'] })
      // The records list and every derived screen read the rows this just took
      // away, so they have to be told rather than left showing a deleted swim.
      void qc.invalidateQueries({ queryKey: ['records'] })
      void qc.invalidateQueries({ queryKey: ['my-records'] })
      void qc.invalidateQueries({ queryKey: ['member-records'] })
    },
    onError: (error) => setFailure(error instanceof Error ? error.message : '삭제하지 못했습니다'),
  })

  return (
    <article style={CARD}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 15, wordBreak: 'break-all' }}>{upload.fileName}</b>
          <p style={{ fontSize: 11, color: '#6b7178', margin: '4px 0 0' }}>
            {formatUploadedAt(upload.createdAt)}
          </p>
        </div>
        <span style={{ ...TAG, flexShrink: 0, background: '#f5f6f8', color: '#111317' }}>
          {CATEGORY_LABEL[upload.category]}
        </span>
      </div>

      {upload.note && (
        <p style={{ fontSize: 12, color: '#6b7178', margin: '9px 0 0' }}>{upload.note}</p>
      )}

      {failure && (
        <p role="alert" style={{ fontSize: 12, color: '#b3261e', margin: '9px 0 0' }}>
          {failure}
        </p>
      )}

      <div style={{ display: 'flex', gap: 7, marginTop: 12, flexWrap: 'wrap' }}>
        {!confirming ? (
          <button style={{ ...BTN, color: '#b3261e' }} onClick={() => setConfirming(true)}>
            삭제
          </button>
        ) : (
          <>
            <span style={{ fontSize: 12, color: '#6b7178', alignSelf: 'center' }}>
              {affected.isPending
                ? '함께 지워질 기록을 세는 중…'
                : affected.isError
                  ? '기록 수를 확인하지 못했습니다. 그래도 지울까요?'
                  : `이 결과지에서 나온 기록 ${affected.data ?? 0}건이 함께 지워집니다.`}
            </span>
            <button
              style={{ ...BTN, background: '#b3261e', color: '#fff', border: 0 }}
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? '지우는 중…' : '함께 지우기'}
            </button>
            <button style={BTN} disabled={remove.isPending} onClick={() => setConfirming(false)}>
              취소
            </button>
          </>
        )}
      </div>
    </article>
  )
}

/** `2026-08-27T04:05:06Z` → `2026-08-27 04:05`. */
function formatUploadedAt(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}
