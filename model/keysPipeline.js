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
import { computeMapEvModel } from "./mapEvCore.js";
// -----------------------------
// Keyset pricing
// -----------------------------
// Price-table convention (same as other items): { O: items, N: ist } => 1 item = N/O Ist.
// In the UI price table, UKEY refers to an individual key (not a full keyset).
// Therefore: 1 keyset (T+H+D) = 3 keys => keysetPriceIst = 3 * keyPriceIst.
// Fallback to 1 Ist per keyset if UKEY is missing/unpriced (legacy behavior).
function getKeysetPriceIst(priceTable, phase) {
  const q = getRuneQuote(priceTable, phase, "UKEY");
  if (!q || !(q.O > 0) || !(q.N > 0)) return 1;
  const keyPriceIst = Number(q.priceIst ?? (q.N / q.O));
  if (!(keyPriceIst > 0)) return 1;
  return 3 * keyPriceIst;
}

// -----------------------------
// Legacy extras helper (model-parameters.json extras)
// -----------------------------

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

  const keysetPriceIst = getKeysetPriceIst(priceTable, phase);
  const keysValueIst = keysets * keysetPriceIst; // keysets -> Ist using UKEY price
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

// -----------------------------
// TC / MapEV-based planner helpers
// -----------------------------

function tcCountsFromRunConfig(runJson) {
  // Key-run configs store boss TC rolls under guaranteed.tcSet
  return runJson?.guaranteed?.tcSet ?? {};
}

function computeBossMapEv({ runJson, tcDropTable, phaseData }) {
  const runTcCounts = tcCountsFromRunConfig(runJson);
  return computeMapEvModel({
    runTcCounts,
    tcDropTable,
    phaseData,
    // IMPORTANT: For planning, we want *all* priced items' expectedDrops.
    // We will do our own Predictable/Lottery split using the IST threshold.
    predictableMinProb: 0,
  });
}

function poissonAtLeastOne(lambda) {
  const l = Math.max(0, Number(lambda || 0));
  return 1 - Math.exp(-l);
}

const VEX_PLUS = ["VEX", "OHM", "LO", "SUR", "BER", "JAH", "CHAM", "ZOD"];
const LO_PLUS = ["LO", "SUR", "BER", "JAH", "CHAM", "ZOD"];
const JAH_PLUS = ["JAH", "CHAM", "ZOD"];

function groupLambda({ runsByBoss, vexPlusExpectedByBoss, runes }) {
  // runsByBoss: {countess, summoner, nihl}
  // vexPlusExpectedByBoss[boss][rune] = expected drops per run (lambda)
  let lam = 0;
  for (const boss of ["countess", "summoner", "nihl"]) {
    const runs = Number(runsByBoss?.[boss] ?? 0);
    if (!(runs > 0)) continue;
    const byRune = vexPlusExpectedByBoss?.[boss] ?? {};
    for (const r of runes) {
      lam += runs * Number(byRune?.[r] ?? 0);
    }
  }
  return lam;
}

