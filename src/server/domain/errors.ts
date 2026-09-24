/** A business rule violation shown to the user next to `field`. */
export class RuleError extends Error {
  constructor(public code: string, message: string, public field?: string) { super(message); }
}

import Decimal from "decimal.js";
/** Decimal from user input, or NaN when it is not a number (decimal.js throws otherwise). */
export function parseDecimal(s: string | null | undefined): Decimal {
  try { return new Decimal(String(s ?? "").trim() || NaN); } catch { return new Decimal(NaN); }
}
