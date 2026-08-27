import { useState, type ChangeEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import {
  CATEGORY_LABEL,
  createRecordFromSheet,
  createRecordUpload,
  listMatchRoster,
  RECORD_CATEGORIES,
  SUBCATEGORY_LABEL,
  type RecordCategory,
} from './api'
import { parseResultFile, type ParseResult, type ParsedRow, type RosterEntry } from './parser'

// 결과지 업로드. The legacy screen parsed and saved in one click and reported
// "N건 저장" afterwards; anything it could not match it dropped without saying
// so. This one stops in the middle: parse, show every EYSL row it found, and
// save nothing until a person has looked at the list.
//
// Everything happens in the browser. The file is not uploaded anywhere.

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const LABEL = { display: 'block', fontSize: 12, color: '#6b7178', marginBottom: 6 } as const

const FIELD = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 12,
  minHeight: 44,
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  fontSize: 14,
  fontFamily: 'inherit',
} as const

const chip = (selected: boolean) =>
  ({
    minHeight: 44,
    minWidth: 72,
    padding: '0 16px',
    borderRadius: 999,
    border: selected ? '1px solid #111317' : '1px solid #e1e5ea',
    background: selected ? '#111317' : '#fff',
    color: selected ? '#fff' : '#111317',
    fontSize: 13,
  }) as const

const badge = (tone: 'ok' | 'warn' | 'bad') =>
  ({
    display: 'inline-flex',
    alignItems: 'center',
    padding: '3px 9px',
    borderRadius: 999,
    fontSize: 11,
    whiteSpace: 'nowrap',
    background: tone === 'ok' ? '#edf7f2' : tone === 'warn' ? '#fff0d6' : '#fff0f0',
    color: tone === 'ok' ? '#11805b' : tone === 'warn' ? '#925900' : '#a33',
  }) as const

const SR_ONLY = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const

const formatEventDate = (key: string) => key.replaceAll('-', '.')

export function AdminRecordUploadPage() {
  // Fetched before anything else and passed down: with no roster there is
  // nobody to match a sheet against, and parsing would only produce a screen
  // full of rows that cannot be saved.
  const rosterQuery = useQuery({ queryKey: ['record-match-roster'], queryFn: listMatchRoster })

  return (
    <div className="page">
      <Link to="/records" className="backLink">
        ← 기록
      </Link>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: '12px 0 16px' }}>결과지 업로드</h1>

      <AsyncSection
        query={rosterQuery}
        isEmpty={(roster) => roster.length === 0}
        loading={<Shimmer rows={2} />}
        empty="실명이 등록된 승인 회원이 없습니다. 결과지의 이름을 맞출 상대가 없어, 지금 업로드해도 저장할 수 있는 기록이 없습니다."
        error="회원 명부를 불러오지 못했습니다"
      >
        {(roster) => <UploadFlow roster={roster} />}
      </AsyncSection>
    </div>
  )
}

/** The member this row will be filed against, or null while nobody has said. */
function resolvedMemberId(row: ParsedRow, overrides: Record<string, string>): string | null {
  const chosen = overrides[row.key]
  if (chosen) return chosen
  return row.match.kind === 'matched' ? row.match.memberId : null
}

/**
 * A row can be saved once it has a member and a distance.
 *
 * distance_m is `int not null check (> 0)` (0004:73). A row the sheet never
 * gave a distance for is shown so the admin knows it was read, but there is no
 * box to type one into, on purpose — a distance recalled from memory next to a
 * time read off a sheet is exactly the half-real record this screen exists to
 * prevent.
 */
function savable(row: ParsedRow, overrides: Record<string, string>): boolean {
  return resolvedMemberId(row, overrides) !== null && row.distanceM !== null
}

type SaveOutcome = { ok: true } | { ok: false; message: string }

