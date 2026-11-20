import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { niceTicks } from './chart-scale';

/**
 * 轻量图表（手写 SVG，不引第三方图表库）。
 * 配色和标记规格按 dataviz 规范：细柱 ≤ 24px、数据端 4px 圆角、基线方角、柱间 2px 留白，
 * 折线 2px，悬停点 ≥ 8px 带 2px 底色描边，网格线 1px 实线；文字只用文字色，不用系列色。
 */
export const VIZ = {
  series: ['#2a78d6', '#eb6834', '#1baf7a'],
  track: '#cde2fb',
  surface: '#ffffff',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  muted: '#898781',
  text: '#0b0b0b',
  textSecondary: '#52514e',
};

const FONT: CSSProperties = { fontSize: 12, fill: VIZ.muted, fontVariantNumeric: 'tabular-nums' };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** 柱子：数据端 4px 圆角，基线方角 */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return [
    `M${x},${y + h}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + w - r}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `V${y + h}`,
    'Z',
  ].join(' ');
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

function Tooltip({
  x,
  y,
  title,
  rows,
  width,
}: {
  x: number;
  y: number;
  title: string;
  rows: TooltipRow[];
  width: number;
}) {
  const left = Math.min(Math.max(x + 12, 0), Math.max(0, width - 180));
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        left,
        top: Math.max(0, y - 8),
        minWidth: 140,
        maxWidth: 220,
        pointerEvents: 'none',
        background: VIZ.surface,
        border: '1px solid rgba(11,11,11,0.10)',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        padding: '8px 10px',
        fontSize: 12,
        zIndex: 2,
      }}
    >
      <div style={{ color: VIZ.textSecondary, marginBottom: 4 }}>{title}</div>
      {rows.map((r) => (
        <div
          key={r.label}
          style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: '20px' }}
        >
          {r.color && (
            <span style={{ width: 12, height: 2, borderRadius: 1, background: r.color }} />
          )}
          <strong style={{ color: VIZ.text, fontVariantNumeric: 'tabular-nums' }}>{r.value}</strong>
          <span style={{ color: VIZ.textSecondary }}>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

const PAD = { top: 12, right: 12, bottom: 24, left: 56 };

/** x 轴标签每隔几个显示一个，避免挤在一起（标签约 40px 宽） */
function labelEvery(n: number, plotWidth: number): number {
  return Math.max(1, Math.ceil((n * 44) / Math.max(plotWidth, 1)));
}

function YAxis({
  ticks,
  y,
  plotWidth,
  format,
}: {
  ticks: number[];
  y: (v: number) => number;
  plotWidth: number;
  format: (v: number) => string;
}) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            x2={PAD.left + plotWidth}
            y1={y(t)}
            y2={y(t)}
            stroke={t === 0 ? VIZ.axis : VIZ.grid}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" style={FONT}>
            {format(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

export interface ColumnDatum {
  key: string;
  label: string;
  value: number;
  tooltip: TooltipRow[];
}

/** 单系列柱状图（例如每日收款）。每根柱子是悬停 / 键盘焦点目标 */
export function ColumnChart({
  data,
  height = 220,
  formatTick,
  ariaLabel,
}: {
  data: ColumnDatum[];
  height?: number;
  formatTick: (v: number) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = Math.max(0, width - PAD.left - PAD.right);
  const plotHeight = height - PAD.top - PAD.bottom;
  const ticks = niceTicks(Math.max(0, ...data.map((d) => d.value)));
  const top = ticks[ticks.length - 1];
  const y = (v: number) => PAD.top + plotHeight - (v / top) * plotHeight;
  const band = data.length ? plotWidth / data.length : 0;
  const barWidth = Math.max(1, Math.min(24, band - 2));
  const every = labelEvery(data.length, plotWidth);
  const h = hover !== null ? data[hover] : null;

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <YAxis ticks={ticks} y={y} plotWidth={plotWidth} format={formatTick} />
          {data.map((d, i) => {
            const x0 = PAD.left + i * band;
            const barH = d.value > 0 ? Math.max(1, (d.value / top) * plotHeight) : 0;
            return (
              <g key={d.key}>
                {barH > 0 && (
                  <path
                    d={barPath(x0 + (band - barWidth) / 2, y(0) - barH, barWidth, barH)}
                    fill={VIZ.series[0]}
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                )}
                {i % every === 0 && (
                  <text x={x0 + band / 2} y={height - 6} textAnchor="middle" style={FONT}>
                    {d.label}
                  </text>
                )}
                <rect
                  x={x0}
                  y={PAD.top}
                  width={band}
                  height={plotHeight}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${d.label} ${d.tooltip.map((r) => `${r.label} ${r.value}`).join('，')}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  style={{ outline: 'none' }}
                />
              </g>
            );
          })}
        </svg>
      )}
      {h && hover !== null && (
        <Tooltip
          x={PAD.left + hover * band + band / 2}
          y={y(h.value) - 40}
          title={h.label}
          rows={h.tooltip}
          width={width}
        />
      )}
    </div>
  );
}

export interface LineSeries {
  key: string;
  label: string;
  values: number[];
}

/** 多系列折线（≤ 3 条，同一刻度）。十字线找最近的日期，提示框列出每个系列 */
export function LineChart({
  labels,
  series,
  height = 220,
  formatValue = (v) => String(v),
  ariaLabel,
}: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  formatValue?: (v: number) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = Math.max(0, width - PAD.left - PAD.right);
  const plotHeight = height - PAD.top - PAD.bottom;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max, 4, true);
  const top = ticks[ticks.length - 1];
  const n = labels.length;
  const x = (i: number) => PAD.left + (n <= 1 ? plotWidth / 2 : (i / (n - 1)) * plotWidth);
  const y = (v: number) => PAD.top + plotHeight - (v / top) * plotHeight;
  const every = labelEvery(n, plotWidth);

  function pick(clientX: number, rect: DOMRect) {
    if (n === 0) return;
    const rel = clientX - rect.left - PAD.left;
    const i = n <= 1 ? 0 : Math.round((rel / plotWidth) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  }

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <Legend
        items={series.map((s, i) => ({ label: s.label, color: VIZ.series[i], line: true }))}
      />
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          style={{ outline: 'none' }}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(n - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n - 1) - 1));
            if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? 0) + 1));
          }}
        >
          <YAxis ticks={ticks} y={y} plotWidth={plotWidth} format={formatValue} />
          {labels.map((l, i) =>
            i % every === 0 ? (
              <text key={l} x={x(i)} y={height - 6} textAnchor="middle" style={FONT}>
                {l}
              </text>
            ) : null,
          )}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotHeight}
              stroke={VIZ.axis}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          )}
          {series.map((s, si) => (
            <polyline
              key={s.key}
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
              fill="none"
              stroke={VIZ.series[si]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {hover !== null &&
            series.map((s, si) => (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(s.values[hover] ?? 0)}
                r={4}
                fill={VIZ.series[si]}
                stroke={VIZ.surface}
                strokeWidth={2}
              />
            ))}
        </svg>
      )}
      {hover !== null && (
        <Tooltip
          x={x(hover)}
          y={PAD.top + 24}
          title={labels[hover]}
          rows={series.map((s, si) => ({
            label: s.label,
            value: formatValue(s.values[hover] ?? 0),
            color: VIZ.series[si],
          }))}
          width={width}
        />
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; line?: boolean }[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 8, fontSize: 12 }}>
      {items.map((it) => (
        <span
          key={it.label}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: VIZ.textSecondary }}
        >
          <span
            style={{
              width: it.line ? 14 : 10,
              height: it.line ? 2 : 10,
              borderRadius: it.line ? 1 : 2,
              background: it.color,
            }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** 名称 + 比例条 + 数字，一行一个（例如各套餐的续费率）。比例为空时显示「—」 */
export function MeterList({
  rows,
}: {
  rows: { key: string; label: string; ratio: number | null; figure: string; hint?: string }[];
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map((r) => (
        <div
          key={r.key}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(72px, 140px) 1fr auto',
            gap: 12,
            alignItems: 'center',
          }}
          aria-label={`${r.label} ${r.figure}`}
        >
          <span
            style={{
              color: VIZ.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {r.label}
          </span>
          <span style={{ height: 8, borderRadius: 4, background: VIZ.track, overflow: 'hidden' }}>
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${Math.round((r.ratio ?? 0) * 100)}%`,
                background: VIZ.series[0],
                borderRadius: 4,
              }}
            />
          </span>
          <span style={{ textAlign: 'right', minWidth: 96, fontVariantNumeric: 'tabular-nums' }}>
            <strong style={{ color: VIZ.text }}>{r.figure}</strong>
            {r.hint && (
              <span style={{ color: VIZ.muted, marginLeft: 6, fontSize: 12 }}>{r.hint}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 排序横条（单色），数值写在条尾 */
export function BarList({
  rows,
  format = (v) => String(v),
}: {
  rows: { key: string; label: string; value: number }[];
  format?: (v: number) => string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {sorted.map((r) => (
        <div
          key={r.key}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(56px, 96px) 1fr',
            gap: 12,
            alignItems: 'center',
          }}
          aria-label={`${r.label} ${format(r.value)}`}
        >
          <span style={{ color: VIZ.text, whiteSpace: 'nowrap' }}>{r.label}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {r.value > 0 && (
              <span
                style={{
                  height: 12,
                  width: `calc((100% - 48px) * ${max ? r.value / max : 0})`,
                  minWidth: 2,
                  background: VIZ.series[0],
                  borderRadius: '0 4px 4px 0',
                }}
              />
            )}
            <span style={{ color: VIZ.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
              {format(r.value)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
