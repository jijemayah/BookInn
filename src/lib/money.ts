/**
 * Money is handled in integer centavos so decimal(8,2) values never pass
 * through floating point. SRS §3.3 loyalty and discount rules live here.
 */
export function toCents(v: unknown): number {
  const [whole, frac = ""] = String(v).split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}
export const fromCents = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
export const peso = (c: number) =>
  `₱${Math.floor(c / 100).toLocaleString("en-PH")}.${String(c % 100).padStart(2, "0")}`;

export const DISCOUNTS = ["NONE", "12% Discount", "Free Night"] as const;
export type Discount = (typeof DISCOUNTS)[number];

/** Points needed for each discount (100 pts = 12% off, 250 pts = one free night). */
export const DISCOUNT_POINTS: Record<Discount, number> = { NONE: 0, "12% Discount": 100, "Free Night": 250 };

/** Points earned = total payment ÷ 50, decimals discarded (SRS §3.3). */
export const pointsEarned = (amtCents: number) => Math.floor(amtCents / 5000);

/**
 * Amount due after the single allowed discount.
 * 12%: 12% of the total (rounded half-up to the centavo) is deducted.
 * Free Night: one night of the most expensive booked room is deducted, never below 0.
 */
export function amountDue(totalCents: number, maxNightlyCents: number, discount: Discount) {
  if (discount === "12% Discount") return totalCents - Math.round((totalCents * 12) / 100);
  if (discount === "Free Night") return Math.max(0, totalCents - maxNightlyCents);
  return totalCents;
}

/** Earn and spend for one payment: never both (SRS §3.3); earning needs a loyalty account. */
export function pointsFor(amtCents: number, discount: Discount, hasAccount: boolean) {
  const spend = DISCOUNT_POINTS[discount];
  return { spend, earn: spend === 0 && hasAccount ? pointsEarned(amtCents) : 0 };
}