function UploadFlow({ roster }: { roster: RosterEntry[] }) {
  const qc = useQueryClient()

  const [category, setCategory] = useState<RecordCategory>('meet')
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'failed'>('idle')
  const [progress, setProgress] = useState('')
  const [parseError, setParseError] = useState('')
  const [result, setResult] = useState<ParseResult | null>(null)
  /** Row key → the member an admin chose by hand. */
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [included, setIncluded] = useState<Set<string>>(new Set())
  const [outcomes, setOutcomes] = useState<Record<string, SaveOutcome>>({})
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveProgress, setSaveProgress] = useState('')
  /**
   * The sheet itself, kept from the moment it was picked so 저장 can file it.
   *
   * Held rather than uploaded at parse time on purpose: a parse that fails, or
   * a coach who looks at the rows and walks away, would otherwise leave a
   * 결과지 on file for an import that never happened.
   */
  const [sheetFile, setSheetFile] = useState<File | null>(null)

  function reset() {
    setResult(null)
    setOverrides({})
    setIncluded(new Set())
    setOutcomes({})
    setSaveState('idle')
    setSaveProgress('')
    setSheetFile(null)
  }

  // The category belongs to the whole file and every parsed row carries it, so
  // changing it after a parse rewrites the rows rather than leaving the screen
  // showing one thing and saving another.
  function changeCategory(next: RecordCategory) {
    setCategory(next)
    setResult((current) =>
      current ? { ...current, rows: current.rows.map((row) => ({ ...row, category: next })) } : null,
    )
  }

  async function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Cleared so picking the same file twice parses it twice — otherwise a
    // corrected sheet with the same name would look like nothing happened.
    event.target.value = ''
    if (!file) return

    reset()
    setPhase('parsing')
    setParseError('')
    setProgress('파일을 여는 중…')
    setSheetFile(file)

    try {
      const parsed = await parseResultFile(file, {
        category,
        roster,
        onProgress: (step) => {
          if (step.phase === 'reading') setProgress('파일을 여는 중…')
          else if (step.phase === 'parsing')
            setProgress(`시트 분석 중 · ${step.sheetIndex}/${step.sheetCount} ${step.sheetName}`)
          else setProgress('분석 완료')
        },
      })
      setResult(parsed)
      // Rows default to excluded: only a row the roster resolved on its own,
      // and that carries everything the database requires, starts ticked.
      setIncluded(new Set(parsed.rows.filter((row) => savable(row, {})).map((row) => row.key)))
      setPhase('idle')
    } catch (error) {
      setPhase('failed')
      setParseError(error instanceof Error ? error.message : '파일을 읽지 못했습니다.')
    }
  }

  function chooseMember(row: ParsedRow, memberId: string) {
    setOverrides((current) => ({ ...current, [row.key]: memberId }))
    setIncluded((current) => {
      const next = new Set(current)
      // Resolving a row is the admin saying it belongs to somebody, so it joins
      // the save set — unless it is one of the rows nothing can save.
      if (memberId && row.distanceM !== null) next.add(row.key)
      else next.delete(row.key)
      return next
    })
    if (saveState !== 'saving') setSaveState('idle')
  }

  function toggleIncluded(row: ParsedRow) {
    setIncluded((current) => {
      const next = new Set(current)
      if (next.has(row.key)) next.delete(row.key)
      else if (savable(row, overrides)) next.add(row.key)
      return next
    })
    if (saveState !== 'saving') setSaveState('idle')
  }

  const rows = result?.rows ?? []
  // A row already on file is not waiting to be saved. upsert_record would
  // simply hand back the existing row, but counting it again would tell a
  // coach retrying one failure that there are thirty rows left to write.
  const selected = rows.filter(
    (row) =>
      included.has(row.key) && savable(row, overrides) && outcomes[row.key]?.ok !== true,
  )
  const unresolved = rows.filter((row) => resolvedMemberId(row, overrides) === null)
  const undistanced = rows.filter((row) => row.distanceM === null)

  const save = useMutation({
    mutationFn: async (batch: ParsedRow[]) => {
      const fileName = result?.fileName ?? ''

      // File the sheet FIRST, once, and hang every record off its id.
      //
      // This is what makes a bad import undoable: records.upload_id is a FK
      // with ON DELETE CASCADE (0004), so removing the 결과지 removes the rows
      // it produced. Before this the column was never set on any of the 258
      // records on file, and an import could only be unpicked one row at a
      // time.
      //
      // A failure here stops the save rather than importing anyway. Rows with
      // no upload to hang off are exactly what we already have too many of,
      // and the coach can retry once they know.
      let uploadId: string | undefined
      if (sheetFile) {
        setSaveProgress('결과지 보관 중…')
        const upload = await createRecordUpload({ file: sheetFile, category })
        uploadId = upload.id
      }
      // Seeded from what is already on screen, so a retry of two failed rows
      // does not blank the 저장됨 marks on the thirty that worked.
      const done: Record<string, SaveOutcome> = { ...outcomes }
      let failures = 0
      let attempted = 0

      // One at a time, with the screen updating after each: upsert_record takes
      // an advisory lock per swim, and a coach watching forty rows go by wants
      // to see which one stopped rather than one failure at the end.
      for (const row of batch) {
        const memberId = resolvedMemberId(row, overrides)
        if (memberId === null || row.distanceM === null) continue
        try {
          await createRecordFromSheet(
            {
              memberId,
              category: row.category,
              subcategory: row.subcategory,
              stroke: row.stroke,
              distanceM: row.distanceM,
              eventName: row.eventName,
              eventDate: row.eventDate,
              resultDisplay: row.resultDisplay,
              resultCentiseconds: row.resultCentiseconds,
              teammates: row.teammates,
            },
            { fileName, sheetName: row.sheetName, rowNumber: row.rowNumber },
            uploadId,
          )
          done[row.key] = { ok: true }
        } catch (error) {
          failures += 1
          done[row.key] = {
            ok: false,
            message: error instanceof Error ? error.message : '저장하지 못했습니다',
          }
        }
        attempted += 1
        setOutcomes({ ...done })
        setSaveProgress(`${attempted} / ${batch.length}`)
      }
      return { failures }
    },
    onMutate: () => {
      setSaveState('saving')
      setSaveProgress(`0 / ${selected.length}`)
    },
    onSuccess: async ({ failures }) => {
      setSaveState(failures > 0 ? 'error' : 'saved')
      // If a staffer filed rows against themselves, their own screen is stale.
      await qc.invalidateQueries({ queryKey: ['my-records'] })
      // A batch of new times can create PB 모먼트 on the same screen.
      await qc.invalidateQueries({ queryKey: ['my-achievement'] })
    },
    onError: () => setSaveState('error'),
  })

  const canSave = selected.length > 0 && saveState !== 'saving'

  return (
    <>
      <section style={CARD}>
        <span style={LABEL}>대회 종류</span>
        <div
          role="group"
          aria-label="대회 종류"
          style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}
        >
          {RECORD_CATEGORIES.map((option) => (
            <button
              key={option}
              onClick={() => changeCategory(option)}
              aria-pressed={category === option}
              style={chip(category === option)}
            >
              {CATEGORY_LABEL[option]}
            </button>
          ))}
        </div>

        <label
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 14,
            minHeight: 44,
            padding: '0 18px',
            borderRadius: 13,
            border: '1px dashed #e1e5ea',
            background: '#f5f6f8',
            color: '#111317',
            fontSize: 13,
          }}
        >
          {phase === 'parsing' ? '분석 중…' : '엑셀 결과지 선택 (.xlsx, .xls)'}
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={pickFile}
            disabled={phase === 'parsing' || saveState === 'saving'}
            style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%' }}
          />
        </label>

        <p style={{ fontSize: 11, color: '#6b7178', margin: '9px 0 0' }}>
          파일은 이 기기 안에서만 읽습니다. 서버로 올라가지 않으며, 확인 후 고른 기록만
          저장됩니다.
        </p>

        {phase === 'parsing' && (
          <p role="status" style={{ fontSize: 12, color: '#6b7178', margin: '9px 0 0' }}>
            {progress}
          </p>
        )}
        {phase === 'failed' && (
          <p role="alert" style={{ fontSize: 12, color: '#a33', margin: '9px 0 0' }}>
            {parseError}
          </p>
        )}
      </section>

      {result && (
        <>
          <Summary
            result={result}
            selectedCount={selected.length}
            unresolvedCount={unresolved.length}
            undistancedCount={undistanced.length}
          />

          {rows.length === 0 ? (
            <EmptyExplanation result={result} />
          ) : (
            <>
              <ul
                style={{ listStyle: 'none', padding: 0, margin: '14px 0 0', display: 'grid', gap: 9 }}
              >
                {rows.map((row) => (
                  <RowCard
                    key={row.key}
                    row={row}
                    roster={roster}
                    chosen={overrides[row.key] ?? ''}
                    included={included.has(row.key)}
                    outcome={outcomes[row.key]}
                    onChoose={(memberId) => chooseMember(row, memberId)}
                    onToggle={() => toggleIncluded(row)}
                  />
                ))}
              </ul>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 9,
                  marginTop: 14,
                }}
              >
                {saveState === 'saving' && (
                  <span style={{ fontSize: 12, color: '#6b7178' }}>{saveProgress}</span>
                )}
                <SaveState
                  state={saveState}
                  onRetry={canSave ? () => save.mutate(selected) : undefined}
                />
                <button
                  onClick={() => save.mutate(selected)}
                  disabled={!canSave}
                  style={{
                    minHeight: 44,
                    minWidth: 132,
                    padding: '0 18px',
                    borderRadius: 13,
                    border: 'none',
                    background: canSave ? '#111317' : '#e1e5ea',
                    color: canSave ? '#fff' : '#6b7178',
                    fontSize: 13,
                  }}
                >
                  {selected.length}건 저장
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

function Summary({
  result,
  selectedCount,
  unresolvedCount,
  undistancedCount,
}: {
  result: ParseResult
  selectedCount: number
  unresolvedCount: number
  undistancedCount: number
}) {
  const skipped = result.sheets.reduce((total, sheet) => total + sheet.skippedRows, 0)

  return (
    <section style={{ ...CARD, marginTop: 14 }}>
      <h2 style={{ fontSize: 15, margin: 0 }}>{result.eventName}</h2>
      <p style={{ fontSize: 12, color: '#6b7178', margin: '4px 0 0' }}>
        {formatEventDate(result.eventDate)} · {result.fileName}
      </p>

      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: '12px 0 0',
          display: 'flex',
          gap: 7,
          flexWrap: 'wrap',
        }}
      >
        <li style={badge('ok')}>저장 대상 {selectedCount}건</li>
        {unresolvedCount > 0 && <li style={badge('warn')}>회원 확인 필요 {unresolvedCount}건</li>}
        {undistancedCount > 0 && <li style={badge('bad')}>거리 없음 {undistancedCount}건</li>}
        {skipped > 0 && <li style={badge('warn')}>읽지 못한 행 {skipped}건</li>}
      </ul>

      {skipped > 0 && (
        <p style={{ fontSize: 11, color: '#6b7178', margin: '9px 0 0' }}>
          소속이 EYSL인데 종목이나 기록을 읽지 못한 행이 있습니다. 그 기록은 기록 추가 화면에서
          직접 등록해 주세요.
        </p>
      )}
    </section>
  )
}

