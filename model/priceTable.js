// /model/priceTable.js
export function normRune(r) {
  return String(r || "").trim().toUpperCase();
}

export async function loadPriceTable() {
  const res = await fetch("../config/rune-price-table.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load rune-price-table.json: HTTP ${res.status}`);
  return await res.json();
}

/**
 * Unified quote:
 * - O: order size (batch size)
 * - N: Ist per order
 * priceIst = N / O
 *
 * Missing => {O:1, N:0} (free)
 */
export function getRuneQuote(priceTable, phase, rune) {
  const p = String(phase);
  const R = normRune(rune);
  const table = priceTable?.phases?.[p];
  if (!table) return { O: 1, N: 0, priceIst: 0 };

  const raw = table[R];
  if (!raw || typeof raw !== "object") return { O: 1, N: 0, priceIst: 0 };

  const O = Number(raw.O);
  const N = Number(raw.N);
  if (!Number.isFinite(O) || O <= 0 || !Number.isFinite(N) || N < 0) return { O: 1, N: 0, priceIst: 0 };

  return { O, N, priceIst: N / O };
}

export function getRunePriceIst(priceTable, phase, rune) {
  return getRuneQuote(priceTable, phase, rune).priceIst || 0;
}
