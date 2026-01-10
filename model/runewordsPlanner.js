// /model/runewordsPlanner.js
import { getRunePriceIst, normRune } from "./priceTable.js";

export function breakdownRuneword({ priceTable, phase, runes }) {
  const rows = runes.map((r) => {
    const R = normRune(r);
    const v = getRunePriceIst(priceTable, phase, R); // always number (>=0)
    return { rune: R, priceIst: v };
  });

  const total = rows.reduce((s, x) => s + (x.priceIst || 0), 0);
  return { rows, totalIst: total };
}