/**
 * Why the table is empty, in the admin's terms.
 *
 * Three different situations render the same nothing, and only two of them are
 * the admin's to act on. Saying which one it is costs one card and saves a
 * conversation.
 */
function EmptyExplanation({ result }: { result: ParseResult }) {
  const headers = result.sheets.reduce((total, sheet) => total + sheet.headerRows, 0)
  const eysl = result.sheets.reduce((total, sheet) => total + sheet.eyslRows, 0)

  let message: ReactNode
  if (headers === 0)
    message = (
      <>
        이 파일에서 <b>이름·소속·기록</b> 열을 찾지 못했습니다. 대회 결과지가 맞는지 확인해 주세요.
        동호회 자체 기록표는 소속 열이 없어 이 화면으로는 읽을 수 없습니다.
      </>
    )
  else if (eysl === 0) message = <>결과지는 읽었지만 소속이 EYSL인 행이 없습니다.</>
  else
    message = (
      <>
        소속이 EYSL인 행 {eysl}건을 찾았지만, 종목이나 기록을 읽지 못했습니다. 기록 추가 화면에서
        직접 등록해 주세요.
      </>
    )

  return (
    <div
      style={{
        ...CARD,
        marginTop: 14,
        textAlign: 'center',
        padding: '32px 18px',
        color: '#6b7178',
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      {message}
    </div>
  )
}

function RowCard({
  row,
  roster,
  chosen,
  included,
  outcome,
  onChoose,
  onToggle,
}: {
  row: ParsedRow
  roster: RosterEntry[]
  chosen: string
  included: boolean
  outcome: SaveOutcome | undefined
  onChoose: (memberId: string) => void
  onToggle: () => void
}) {
  const resolved = chosen || (row.match.kind === 'matched' ? row.match.memberId : '')
  const blocked = row.distanceM === null
  const checkboxId = `row-${row.key}`

  return (
    <li style={CARD}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <label
          htmlFor={checkboxId}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 44,
            minHeight: 44,
            marginLeft: -12,
          }}
        >
          <input
            id={checkboxId}
            type="checkbox"
            checked={included}
            disabled={!resolved || blocked || outcome?.ok === true}
            onChange={onToggle}
            style={{ width: 20, height: 20 }}
          />
          <span style={SR_ONLY}>{row.sourceName || '이름 미상'} 기록 저장</span>
        </label>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>{row.sourceName || '이름 미상'}</strong>
            <MatchBadge row={row} chosen={chosen} roster={roster} />
          </div>

          <p style={{ fontSize: 12, color: '#6b7178', margin: '5px 0 0' }}>
            {row.stroke} {row.distanceM === null ? '거리 미상' : `${row.distanceM}m`} ·{' '}
            {SUBCATEGORY_LABEL[row.subcategory]} · {formatEventDate(row.eventDate)}
          </p>
          <p style={{ fontSize: 11, color: '#6b7178', margin: '3px 0 0' }}>
            {row.sheetName} · {row.rowNumber}행 · 소속 {row.sourceTeam}
          </p>

          {row.subcategory === 'relay' && row.teammates.length > 0 && (
            <p style={{ fontSize: 11, color: '#6b7178', margin: '3px 0 0' }}>
              팀원 {row.teammates.join(', ')}
            </p>
          )}
        </div>

        <strong style={{ fontSize: 15, whiteSpace: 'nowrap' }}>{row.resultDisplay}</strong>
      </div>

      {blocked && (
        <p role="alert" style={{ fontSize: 11, color: '#a33', margin: '9px 0 0' }}>
          결과지에서 거리를 읽지 못해 저장할 수 없습니다. 기록 추가 화면에서 직접 등록해 주세요.
        </p>
      )}

      {row.match.kind !== 'matched' && !blocked && (
        <div style={{ marginTop: 9 }}>
          <label htmlFor={`member-${row.key}`} style={LABEL}>
            {row.match.kind === 'ambiguous' ? '같은 실명이 여럿입니다. 회원 선택' : '회원 선택'}
          </label>
          <select
            id={`member-${row.key}`}
            value={resolved}
            onChange={(event) => onChoose(event.target.value)}
            disabled={outcome?.ok === true}
            style={FIELD}
          >
            <option value="">저장하지 않음</option>
            {roster.map((entry) => (
              <option key={entry.memberId} value={entry.memberId}>
                {entry.realName} ({entry.nickname})
              </option>
            ))}
          </select>
        </div>
      )}

      {outcome && (
        <p
          role={outcome.ok ? undefined : 'alert'}
          style={{ fontSize: 11, margin: '9px 0 0', color: outcome.ok ? '#11805b' : '#a33' }}
        >
          {outcome.ok ? '저장됨' : `저장 실패 · ${outcome.message}`}
        </p>
      )}
    </li>
  )
}

function MatchBadge({
  row,
  chosen,
  roster,
}: {
  row: ParsedRow
  chosen: string
  roster: RosterEntry[]
}) {
  if (chosen) {
    const entry = roster.find((candidate) => candidate.memberId === chosen)
    return <span style={badge('ok')}>{entry ? `${entry.nickname} 지정` : '회원 지정'}</span>
  }
  if (row.match.kind === 'matched') return <span style={badge('ok')}>{row.match.nickname}</span>
  if (row.match.kind === 'ambiguous')
    return <span style={badge('warn')}>동명이인 {row.match.candidates.length}명</span>
  return <span style={badge('bad')}>회원 미확인</span>
}
