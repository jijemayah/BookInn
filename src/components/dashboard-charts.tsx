"use client";
/**
 * Dashboard visuals. Animations: numbers count up, bars wipe or grow in, the line draws
 * itself (all disabled under prefers-reduced-motion). Every chart has a hover tooltip and
 * a table view, and colour is never the only cue (legends, labels, values in text).
 * Palette: brand green #026e2f and amber #d97706 (validated together for colour-blind
 * separation); availability uses one green ramp because its states are ordered.
 */
import { useEffect, useState } from "react";
import type { DayPoint } from "@/lib/dashboard";

const GREEN = "#026e2f";
const AMBER = "#d97706";
const RESERVED = "#73c377";
const TRACK = "#e3efe0";
const INK = "#1f2a22";
const MUTED = "#55635a";
const GRID = "#e6ece4";

const pesoShort = (cents: number) => {
  const v = cents / 100;
  if (v === 0) return "₱0";
  if (v >= 1_000_000) return `₱${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `₱${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return `₱${Math.round(v)}`;
};
const pesoFull = (cents: number) => `₱${(cents / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", timeZone: "UTC" });
const dateLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "UTC" });

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Counts from 0 to `value` once, on mount. `format` turns the number into text. */
export function CountUp({ value, format = "int", duration = 900 }: { value: number; format?: "int" | "peso"; duration?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const instant = reducedMotion() || value === 0;
    let raf = 0;
    let start = 0;
    const tick = (t: number) => {
      start ||= t;
      const p = instant ? 1 : Math.min(1, (t - start) / duration);
      setShown(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{format === "peso" ? pesoFull(shown) : shown.toLocaleString("en-PH")}</>;
}

/** Tonight: occupied (checked in) / reserved (booked, not checked in) / available rooms. */
export function AvailabilityBar({ occupied, reserved, available }: { occupied: number; reserved: number; available: number }) {
  const total = Math.max(1, occupied + reserved + available);
  const parts = [
    { label: "Occupied", hint: "checked in", n: occupied, color: GREEN },
    { label: "Reserved", hint: "booked, not checked in", n: reserved, color: RESERVED },
    { label: "Available", hint: "free tonight", n: available, color: TRACK },
  ];
  return (
    <div>
      <div
        className="flex h-4 w-full gap-[2px] overflow-hidden rounded-full"
        role="img"
        aria-label={`Tonight: ${occupied} occupied, ${reserved} reserved, ${available} available of ${occupied + reserved + available} rooms`}
      >
        {parts
          .filter((p) => p.n > 0)
          .map((p, i) => (
            <span
              key={p.label}
              className="wipe h-full first:rounded-l-full last:rounded-r-full"
              title={`${p.label}: ${p.n}`}
              style={{ width: `${(p.n / total) * 100}%`, background: p.color, animationDelay: `${i * 180}ms` }}
            />
          ))}
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3">
        {parts.map((p) => (
          <div key={p.label} className="border-l-4 pl-3" style={{ borderColor: p.color === TRACK ? "#c9d8c4" : p.color }}>
            <dt className="text-xs text-muted">{p.label}</dt>
            <dd className="text-2xl font-semibold text-brand-900"><CountUp value={p.n} /></dd>
            <dd className="text-[11px] text-muted">{p.hint}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Tooltip({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-white px-2.5 py-1.5 text-xs shadow-lg"
      style={{ left: `${x}%`, top: y }}
      role="status"
    >
      {children}
    </div>
  );
}

function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-xs font-medium text-brand-800">Show as table</summary>
      <div className="mt-2 overflow-x-auto rounded-lg border border-line">
        <table>
          <caption className="sr-only">{caption}</caption>
          <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

const W = 600;
const H = 220;
const PAD = { l: 48, r: 12, t: 16, b: 28 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1);
}

/** Payments recorded per day, last 7 days: area line with a crosshair tooltip. */
export function PaymentsChart({ days }: { days: DayPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...days.map((d) => d.paymentsCents)));
  const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / (days.length - 1);
  const y = (c: number) => PAD.t + (1 - c / max) * (H - PAD.t - PAD.b);
  const pts = days.map((d, i) => [x(i), y(d.paymentsCents)] as const);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = `${line} L${x(days.length - 1)},${H - PAD.b} L${x(0)},${H - PAD.b} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const total = days.reduce((a, d) => a + d.paymentsCents, 0);

  return (
    <div>
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Payments recorded in the last 7 days: ${pesoFull(total)} in total`}>
          <defs>
            <linearGradient id="payFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={GREEN} stopOpacity="0.22" />
              <stop offset="100%" stopColor={GREEN} stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
              <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill={MUTED}>{pesoShort(t)}</text>
            </g>
          ))}
          {days.map((d, i) => (
            <text key={d.date} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill={hover === i ? INK : MUTED}>{dayLabel(d.date)}</text>
          ))}
          <path d={area} fill="url(#payFill)" className="fade-area" />
          <path d={line} fill="none" stroke={GREEN} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="draw-line" />
          {hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke={MUTED} strokeDasharray="3 3" strokeWidth={1} />
              <circle cx={pts[hover][0]} cy={pts[hover][1]} r={5} fill={GREEN} stroke="#fff" strokeWidth={2} />
            </>
          )}
          {days.map((d, i) => (
            <rect
              key={d.date}
              x={x(i) - (W - PAD.l - PAD.r) / (days.length - 1) / 2}
              y={PAD.t}
              width={(W - PAD.l - PAD.r) / (days.length - 1)}
              height={H - PAD.t - PAD.b}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              tabIndex={0}
              aria-label={`${dateLabel(d.date)}: ${pesoFull(d.paymentsCents)}`}
            />
          ))}
        </svg>
        {hover !== null && (
          <Tooltip x={(x(hover) / W) * 100} y={(pts[hover][1] / H) * 100 > 25 ? 8 : 40}>
            <span className="block font-medium text-ink">{dateLabel(days[hover].date)}</span>
            <span className="text-muted">Payments </span><span className="font-semibold text-ink">{pesoFull(days[hover].paymentsCents)}</span>
          </Tooltip>
        )}
      </div>
      <DataTable caption="Payments recorded per day" head={["Date", "Payments recorded"]} rows={days.map((d) => [d.date, pesoFull(d.paymentsCents)])} />
    </div>
  );
}

/** Rounded top, square base (data-end rounded, anchored to the baseline). */
const barPath = (x: number, y: number, w: number, h: number, r = 4) => {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
};

/** Bookings made vs. guest cancellations per day, last 7 days. */
export function ReservationsChart({ days }: { days: DayPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(1, ...days.map((d) => Math.max(d.bookings, d.cancellations))));
  const band = (W - PAD.l - PAD.r) / days.length;
  const bw = Math.min(22, band * 0.28);
  const y = (n: number) => PAD.t + (1 - n / max) * (H - PAD.t - PAD.b);
  const base = H - PAD.b;
  const ticks = Array.from(new Set([0, Math.round(max / 2), max]));

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: GREEN }} /> Bookings made</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: AMBER }} /> Cancellations</span>
      </div>
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Last 7 days: ${days.reduce((a, d) => a + d.bookings, 0)} bookings made, ${days.reduce((a, d) => a + d.cancellations, 0)} cancellations`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
              <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill={MUTED}>{t}</text>
            </g>
          ))}
          {days.map((d, i) => {
            const cx = PAD.l + band * i + band / 2;
            return (
              <g key={d.date}>
                {hover === i && <rect x={PAD.l + band * i + 2} y={PAD.t} width={band - 4} height={base - PAD.t} fill="#f1f6ef" rx={6} />}
                <path d={barPath(cx - bw - 1, y(d.bookings), bw, base - y(d.bookings))} fill={GREEN} className="grow-up" style={{ animationDelay: `${i * 60}ms` }} />
                <path d={barPath(cx + 1, y(d.cancellations), bw, base - y(d.cancellations))} fill={AMBER} className="grow-up" style={{ animationDelay: `${i * 60 + 120}ms` }} />
                <text x={cx} y={H - 8} textAnchor="middle" fontSize="11" fill={hover === i ? INK : MUTED}>{dayLabel(d.date)}</text>
                <rect
                  x={PAD.l + band * i}
                  y={PAD.t}
                  width={band}
                  height={base - PAD.t}
                  fill="transparent"
                  tabIndex={0}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  aria-label={`${dateLabel(d.date)}: ${d.bookings} bookings made, ${d.cancellations} cancellations`}
                />
              </g>
            );
          })}
          <line x1={PAD.l} x2={W - PAD.r} y1={base} y2={base} stroke="#c9d8c4" strokeWidth={1} />
        </svg>
        {hover !== null && (
          <Tooltip x={((PAD.l + band * hover + band / 2) / W) * 100} y={8}>
            <span className="block font-medium text-ink">{dateLabel(days[hover].date)}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: GREEN }} /><span className="text-muted">Bookings</span> <span className="font-semibold text-ink">{days[hover].bookings}</span></span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: AMBER }} /><span className="text-muted">Cancellations</span> <span className="font-semibold text-ink">{days[hover].cancellations}</span></span>
          </Tooltip>
        )}
      </div>
      <DataTable
        caption="Bookings made and cancellations per day"
        head={["Date", "Bookings made", "Cancellations"]}
        rows={days.map((d) => [d.date, d.bookings, d.cancellations])}
      />
    </div>
  );
}

/** Reservations by status: one-hue horizontal bars with the count as a label; each row links to the filtered list. */
export function StatusBars({ items }: { items: { label: string; n: number; href: string }[] }) {
  const max = Math.max(1, ...items.map((i) => i.n));
  return (
    <ul className="grid gap-2.5">
      {items.map((it, i) => (
        <li key={it.label}>
          <a href={it.href} className="group grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-3 rounded-md px-1 py-0.5 text-sm text-ink no-underline hover:bg-brand-100 hover:no-underline">
            <span className="text-muted group-hover:text-ink">{it.label}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-[#eef3ec]">
              <span className="wipe block h-full rounded-full" style={{ width: `${(it.n / max) * 100}%`, background: GREEN, animationDelay: `${i * 90}ms` }} />
            </span>
            <span className="text-right font-semibold tabular-nums"><CountUp value={it.n} /></span>
          </a>
        </li>
      ))}
    </ul>
  );
}
