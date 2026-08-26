import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { getMyMonthlyActivity } from './api'
import { formatMonthLabel, monthlySentence, stepMonth, type MonthlyActivity } from './achievements'

/**
 * 월간 활동 요약 — his `#activity` page (upstream:1337), reached from 마이페이지.
 *
 * His renderActivity filters three browser-side caches and an attendance array
 * (upstream:3512). We have none of those, so 0034 computes the same four numbers
 * in the database and this screen only renders them.
 *
 * Two things his version gets wrong that are not worth reproducing.
 * `summaryMonth` starts at a hardcoded 8 (upstream:1447) rather than the current
 * month, so everybody lands on August whatever the date; and the arrows clamp to
 * 1..12 inside the current year, which makes last December unreachable. The
 * month here starts at today and the arrows carry across the year boundary.
 */
export function MonthlyActivityPage() {
  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 })

  const query = useQuery({
    queryKey: ['my-monthly-activity', cursor.year, cursor.month],
    queryFn: () => getMyMonthlyActivity(cursor.year, cursor.month),
  })

  return (
    <div className="page">
      <header className="pagehead">
        <Link to="/mypage" aria-label="마이페이지로" className="back">
          ←
        </Link>
        <h1>월간 활동 요약</h1>
        <span />
      </header>

      <div className="monthSwitch">
        <button
          type="button"
          onClick={() => setCursor(stepMonth(cursor.year, cursor.month, -1))}
          aria-label="이전 달"
        >
          ‹
        </button>
        {/* aria-live, because tapping an arrow changes this label and nothing
            else a screen reader would announce on its own. */}
        <b aria-live="polite">{formatMonthLabel(cursor.year, cursor.month)}</b>
        <button
          type="button"
          onClick={() => setCursor(stepMonth(cursor.year, cursor.month, 1))}
          aria-label="다음 달"
        >
          ›
        </button>
      </div>

      <AsyncSection
        query={query}
        loading={<Shimmer rows={2} />}
        error="월간 활동 요약을 불러오지 못했습니다"
      >
        {(data) => <Summary data={data} />}
      </AsyncSection>
    </div>
  )
}

function Summary({ data }: { data: MonthlyActivity }) {
  return (
    <>
      <div className="stats">
        <div className="stat">
          <strong>{data.training_count}회</strong>
          <span>훈련 참여</span>
        </div>
        <div className="stat">
          <strong>{data.race_count}회</strong>
          <span>대회 참가</span>
        </div>
        <div className="stat">
          <strong>{data.other_count}회</strong>
          <span>기타</span>
        </div>
        <div className="stat">
          <strong>{data.attendance_rate}%</strong>
          <span>출석률</span>
        </div>
      </div>

      <h2 className="listDivider">이번 달 요약</h2>
      <div className="card">
        <b>{monthlySentence(data)}</b>
        {/* 출석률 over zero marked activities is 0%, which reads as "you missed
            everything" rather than "nobody has checked yet". The denominator is
            said out loud so the two cannot be confused. */}
        <p className="fieldNote">
          {data.attendance_marked === 0
            ? '이 달에는 아직 출석 체크된 활동이 없어요.'
            : `출석 체크된 ${data.attendance_marked}회 중 ${data.attendance_present}회 참석했어요.`}
        </p>
      </div>
    </>
  )
}
