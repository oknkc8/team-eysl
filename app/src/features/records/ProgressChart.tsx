// One small line chart per event — how a member's own time for one
// stroke+distance has moved over every meet they have swum it at.
//
// A presentational component only: progress.ts decides which events chart and
// in what order and computes every point; this file only draws what it is
// handed. No network call and no filter state live here.

import { CATEGORY_LABEL, RECORD_CATEGORIES, type RecordCategory } from './api'
import type { ProgressSeries, SeriesPoint } from './progress'
import { formatCentiseconds } from './time'

// The same literal palette FilteredRecords.tsx uses right next to this file,
// not tokens.css's custom properties — nothing under src/features reads
// var(--…) yet, so a chart written against theme variables would be the one
// component on this screen that looked colour up differently from its
// neighbours.
const INK = '#111317'
const MUTED = '#6b7178'
const LINE = '#e1e5ea'
const SURFACE = '#fff'
// The same amber FilteredRecords.tsx's deltaTag uses for the 최고 기록 tag — a
// best-so-far point here is the same fact that tag reports, so it wears the
// same colour rather than a new one invented for this file alone.
const BEST_BG = '#fff0d6'
const BEST_FG = '#925900'
// The same green deltaTag uses for a negative (faster) delta.
const FAST_FG = '#11805b'

// ------------------------------------------------------------------- layout
// Pixel geometry, not viewBox scaling: the chart's own width grows with the
// number of points and the container scrolls horizontally, so what is drawn
// is always drawn at a size that keeps points and date labels apart.

const LEFT_PAD = 34 // room for the 느림/빠름 axis words
const RIGHT_PAD = 18 // room for the last point's date label, centred on it
const TOP_PAD = 14
const PLOT_H = 76
const BOTTOM_PAD = 24 // room for the date-label row
const HEIGHT = TOP_PAD + PLOT_H + BOTTOM_PAD
const POINT_GAP = 52
// A one-point series has nothing to space out, so it gets a fixed small plot
// instead of POINT_GAP × 0.
const SINGLE_POINT_WIDTH = 90

// event_date is a bare 'YYYY-MM-DD'. Month.day, not FilteredRecords.tsx's full
// formatEventDate — this label repeats once per point and has to stay narrow
// enough not to collide with its neighbours across a whole season of meets.
const shortDate = (date: string) => date.slice(5).replace('-', '.')

/**
 * series.category is typed string, the same looseness Swimmable carries, but
 * every value progressSeries() actually groups by came out of SwimRecord's own
 * RecordCategory. Same fallback shape as api.ts's toCategory, for the one case
 * where that stops being true.
 */
function categoryLabel(category: string): string {
  return (RECORD_CATEGORIES as readonly string[]).includes(category)
    ? CATEGORY_LABEL[category as RecordCategory]
    : category
}

/**
 * 기록 변화 — every chartable event, oldest swim to newest, left to right.
 *
 * The axis is never inverted: y is the time itself, largest at the top and
 * smallest at the bottom, which is what a plain axis already gives a swimmer
 * for free — a faster (smaller) time sits lower, so improvement reads as a
 * downward line without this file ever having to flip anything. The 느림/빠름
 * words beside each chart's axis are there so that reading does not depend on
 * a member noticing the numbers get smaller.
 */
export function ProgressChart({ series }: { series: ProgressSeries[] }) {
  if (series.length === 0) {
    return (
      <section style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 13, color: MUTED, fontWeight: 400, margin: '0 0 9px' }}>
          기록 변화
        </h2>
        <p style={{ fontSize: 13, color: MUTED, lineHeight: 1.7, margin: 0 }}>
          그래프로 볼 수 있는 기록이 아직 없습니다.
        </p>
      </section>
    )
  }

  return (
    <section style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 13, color: MUTED, fontWeight: 400, margin: '0 0 6px' }}>
        기록 변화
      </h2>
      <p style={{ fontSize: 11, color: MUTED, margin: '0 0 9px' }}>
        그래프 아래쪽으로 갈수록 더 빠른 기록이에요.
      </p>
      <div style={{ display: 'grid', gap: 9 }}>
        {series.map((s) => (
          <ProgressCard key={`${s.category}|${s.stroke}|${s.distance_m}`} series={s} />
        ))}
      </div>
    </section>
  )
}

