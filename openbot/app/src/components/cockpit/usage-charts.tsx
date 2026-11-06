import { type Pivot, usd } from "@/lib/cockpit/usage";

/*
 * Charts drawn by our code as inline SVG: no chart library. Every label is a React text node, so a
 * project, model or session name can never become markup.
 */

const PALETTE = [
  "#6366f1",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#06b6d4",
  "#a855f7",
  "#84cc16",
  "#ec4899",
];
const OTHER = "#94a3b8";
const MAX_SERIES = PALETTE.length;

/** The first series get a colour each; the rest share one grey. */
export function seriesColor(keys: string[], key: string): string {
  const i = keys.indexOf(key);
  return i >= 0 && i < MAX_SERIES ? (PALETTE[i] ?? OTHER) : OTHER;
}

export function Legend({ keys }: { keys: string[] }) {
  const shown = keys.slice(0, MAX_SERIES);
  return (
    <ul className="type-caption mt-2 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
      {shown.map((k) => (
        <li className="flex items-center gap-1.5" key={k}>
          <span
            className="inline-block size-2.5 rounded-sm"
            style={{ background: seriesColor(keys, k) }}
          />
          {k}
        </li>
      ))}
      {keys.length > MAX_SERIES ? (
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 rounded-sm"
            style={{ background: OTHER }}
          />
          {keys.length - MAX_SERIES} more
        </li>
      ) : null}
    </ul>
  );
}

const W = 720;
const H = 200;
const PAD = { l: 44, r: 8, t: 8, b: 22 };

/** Stacked daily cost bars. */
export function DailyBars({ pivot }: { pivot: Pivot }) {
  const n = pivot.days.length;
  if (!n || pivot.total <= 0) return null;
  const max = Math.max(...Object.values(pivot.dayTotals), 0.01);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const slot = plotW / n;
  const bar = Math.max(1, slot * 0.8);
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  return (
    <svg
      aria-label="Daily API-equivalent cost"
      className="h-auto w-full max-w-full text-foreground"
      role="img"
      viewBox={`0 0 ${W} ${H}`}
    >
      <title>Daily API-equivalent cost</title>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            stroke="currentColor"
            strokeOpacity={0.12}
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(max * f)}
            y2={y(max * f)}
          />
          <text
            className="fill-muted-foreground"
            fontSize={10}
            textAnchor="end"
            x={PAD.l - 4}
            y={y(max * f) + 3}
          >
            {usd(max * f)}
          </text>
        </g>
      ))}
      {pivot.days.map((day, i) => {
        let acc = 0;
        const x = PAD.l + i * slot + (slot - bar) / 2;
        return (
          <g key={day}>
            <title>{`${day}: ${usd(pivot.dayTotals[day] ?? 0)}`}</title>
            {pivot.keys.map((k) => {
              const v = pivot.cells[day]?.[k] ?? 0;
              if (v <= 0) return null;
              const top = y(acc + v);
              const h = y(acc) - top;
              acc += v;
              return (
                <rect
                  fill={seriesColor(pivot.keys, k)}
                  height={Math.max(h, 0.5)}
                  key={k}
                  width={bar}
                  x={x}
                  y={top}
                >
                  <title>{`${day} · ${k}: ${usd(v)}`}</title>
                </rect>
              );
            })}
            {i % labelEvery === 0 ? (
              <text
                className="fill-muted-foreground"
                fontSize={10}
                textAnchor="middle"
                x={x + bar / 2}
                y={H - 6}
              >
                {day.slice(5)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Weekday x Paris hour, darker where more was spent. */
export function HourHeatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(...grid.flat(), 0);
  if (max <= 0) return null;
  const cell = 24;
  const gap = 2;
  const left = 34;
  const top = 14;
  const w = left + 24 * (cell + gap);
  const h = top + 7 * (cell + gap);
  return (
    <svg
      aria-label="When the spend happens, by weekday and hour"
      className="h-auto w-full max-w-full text-foreground"
      role="img"
      viewBox={`0 0 ${w} ${h}`}
    >
      <title>When the spend happens, by weekday and hour</title>
      {[0, 3, 6, 9, 12, 15, 18, 21].map((hr) => (
        <text
          className="fill-muted-foreground"
          fontSize={9}
          key={`h${hr}`}
          textAnchor="middle"
          x={left + hr * (cell + gap) + cell / 2}
          y={10}
        >
          {hr}
        </text>
      ))}
      {grid.map((row, d) => (
        <g key={WEEKDAYS[d]}>
          <text
            className="fill-muted-foreground"
            fontSize={10}
            x={0}
            y={top + d * (cell + gap) + cell / 2 + 3}
          >
            {WEEKDAYS[d]}
          </text>
          {row.map((v, hr) => (
            <rect
              fill="#6366f1"
              fillOpacity={v <= 0 ? 0.05 : 0.15 + 0.85 * (v / max)}
              height={cell}
              // biome-ignore lint/suspicious/noArrayIndexKey: the 24 hours are a fixed axis
              key={hr}
              rx={3}
              width={cell}
              x={left + hr * (cell + gap)}
              y={top + d * (cell + gap)}
            >
              <title>{`${WEEKDAYS[d]} ${hr}:00 · ${usd(v)}`}</title>
            </rect>
          ))}
        </g>
      ))}
    </svg>
  );
}

/** One bar split by each model's share of the cost. */
export function ModelShare({
  shares,
}: {
  shares: Array<{ key: string; cost: number }>;
}) {
  const total = shares.reduce((s, x) => s + x.cost, 0);
  if (total <= 0) return null;
  const keys = shares.map((s) => s.key);
  let x = 0;
  return (
    <div>
      <svg
        aria-label="Cost share by model"
        className="h-auto w-full max-w-full"
        role="img"
        viewBox="0 0 720 24"
      >
        <title>Cost share by model</title>
        {shares.map((s) => {
          const w = (s.cost / total) * 720;
          const at = x;
          x += w;
          return (
            <rect
              fill={seriesColor(keys, s.key)}
              height={24}
              key={s.key}
              width={Math.max(w, 0)}
              x={at}
              y={0}
            >
              <title>{`${s.key}: ${usd(s.cost)} (${Math.round((s.cost / total) * 100)}%)`}</title>
            </rect>
          );
        })}
      </svg>
      <Legend keys={keys} />
    </div>
  );
}
