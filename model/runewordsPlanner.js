// /model/runewordsPlanner.js
import { getRuneQuote, normRune } from "./priceTable.js";

export function breakdownRuneword({ priceTable, phase, runes }) {
  const rows = runes.map((r) => {
    const R = normRune(r);
    const q = getRuneQuote(priceTable, phase, R);
    return { rune: R, priceIst: q.priceIst || 0 };
  });

  const totalIst = rows.reduce((s, x) => s + (x.priceIst || 0), 0);
  return { rows, totalIst };
}
