// The API speaks rupees (e.g. 100.50); the database stores integer paise (10050).
// Integers avoid floating-point drift: 0.1 + 0.2 !== 0.3, but 10 + 20 === 30.

export const MAX_AMOUNT_RUPEES = 1_000_000_000; // ₹100 crore per transaction

export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function toRupees(paise: number | string): number {
  return Number(paise) / 100;
}

export function hasAtMostTwoDecimals(rupees: number): boolean {
  const scaled = rupees * 100;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}
