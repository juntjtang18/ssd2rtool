// /model/keysPipeline.js
//
// Practical planner wrapper around /model/modelCore.js
//
// Goal:
//   - Keep modelCore "pure math" (EV, can be fractional keys/runs).
//   - In this pipeline/planner, convert theory outputs into *practical* planning numbers by
//     trimming non-bankable fractional drops:
//        * keys are integers (floor)
//        * extras drops (runes/gems/etc) are integers (floor)
//     and compute "bankable" Ist from integer drops only.
//
// Notes:
//   - 1 keyset (T+H+D) = 1 Ist (bankable). We treat keys as bankable only in full keysets.
//   - Extras are bankable only in full trade lots: floor(pieces / O) * N
//   - Bonus extras are shown for reference but NOT used in the stop condition.
//
// This makes runewords-planner.html use the same underlying schedule logic as model.html,
// while still giving a practical (no-fraction-drop) estimate.

import { getRuneQuote } from "./priceTable.js";
import { computeTheoryFromHours } from "./modelCore.js";
import { computeMapEvModel, deriveRunTcCounts } from "./mapEvCore.js";

// Default: items rarer than 1:250 are treated as "lottery" (bonus) revenue.
// Items with per-kill drop probability >= 1/250 are treated as "predictable" income.
const DEFAULT_PREDICTABLE_MIN_PROB = 1 / 250;

function splitExtras(extras) {
  const regular = [];
  const bonus = [];
  for (const x of (extras ?? [])) {
    const raw = String(x?.name ?? x?.id ?? "").trim();
    const dpr = Number(x?.dropPerRun ?? x?.D ?? x?.rate ?? 0);
    if (!raw || !(dpr > 0)) continue;

    if (/^BONUS\b/i.test(raw)) {
      const name = raw.replace(/^BONUS\s*/i, "").trim();
      if (name) bonus.push({ name, dropPerRun: dpr });
    } else {
      regular.push({ name: raw, dropPerRun: dpr });
    }
  }
  return { regular, bonus };
}

function buildDropRateMaps(extras) {
  const dropRateRegular = {};
  const dropRateBonus = {};
  for (const e of (extras ?? [])) {
    const raw = String(e?.name ?? e?.id ?? "").trim();
    const dpr = Number(e?.dropPerRun ?? e?.D ?? e?.rate ?? 0);
    if (!raw || !(dpr > 0)) continue;

    if (/^BONUS\b/i.test(raw)) {
      const name = raw.replace(/^BONUS\s*/i, "").trim().toUpperCase();
      if (name) dropRateBonus[name] = dpr;
    } else {
      const name = raw.toUpperCase();
      dropRateRegular[name] = dpr;
    }
  }
  return { dropRateRegular, dropRateBonus };
}

// ------------------------------
// TC-derived drop model (preferred)
// ------------------------------

function buildItemMaxProb({ runTcCounts, tcDropTable, priceTable, phase }) {
  const tcTable = tcDropTable?.tc ?? tcDropTable ?? {};
  const phaseData = priceTable?.phases?.[String(phase)] ?? {};
  const out = {}; // itemKeyUpper -> maxProb

  for (const [tcName, Nt] of Object.entries(runTcCounts ?? {})) {
    const n = Number(Nt ?? 0);
    if (!(n > 0)) continue;
    const drops = tcTable?.[tcName];
    if (!drops) continue;

    for (const [itemRaw, pRaw] of Object.entries(drops)) {
      const prob = Number(pRaw ?? 0);
      if (!(prob > 0)) continue;

      // Only track priced items (consistent with EV accounting).
      const q = getRuneQuote(priceTable, phase, itemRaw);
      const key = String(q?.key ?? itemRaw ?? "").trim().toUpperCase();
      const priced = Number(q?.priceIst ?? 0) > 0;
      if (!key || !priced) continue;

      out[key] = Math.max(out[key] ?? 0, prob);
    }
  }
  return out;
}

function mergeExpectedDropsAll(mapEvModel) {
  const p = mapEvModel?.predictable?.expectedDrops ?? {};
  const l = mapEvModel?.lottery?.expectedDrops ?? {};
  const out = { ...p };
  for (const [k, v] of Object.entries(l)) {
    out[k] = Number(out[k] ?? 0) + Number(v ?? 0);
  }
  return out;
}

