// /model/priceTable.js
// Price table helpers.
//
// Conventions:
// - Price table JSON stores a quote as { O, N }.
//   - O: order size (batch size)
//   - N: Ist per order
//   - priceIst = N / O
// - Keys must be treated case-insensitively (runes + non-runes like BlueEss).
// - For UI, we prefer returning the canonical key casing as stored in the JSON.

function normKey(k) {
  return String(k || "").trim().toUpperCase();
}

// Backwards-compat export used by other modules.
export function normRune(r) {
  return normKey(r);
}

export async function loadPriceTable() {
  const res = await fetch("../config/rune-price-table.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load rune-price-table.json: HTTP ${res.status}`);
  return await res.json();
}

function getPhaseTable(priceTable, phase) {
  const p = String(phase);
  const table = priceTable?.phases?.[p];
  return table && typeof table === "object" ? table : null;
}

function getCiIndex(priceTable, phase) {
  // Cache a case-insensitive index per phase on the priceTable object.
  // Structure: { [phase]: Map<UPPER, canonicalKey> }
  const p = String(phase);
  if (!priceTable) return null;
  if (!priceTable.__ciIndex) priceTable.__ciIndex = {};
  if (priceTable.__ciIndex[p]) return priceTable.__ciIndex[p];

  const table = getPhaseTable(priceTable, p);
  const m = new Map();
  if (table) {
    for (const k of Object.keys(table)) {
      m.set(normKey(k), k);
    }
  }
  priceTable.__ciIndex[p] = m;
  return m;
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
  const table = getPhaseTable(priceTable, p);
  if (!table) return { O: 1, N: 0, priceIst: 0, key: null };

  const idx = getCiIndex(priceTable, p);
  const want = normKey(rune);
  const canonicalKey = idx?.get(want) ?? null;
  if (!canonicalKey) return { O: 1, N: 0, priceIst: 0, key: null };

  const raw = table[canonicalKey];
  if (!raw || typeof raw !== "object") return { O: 1, N: 0, priceIst: 0, key: null };

  const O = Number(raw.O);
  const N = Number(raw.N);
  if (!Number.isFinite(O) || O <= 0 || !Number.isFinite(N) || N < 0) {
    return { O: 1, N: 0, priceIst: 0, key: canonicalKey };
  }

  return { O, N, priceIst: N / O, key: canonicalKey };
}

export function getRunePriceIst(priceTable, phase, rune) {
  return getRuneQuote(priceTable, phase, rune).priceIst || 0;
}
