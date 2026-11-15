/**
 * Banner shown on every page (and on the sign-in page) when the clock of the computer
 * running BookInn is wrong by more than 5 minutes. Server component: it reads the clock
 * check that ran at the start of this request (see src/lib/clock.ts).
 */
import { clockWarning } from "@/lib/clock";
import { HOTEL_TZ } from "@/lib/dates";
import { Icon } from "./icons";

const fmt = (d: Date) =>
  new Intl.DateTimeFormat("en-PH", {
    timeZone: HOTEL_TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);

export function ClockWarningBanner({ compact = false }: { compact?: boolean }) {
  const w = clockWarning();
  if (!w) return null;
  return (
    <div
      role="alert"
      className={`animate-in flex items-start gap-3 rounded-lg border border-[#f0d9a8] bg-warn-soft px-4 py-3 text-sm text-warn ${compact ? "" : "mb-6"}`}
    >
      <Icon name="alert" size={20} className="mt-0.5" />
      <div>
        <p className="font-semibold">This computer&rsquo;s date and time are wrong.</p>
        <p className="mt-0.5">
          It says <strong>{fmt(w.computerTime)}</strong>, but the correct time is <strong>{fmt(w.correctTime)} PHT</strong> (off by{" "}
          {w.difference}). BookInn is using the correct time from the database, so bookings, check-ins, check-outs, payments and
          cancellations are recorded with the right date.
        </p>
        <p className="mt-1">
          Please fix this computer&rsquo;s date and time (Settings → Time &amp; language → Date &amp; time → Set time automatically).
          A wrong clock can also stop emails from being sent.
        </p>
      </div>
    </div>
  );
}