function buildRotationDropModelFromTc({ tcDropTable, keyRuns, priceTable, phase, predictableMinProb }) {
  const phaseData = priceTable?.phases?.[String(phase)] ?? {};
  const minProb = Number(predictableMinProb ?? DEFAULT_PREDICTABLE_MIN_PROB);

  const bosses = [
    { id: "countess", run: keyRuns?.countess },
    { id: "summoner", run: keyRuns?.summoner },
    { id: "nihl", run: keyRuns?.nihl },
  ];

  const byBoss = {};
  const maxProbByItem = {}; // global max prob across all bosses
  const expDropsByBoss = {}; // bossId -> item -> expectedDropsPerRun
  const vexPlusLambdaPerRun = {}; // bossId -> lambda per run for Vex+

  for (const b of bosses) {
    if (!b.run) continue;
    const runTcCounts = deriveRunTcCounts({}, b.run);
    const m = computeMapEvModel({ runTcCounts, tcDropTable, phaseData, predictableMinProb: minProb });
    byBoss[b.id] = m;

    expDropsByBoss[b.id] = mergeExpectedDropsAll(m);

    const maxProbLocal = buildItemMaxProb({ runTcCounts, tcDropTable, priceTable, phase });
    for (const [k, p] of Object.entries(maxProbLocal)) {
      maxProbByItem[k] = Math.max(maxProbByItem[k] ?? 0, Number(p ?? 0));
    }

    const vex = m?.lottery?.vexPlusExpected ?? {};
    vexPlusLambdaPerRun[b.id] = Object.values(vex).reduce((a, x) => a + Number(x || 0), 0);
  }

  // Union of items across bosses.
  const items = new Set();
  for (const bm of Object.values(expDropsByBoss)) {
    for (const k of Object.keys(bm ?? {})) items.add(k);
  }

  // Build combined per-item drop rates by boss.
  const combined = {};
  for (const keyCanon of items) {
    const kUpper = String(keyCanon).trim().toUpperCase();
    const pMax = Number(maxProbByItem[kUpper] ?? 0);
    const bucket = pMax >= minProb ? "predictable" : "lottery";

    const dprC = Number(expDropsByBoss?.countess?.[keyCanon] ?? 0);
    const dprS = Number(expDropsByBoss?.summoner?.[keyCanon] ?? 0);
    const dprN = Number(expDropsByBoss?.nihl?.[keyCanon] ?? 0);
    const dprTotalPerRotationRun = dprC + dprS + dprN;
    if (!(dprTotalPerRotationRun > 0)) continue;

    // Ensure this item is priced (defensive).
    const q = getRuneQuote(priceTable, phase, keyCanon);
    if (!(Number(q?.priceIst ?? 0) > 0)) continue;

    combined[keyCanon] = { name: q.key ?? keyCanon, dprC, dprS, dprN, maxProb: pMax, bucket };
  }

  return { minProb, combined, vexPlusLambdaPerRun };
}

// Convert a theory schedule into "practical/bankable" snapshot:
// - keys truncated to integers and banked only as full keysets
// - extras pieces truncated to integers and banked only as full trade lots
function practicalFromSchedule({ schedule, extras, priceTable, phase }) {
  const { regular, bonus } = splitExtras(extras);

  // Keys (trim fractions)
  const T = Math.floor(Number(schedule?.keys?.terror ?? 0));
  const H = Math.floor(Number(schedule?.keys?.hate ?? 0));
  const D = Math.floor(Number(schedule?.keys?.destruction ?? 0));
  const keysets = Math.min(T, H, D);

  // Runs (EV). Used only to compute expected pieces before flooring.
  const Rc = Number(schedule?.runs?.Rc ?? 0);

  // Regular extras
  let extrasBankableIst = 0;
  const extraRows = [];
  for (const e of regular) {
    const name = String(e.name).trim();
    const pieces = Rc * Number(e.dropPerRun);
    const piecesInt = Math.floor(pieces); // "trim off any drops smaller than 1"

    const q = getRuneQuote(priceTable, phase, name); // {O,N,priceIst}
    if (!q || !(q.O > 0) || !(q.N > 0)) {
      extraRows.push({ name, piecesInt, O: 0, orders: 0, ist: 0, N: 0 });
      continue;
    }

    const orders = Math.floor(piecesInt / q.O);
    const bank = orders * q.N;
    if (orders > 0) extrasBankableIst += bank;

    extraRows.push({ name, piecesInt, O: q.O, orders, ist: bank, N: q.N });
  }
  extraRows.sort((a, b) => (b.ist || 0) - (a.ist || 0));

  // Bonus extras (display only)
  let bonusPossibleIst = 0;
  const bonusRows = [];
  for (const e of bonus) {
    const name = String(e.name).trim();
    const pieces = Rc * Number(e.dropPerRun);
    const piecesInt = Math.floor(pieces);

    const q = getRuneQuote(priceTable, phase, name);
    if (!q || !(q.O > 0) || !(q.N > 0)) {
      bonusRows.push({ name, piecesInt, O: 0, orders: 0, ist: 0, N: 0 });
      continue;
    }

    const orders = Math.floor(piecesInt / q.O);
    const bank = orders * q.N;
    bonusPossibleIst += bank;
    bonusRows.push({ name, piecesInt, O: q.O, orders, ist: bank, N: q.N });
  }
  bonusRows.sort((a, b) => (b.ist || 0) - (a.ist || 0));

  const keysValueIst = keysets; // 1 keyset = 1 Ist
  const totalBankableIst = keysValueIst + extrasBankableIst;

  return {
    // keys
    keys: { T, H, D, keysets },

    // bankable accounting
    bankable: {
      keysIst: keysValueIst,
      extrasIst: extrasBankableIst,
      totalIst: totalBankableIst,
      possibleBonusIst: bonusPossibleIst,
    },

    // detail rows for UI
    extraRows,
    bonusRows,
  };
}