function practicalFromScheduleTc({ schedule, priceTable, phase, tcCtx }) {
  // Keys (trim fractions)
  const T = Math.floor(Number(schedule?.keys?.terror ?? 0));
  const H = Math.floor(Number(schedule?.keys?.hate ?? 0));
  const D = Math.floor(Number(schedule?.keys?.destruction ?? 0));
  const keysets = Math.min(T, H, D);

  const runsC = Number(schedule?.runs?.Rc ?? 0);
  const runsS = Number(schedule?.runs?.Rs ?? 0);
  const runsN = Number(schedule?.runs?.Rn ?? 0);
  const runsByBoss = { countess: runsC, summoner: runsS, nihl: runsN };

  const thr = Number(tcCtx?.istThresholdPerRun ?? 0);
  const mC = tcCtx?.bossModels?.countess;
  const mS = tcCtx?.bossModels?.summoner;
  const mN = tcCtx?.bossModels?.nihl;

  const expC = mC?.predictable?.expectedDrops ?? {};
  const expS = mS?.predictable?.expectedDrops ?? {};
  const expN = mN?.predictable?.expectedDrops ?? {};

  // Union of all priced items seen across bosses
  const items = new Set([
    ...Object.keys(expC),
    ...Object.keys(expS),
    ...Object.keys(expN),
  ]);

  let extrasBankableIst = 0;
  const extraRows = [];

  for (const item of items) {
    const name = String(item || "").trim();
    if (!name) continue;
    const upper = name.toUpperCase();

    // IMPORTANT: UKEY is the key currency; keys are already counted via keysets.
    if (upper === "UKEY") continue;

    const lamC = Number(expC[name] ?? expC[upper] ?? 0);
    const lamS = Number(expS[name] ?? expS[upper] ?? 0);
    const lamN = Number(expN[name] ?? expN[upper] ?? 0);
    const lamMax = Math.max(lamC, lamS, lamN);

    // Predictable vs Lottery split using Countess IST expectedDropsPerRun threshold.
    // If threshold missing, treat everything as predictable.
    const isPredictable = !(thr > 0) ? true : (lamMax >= thr);
    if (!isPredictable) continue;

    const pieces = runsC * lamC + runsS * lamS + runsN * lamN;
    const piecesInt = Math.floor(pieces);
    if (!(piecesInt >= 1)) continue;

    const q = getRuneQuote(priceTable, phase, name);
    if (!q || !(q.O > 0) || !(q.N > 0)) {
      extraRows.push({ name, piecesInt, O: 0, orders: 0, ist: 0, N: 0 });
      continue;
    }

    const orders = Math.floor(piecesInt / q.O);
    const bank = orders * q.N;
    if (orders > 0) extrasBankableIst += bank;
    extraRows.push({ name: q.key ?? name, piecesInt, O: q.O, orders, ist: bank, N: q.N });
  }

  extraRows.sort((a, b) => (b.ist || 0) - (a.ist || 0));

  const keysetPriceIst = getKeysetPriceIst(priceTable, phase);
  const keysValueIst = keysets * keysetPriceIst;
  const totalBankableIst = keysValueIst + extrasBankableIst;

  // Lottery probabilities: Vex+, Lo+, Jah+ (>=1) over the whole plan.
  const vexPlusExpectedByBoss = {
    countess: tcCtx?.bossModels?.countess?.lottery?.vexPlusExpected ?? {},
    summoner: tcCtx?.bossModels?.summoner?.lottery?.vexPlusExpected ?? {},
    nihl: tcCtx?.bossModels?.nihl?.lottery?.vexPlusExpected ?? {},
  };

  const lamVex = groupLambda({ runsByBoss, vexPlusExpectedByBoss, runes: VEX_PLUS });
  const lamLo = groupLambda({ runsByBoss, vexPlusExpectedByBoss, runes: LO_PLUS });
  const lamJah = groupLambda({ runsByBoss, vexPlusExpectedByBoss, runes: JAH_PLUS });

  const lotteryProbs = {
    vexPlus: poissonAtLeastOne(lamVex),
    loPlus: poissonAtLeastOne(lamLo),
    jahPlus: poissonAtLeastOne(lamJah),
  };

  return {
    keys: { T, H, D, keysets },
    bankable: {
      keysIst: keysValueIst,
      extrasIst: extrasBankableIst,
      totalIst: totalBankableIst,
    },
    extraRows,
    lotteryProbs,
    istThresholdPerRun: thr,
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
  tcDropTable = null,
  keyRuns = null,
  buffer = 1.0,
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
  const { dropRateRegular, dropRateBonus } = buildDropRateMaps(extras);

  // Optional: TC/MapEV-based drops model (preferred). If missing, fall back to legacy extras.
  let tcCtx = null;
  if (tcDropTable && keyRuns?.countess && keyRuns?.summoner && keyRuns?.nihl) {
    const phaseData = priceTable?.phases?.[phase] ?? {};
    const bossModels = {
      countess: computeBossMapEv({ runJson: keyRuns.countess, tcDropTable, phaseData }),
      summoner: computeBossMapEv({ runJson: keyRuns.summoner, tcDropTable, phaseData }),
      nihl: computeBossMapEv({ runJson: keyRuns.nihl, tcDropTable, phaseData }),
    };

    const istThr = Number(
      bossModels?.countess?.predictable?.expectedDrops?.IST ??
      bossModels?.countess?.predictable?.expectedDrops?.Ist ??
      bossModels?.countess?.predictable?.expectedDrops?.ist ??
      0
    );

    tcCtx = {
      bossModels,
      // If IST isn't found for some reason, default to 1/250 as a safe-ish boundary.
      istThresholdPerRun: istThr > 0 ? istThr : (1 / 250),
    };
  }

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
    const snap = tcCtx
      ? practicalFromScheduleTc({ schedule: sched, priceTable, phase, tcCtx })
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

  // Build UI payload. Legacy mode returns bonus rows; TC mode returns lottery probabilities.
  const predictedDrops = tcCtx
    ? {
        keysets: snap.keys.keysets,
        predictable: snap.extraRows.map((r) => ({ name: r.name, pcs: r.piecesInt })),
        lotteryProbs: snap.lotteryProbs,
        istThresholdPerRun: snap.istThresholdPerRun,
      }
    : {
        keysets: snap.keys.keysets,
        extras: snap.extraRows.map((r) => ({
          name: r.name,
          pcs: r.piecesInt,
          dropRate: dropRateRegular[String(r.name || "").toUpperCase()] ?? 0,
        })),
        bonus: snap.bonusRows.map((r) => ({
          name: r.name,
          pcs: r.piecesInt,
          dropRate: dropRateBonus[String(r.name || "").toUpperCase()] ?? 0,
        })),
      };

  const bankable = tcCtx
    ? {
        keysIst: snap.bankable.keysIst,
        extrasIst: snap.bankable.extrasIst,
        totalIst: snap.bankable.totalIst,
      }
    : {
        keysIst: snap.bankable.keysIst,
        extrasIst: snap.bankable.extrasIst,
        totalIst: snap.bankable.totalIst,
        possibleBonusIst: snap.bankable.possibleBonusIst,
      };

  const tradeList = snap.extraRows
    .filter((r) => r.orders > 0)
    .map((r) => ({ name: r.name, orders: r.orders, O: r.O, ist: r.ist }));

  const possibleBonusTrades = tcCtx
    ? []
    : snap.bonusRows
        .filter((r) => r.orders > 0)
        .map((r) => ({ name: r.name, orders: r.orders, O: r.O, ist: r.ist }));

  return {
    targetIst: target,
    phase,

    hours: { countess: hoursC, summoner: hoursS, nihl: hoursN, total: totalHours },
    runs: { countess: runsC, summoner: runsS, nihl: runsN },

    // Keys (practical)
    keys: { ...snap.keys },

    predictedDrops,
    bankable,
    tradeList,
    possibleBonusTrades,
  };
}
