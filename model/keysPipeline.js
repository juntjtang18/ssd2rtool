// /model/keysPipeline.js

import { getRuneQuote } from "./priceTable.js";

/**
 * Rotation planner (Policy A, deterministic expected-time):
 * C (TKey) -> S (HKey) -> N (DKey), repeating.
 *
 * - Keys are integers (you only "gain" a key when you finish the planned runs for 1 key)
 * - Countess extras pieces accumulate; bankable value counts only full batches (floor(pcs/O)*N)
 * - Bonus extras are reported but NOT used to decide stopping (Not Guaranteed)
 */
export function planRotationToTargetIst({
  targetIst,
  phase,
  priceTable,
  params,
  buffer = 1.0,           // optional e.g. 1.10
  maxCycles = 5000         // safety
}) {
  const Dc = Number(params.Dc); // TKey per run
  const Ds = Number(params.Ds); // HKey per run
  const Dn = Number(params.Dn); // DKey per run

  const tC = Number(params.tC_min); // min/run
  const tS = Number(params.tS_min);
  const tN = Number(params.tN_min);

  if (!(Dc > 0 && Ds > 0 && Dn > 0 && tC > 0 && tS > 0 && tN > 0)) {
    throw new Error("Invalid key pipeline parameters (D* and t*_min must be > 0).");
  }

  // Deterministic "runs to get 1 key"
  const runsPerT = Math.ceil(1 / Dc);
  const runsPerH = Math.ceil(1 / Ds);
  const runsPerD = Math.ceil(1 / Dn);

  // config extras
  const extras = Array.isArray(params.extras) ? params.extras : [];
  const regularExtras = extras.filter(x => !String(x.name || x.id || "").toUpperCase().startsWith("BONUS"));
  const bonusExtras   = extras.filter(x =>  String(x.name || x.id || "").toUpperCase().startsWith("BONUS"));

  // piece buckets (expected pieces, may be fractional internally)
  const pcs = {};      // for regular extras
  const pcsBonus = {}; // for bonus extras

  for (const e of regularExtras) pcs[String(e.name || e.id).toUpperCase()] = 0;
  for (const e of bonusExtras)   pcsBonus[String(e.name || e.id).toUpperCase().replace(/^BONUS\s*/i,"")] = 0;

  let runsC = 0, runsS = 0, runsN = 0;
  let minutesC = 0, minutesS = 0, minutesN = 0;

  let T = 0, H = 0, D = 0; // integer keys

  const target = Math.ceil(Number(targetIst) * buffer);
  if (!(target > 0)) throw new Error("targetIst must be > 0");

  function bankableExtrasIst(piecesMap) {
    let ist = 0;
    const rows = [];

    for (const [name, p] of Object.entries(piecesMap)) {
      const q = getRuneQuote(priceTable, phase, name); // {O,N}
      if (!q || !(q.O > 0) || !(q.N > 0)) continue;

      const piecesInt = Math.floor(p);       // predicted drops shown as integer
      const orders = Math.floor(piecesInt / q.O);
      const bank = orders * q.N;

      if (orders > 0) {
        ist += bank;
      }
      rows.push({ name, piecesInt, O: q.O, orders, ist: bank, N: q.N });
    }

    rows.sort((a,b)=> b.ist - a.ist);
    return { ist, rows };
  }

  function possibleBonusIst(bonusPiecesMap) {
    // purely for display, not used to stop
    let ist = 0;
    const rows = [];

    for (const [name, p] of Object.entries(bonusPiecesMap)) {
      const q = getRuneQuote(priceTable, phase, name);
      if (!q || !(q.O > 0) || !(q.N > 0)) continue;

      const piecesInt = Math.floor(p);
      const orders = Math.floor(piecesInt / q.O);
      const bank = orders * q.N;
      ist += bank;
      rows.push({ name, piecesInt, O: q.O, orders, ist: bank, N: q.N });
    }

    rows.sort((a,b)=> b.ist - a.ist);
    return { ist, rows };
  }

  function bankableValue() {
    const keysets = Math.min(T, H, D); // bankable only
    const { ist: extraIst, rows: extraRows } = bankableExtrasIst(pcs);
    const { ist: bonusIst, rows: bonusRows } = possibleBonusIst(pcsBonus);
    return {
      target,
      keysets,
      keysValueIst: keysets,        // 1 keyset = 1 Ist
      extrasBankableIst: extraIst,
      bonusPossibleIst: bonusIst,
      totalBankableIst: keysets + extraIst, // STOP condition uses THIS
      extraRows,
      bonusRows
    };
  }

  function addCountessStep() {
    runsC += runsPerT;
    minutesC += runsPerT * tC;
    T += 1;

    // regular extras
    for (const e of regularExtras) {
      const name = String(e.name || e.id).toUpperCase();
      const dpr = Number(e.dropPerRun ?? e.D ?? e.rate);
      if (dpr > 0) pcs[name] = (pcs[name] ?? 0) + runsPerT * dpr;
    }
    // bonus extras (display only)
    for (const e of bonusExtras) {
      const raw = String(e.name || e.id).toUpperCase();
      const name = raw.replace(/^BONUS\s*/i,"");
      const dpr = Number(e.dropPerRun ?? e.D ?? e.rate);
      if (dpr > 0) pcsBonus[name] = (pcsBonus[name] ?? 0) + runsPerT * dpr;
    }
  }

  function addSummonerStep() {
    runsS += runsPerH;
    minutesS += runsPerH * tS;
    H += 1;
  }

  function addNihlStep() {
    runsN += runsPerD;
    minutesN += runsPerD * tN;
    D += 1;
  }

  // simulate cycles: C -> S -> N
  let cycles = 0;
  let lastSnap = null;

  while (cycles < maxCycles) {
    addCountessStep();
    lastSnap = bankableValue();
    if (lastSnap.totalBankableIst >= target) break;

    addSummonerStep();
    lastSnap = bankableValue();
    if (lastSnap.totalBankableIst >= target) break;

    addNihlStep();
    lastSnap = bankableValue();
    if (lastSnap.totalBankableIst >= target) break;

    cycles++;
  }

  const snap = lastSnap ?? bankableValue();

  const hoursC = minutesC / 60;
  const hoursS = minutesS / 60;
  const hoursN = minutesN / 60;
  const totalHours = hoursC + hoursS + hoursN;

  return {
    targetIst: target,
    phase,

    // Plan outputs
    hours: { countess: hoursC, summoner: hoursS, nihl: hoursN, total: totalHours },
    runs:  { countess: runsC, summoner: runsS, nihl: runsN },

    // Keys
    keys: { T, H, D, keysets: snap.keysets },

    // Drops (rounded ints for display)
    predictedDrops: {
      keysets: snap.keysets,
      extras: snap.extraRows.map(r => ({ name: r.name, pcs: r.piecesInt })),
      bonus: snap.bonusRows.map(r => ({ name: r.name, pcs: r.piecesInt }))
    },

    // Bankable accounting
    bankable: {
      keysIst: snap.keysValueIst,
      extrasIst: snap.extrasBankableIst,
      totalIst: snap.totalBankableIst,
      possibleBonusIst: snap.bonusPossibleIst
    },

    // For planner UI
    tradeList: snap.extraRows.filter(r => r.orders > 0).map(r => ({
      name: r.name,
      orders: r.orders,
      O: r.O,
      ist: r.ist
    })),
    possibleBonusTrades: snap.bonusRows.filter(r => r.orders > 0).map(r => ({
      name: r.name,
      orders: r.orders,
      O: r.O,
      ist: r.ist
    }))
  };
}
