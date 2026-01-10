// /model/runewordsPlanner.js
import { getRunePriceIst, normRune } from "./priceTable.js";

export function priceRunewordIst({ priceTable, phase, runes }) {
  const missing = [];
  let total = 0;

  for (const r of runes) {
    const R = normRune(r);
    const v = getRunePriceIst(priceTable, phase, R);
    if (v == null) {
      missing.push(R);
    } else {
      total += v;
    }
  }

  return { totalIst: total, missing };
}

export function breakdownRuneword({ priceTable, phase, runes }) {
  const rows = runes.map((r) => {
    const R = normRune(r);
    const v = getRunePriceIst(priceTable, phase, R);
    return { rune: R, priceIst: v };
  });

  const total = rows.reduce((s, x) => s + (x.priceIst ?? 0), 0);
  const missing = rows.filter(x => x.priceIst == null).map(x => x.rune);

  return { rows, totalIst: total, missing };
}
