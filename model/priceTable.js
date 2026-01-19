// /model/priceTable.js
export function normRune(r) {
  return String(r || "").trim().toUpperCase();
}

// Case-insensitive key resolver for a given phase price table.
// - Lets config contain mixed-case item keys (e.g. BlueEss) while still matching "blueess" / "BLUEESS".
// - Returns the canonical key as stored in the price table (preserves casing for display).
const _phaseKeyMapCache = new WeakMap(); // tableObj -> Map(lowerKey -> canonicalKey)

function _getPhaseKeyMap(tableObj) {
  if (!tableObj || typeof tableObj !== "object") return new Map();
  let m = _phaseKeyMapCache.get(tableObj);
  if (m) return m;
  m = new Map();
  for (const k of Object.keys(tableObj)) {
    m.set(String(k).toLowerCase(), k);
  }
  _phaseKeyMapCache.set(tableObj, m);
  return m;
}

export function resolvePriceKey(priceTable, phase, key) {
  const p = String(phase);
  const table = priceTable?.phases?.[p];
  const rawKey = String(key || "").trim();
  if (!rawKey) return "";

  // If we don't have a price table for this phase, fall back to the historic rune-normalization.
  if (!table) return normRune(rawKey);

  const m = _getPhaseKeyMap(table);
  return m.get(rawKey.toLowerCase()) || normRune(rawKey);
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
  const table = priceTable?.phases?.[p];
  if (!table) return { O: 1, N: 0, priceIst: 0 };

  const R = resolvePriceKey(priceTable, p, rune);
  if (!R) return { O: 1, N: 0, priceIst: 0 };

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