// Same output shape as practicalFromSchedule, but drops are derived from tc-drop-table
// and include Countess + Summoner + Nihlathak.
function practicalFromScheduleTc({ schedule, dropModel, priceTable, phase }) {
  const Rc = Number(schedule?.runs?.Rc ?? 0);
  const Rs = Number(schedule?.runs?.Rs ?? 0);
  const Rn = Number(schedule?.runs?.Rn ?? 0);

  // Keys (trim fractions)
  const T = Math.floor(Number(schedule?.keys?.terror ?? 0));
  const H = Math.floor(Number(schedule?.keys?.hate ?? 0));
  const D = Math.floor(Number(schedule?.keys?.destruction ?? 0));
  const keysets = Math.min(T, H, D);

  const items = dropModel?.combined ?? {};

  let extrasBankableIst = 0;
  const extraRows = []; // predictable
  let bonusPossibleIst = 0;
  const bonusRows = []; // lottery

  for (const it of Object.values(items)) {
    const name0 = String(it?.name ?? "").trim();
    if (!name0) continue;

    const dprC = Number(it?.dprC ?? 0);
    const dprS = Number(it?.dprS ?? 0);
    const dprN = Number(it?.dprN ?? 0);

    const pieces = Rc * dprC + Rs * dprS + Rn * dprN;
    const piecesInt = Math.floor(pieces);

    const q = getRuneQuote(priceTable, phase, name0); // {O,N,priceIst,key}
    if (!q || !(q.O > 0) || !(q.N > 0)) continue;

    const orders = Math.floor(piecesInt / q.O);
    const bank = orders * q.N;
    const row = {
      name: q.key ?? name0,
      piecesInt,
      O: q.O,
      orders,
      ist: bank,
      N: q.N,
      dropRate: Number(it?.maxProb ?? 0),
    };

    if (String(it?.bucket) === "predictable") {
      if (orders > 0) extrasBankableIst += bank;
      extraRows.push(row);
    } else {
      bonusPossibleIst += bank;
      bonusRows.push(row);
    }
  }

  extraRows.sort((a, b) => (b.ist || 0) - (a.ist || 0));
  bonusRows.sort((a, b) => (b.ist || 0) - (a.ist || 0));

  const keysValueIst = keysets; // 1 keyset = 1 Ist
  const totalBankableIst = keysValueIst + extrasBankableIst;

  // Vex+ odds for the whole schedule (Poisson on combined lambda)
  const lam =
    Rc * Number(dropModel?.vexPlusLambdaPerRun?.countess ?? 0) +
    Rs * Number(dropModel?.vexPlusLambdaPerRun?.summoner ?? 0) +
    Rn * Number(dropModel?.vexPlusLambdaPerRun?.nihl ?? 0);
  const vexPlusChance = 1 - Math.exp(-Math.max(0, lam));

  return {
    keys: { T, H, D, keysets },
    bankable: {
      keysIst: keysValueIst,
      extrasIst: extrasBankableIst,
      totalIst: totalBankableIst,
      possibleBonusIst: bonusPossibleIst,
      vexPlusChance,
    },
    extraRows,
    bonusRows,
  };
}

/**
 * Planner API used by runewords-planner.html
 *
 * It finds the required hours such that:
 *    bankable(keys + regular extras) >= targetIst * buffer
 *
 * using the SAME schedule logic as modelCore (EV scheduling),
 * then trims fractional drops to integers for a practical result.
 */