function ProgressCard({ series }: { series: ProgressSeries }) {
  const bestLabel = formatCentiseconds(series.best_centiseconds) ?? '-'

  return (
    // minWidth:0 is load-bearing, not tidying. This card is a grid item, and a
    // grid item's default `min-width: auto` refuses to shrink below its content's
    // min-content width — which here includes an SVG whose width is set in pixels
    // and grows by POINT_GAP per swim. Without it the track widens to fit the
    // chart, the overflow-x container below never becomes narrower than its
    // contents, and so it never scrolls: the PAGE scrolls sideways instead. At
    // 360px the card has 294px of content width and seven points draw 364px.
    // https://www.w3.org/TR/css-grid/#min-size-auto
    <div
      style={{
        minWidth: 0,
        padding: 14,
        border: `1px solid ${LINE}`,
        borderRadius: 18,
        background: SURFACE,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13, flex: 1, color: INK }}>
          {categoryLabel(series.category)} · {series.stroke} {series.distance_m}m
        </b>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            fontSize: 11,
            background: BEST_BG,
            color: BEST_FG,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          최고 {bestLabel}
        </span>
      </div>

      {/* The one place on this screen wide content can outrun 360px, so it
          scrolls in its own box — never the page body. */}
      <div style={{ marginTop: 8, overflowX: 'auto' }}>
        <ProgressSvg points={series.points} />
      </div>

      {/* The chart's data in text, positioned off-screen rather than hidden.
          `display:none` and `visibility:hidden` are both skipped by screen
          readers, so either would have removed the numbers from the only reader
          that could not already see them. An SVG carrying one generic
          aria-label tells a TalkBack user the graph exists and nothing about
          what it says — not the dates, not the times, not whether the swimmer
          got faster. */}
      <ul
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {series.points.map((p) => (
          <li key={p.id}>
            {p.event_date} {formatCentiseconds(p.result_centiseconds) ?? '-'}
            {p.is_best_so_far ? ' 최고 기록' : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ProgressSvg({ points }: { points: SeriesPoint[] }) {
  const width =
    points.length <= 1
      ? LEFT_PAD + RIGHT_PAD + SINGLE_POINT_WIDTH
      : LEFT_PAD + RIGHT_PAD + (points.length - 1) * POINT_GAP

  const values = points.map((p) => p.result_centiseconds)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min

  // A flat or single-point series has no range to spread across, so every
  // point sits on the plot's vertical centre rather than dividing by zero.
  const y = (value: number) =>
    range === 0 ? TOP_PAD + PLOT_H / 2 : TOP_PAD + ((max - value) / range) * PLOT_H

  const x = (i: number) => (points.length <= 1 ? width / 2 : LEFT_PAD + i * POINT_GAP)

  const linePoints = points.map((p, i) => `${x(i)},${y(p.result_centiseconds)}`).join(' ')

  return (
    <svg
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      role="img"
      // The shape only. Every value it encodes is also in the list beside it,
      // which is what a screen reader actually reads — see ProgressCard.
      aria-label="기록 변화 그래프, 아래로 갈수록 빠른 기록"
    >
      {/* Axis anchor, drawn first so the line and points sit above it. */}
      <line
        x1={LEFT_PAD - 6}
        y1={TOP_PAD}
        x2={LEFT_PAD - 6}
        y2={TOP_PAD + PLOT_H}
        stroke={LINE}
        strokeWidth={1}
        fill="none"
      />
      <text x={2} y={TOP_PAD + 3} fontSize={9} fill={MUTED} stroke="none">
        느림
      </text>
      <text x={2} y={TOP_PAD + PLOT_H + 3} fontSize={9} fill={FAST_FG} stroke="none">
        빠름
      </text>

      {points.length > 1 && (
        <polyline
          points={linePoints}
          fill="none"
          stroke={INK}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {points.map((p, i) => (
        <g key={p.id}>
          <circle
            cx={x(i)}
            cy={y(p.result_centiseconds)}
            r={p.is_best_so_far ? 4.5 : 3}
            fill={p.is_best_so_far ? BEST_FG : SURFACE}
            stroke={p.is_best_so_far ? BEST_FG : INK}
            strokeWidth={1.5}
          />
          <text
            x={x(i)}
            y={HEIGHT - 6}
            fontSize={9}
            fill={MUTED}
            stroke="none"
            textAnchor="middle"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {shortDate(p.event_date)}
          </text>
        </g>
      ))}
    </svg>
  )
}
