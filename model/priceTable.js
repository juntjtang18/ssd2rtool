// /model/priceTable.js
export function normRune(r) {
  return String(r || "").trim().toUpperCase();
}

export async function loadPriceTable() {
  const res = await fetch("../config/rune-price-table.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load rune-price-table.json: HTTP ${res.status}`);
  return await res.json();
}

export function getRunePriceIst(priceTable, phase, rune) {
  const p = String(phase);
  const R = normRune(rune);
  const table = priceTable?.phases?.[p];

  // If phase/table/rune missing => 0 (treat as "free/common")
  if (!table) return 0;

  const v = table[R];
  return Number.isFinite(v) ? v : 0;
}