export function planRotationToTargetIst({
  targetIst,
  phase,
  priceTable,
  params,
  buffer = 1.0,
  // Optional: if provided, we derive drops from tc-drop-table instead of hard-coded extras.
  tcDropTable = null,
  keyRuns = null,
  predictableMinProb = DEFAULT_PREDICTABLE_MIN_PROB,
}) {
  const Dc = Number(params.Dc);
  const Ds = Number(params.Ds);
  const Dn = Number(params.Dn);

  const tC = Number(params.tC_min);
  const tS = Number(params.tS_min);
  const tN = Number(params.tN_min);

  if (!(Dc > 0 && Ds > 0 && Dn > 0 && tC > 0 && tS > 0 && tN > 0)) {
    throw new Error("Invalid key pipeline parameters (D* and t*_min must be > 0).");
  }

  const extras = Array.isArray(params.extras) ? params.extras : [];

  const useTcModel = !!(tcDropTable && keyRuns && priceTable);

  const dropModel = useTcModel
    ? buildRotationDropModelFromTc({ tcDropTable, keyRuns, priceTable, phase, predictableMinProb })
    : null;

  const { dropRateRegular, dropRateBonus } = buildDropRateMaps(extras);

  const target = Math.ceil(Number(targetIst) * buffer);
  if (!(target > 0)) throw new Error("targetIst must be > 0");

  const theorySchedule = (hours) =>
    computeTheoryFromHours({
      hours,
      Dc,
      Ds,
      Dn,
      tC_min: tC,
      tS_min: tS,
      tN_min: tN,
      // IMPORTANT: keep modelCore pure; we don't use its extras valuation here.
      // We compute practical extras from schedule.runs.Rc in this module.
      extras: [],
      phaseData: {},
    }).schedule;

  const practicalTotal = (hours) => {
    const sched = theorySchedule(hours);
    const snap = useTcModel
      ? practicalFromScheduleTc({ schedule: sched, dropModel, priceTable, phase })
      : practicalFromSchedule({ schedule: sched, extras, priceTable, phase });
    return { sched, snap, total: snap.bankable.totalIst };
  };

  // Bracket
  let lo = 0;
  let hi = Math.max(0.25, target / 0.5);
  let rHi = practicalTotal(hi);
  let guard = 0;
  while (rHi.total < target && guard < 40) {
    hi *= 2;
    rHi = practicalTotal(hi);
    guard++;
  }
  if (guard >= 40) throw new Error("Failed to bracket target hours (check parameters).");

  // Bisection
  let best = rHi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const rMid = practicalTotal(mid);
    if (rMid.total >= target) {
      hi = mid;
      best = rMid;
    } else {
      lo = mid;
    }
  }

  const schedule = best.sched;
  const snap = best.snap;

  // Hours/runs by boss from schedule (EV)
  const runsC = Number(schedule?.runs?.Rc ?? 0);
  const runsS = Number(schedule?.runs?.Rs ?? 0);
  const runsN = Number(schedule?.runs?.Rn ?? 0);

  const minutesC = runsC * tC;
  const minutesS = runsS * tS;
  const minutesN = runsN * tN;

  const hoursC = minutesC / 60;
  const hoursS = minutesS / 60;
  const hoursN = minutesN / 60;

  const totalHours = hoursC + hoursS + hoursN;

  return {
    targetIst: target,
    phase,

    hours: { countess: hoursC, summoner: hoursS, nihl: hoursN, total: totalHours },
    runs: { countess: runsC, summoner: runsS, nihl: runsN },

    // Keys (practical)
    keys: { ...snap.keys },

    // Drops for display (practical ints) + include dropRate for filtering
    predictedDrops: {
      keysets: snap.keys.keysets,
      extras: snap.extraRows.map((r) => ({
        name: r.name,
        pcs: r.piecesInt,
        dropRate: useTcModel ? Number(r.dropRate ?? 0) : (dropRateRegular[String(r.name || "").toUpperCase()] ?? 0),
      })),
      bonus: snap.bonusRows.map((r) => ({
        name: r.name,
        pcs: r.piecesInt,
        dropRate: useTcModel ? Number(r.dropRate ?? 0) : (dropRateBonus[String(r.name || "").toUpperCase()] ?? 0),
      })),
      vexPlusChance: useTcModel ? Number(snap.bankable?.vexPlusChance ?? 0) : 0,
      predictableMinProb: useTcModel ? Number(dropModel?.minProb ?? 0) : 0,
    },

    // Bankable accounting (practical)
    bankable: {
      keysIst: snap.bankable.keysIst,
      extrasIst: snap.bankable.extrasIst,
      totalIst: snap.bankable.totalIst,
      possibleBonusIst: snap.bankable.possibleBonusIst,
      vexPlusChance: snap.bankable?.vexPlusChance ?? 0,
    },

    // For planner UI (trade list)
    tradeList: snap.extraRows
      .filter((r) => r.orders > 0)
      .map((r) => ({ name: r.name, orders: r.orders, O: r.O, ist: r.ist })),

    possibleBonusTrades: snap.bonusRows
      .filter((r) => r.orders > 0)
      .map((r) => ({ name: r.name, orders: r.orders, O: r.O, ist: r.ist })),
  };
}
