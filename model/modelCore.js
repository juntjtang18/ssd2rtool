// /model/modelCore.js
import { computeMapEvModel, deriveRunTcCounts } from "./mapEvCore.js";

const DEFAULT_PREDICTABLE_MIN_PROB = 1 / 250; // drop rate >= 1:250 => predictable

// D2R Keys Model — Theory EV using "1-key-at-a-time" scheduling per boss.
// Repo file structure assumptions:
//   /config/model-parameters.json
//   /config/rune-price-table.json
//   /pages/model.html imports this module via: ../model/modelCore.js
//
// Algorithm (as specified by user):
// A) For each boss i in rotation (C -> S -> N -> ...):
//    - Expected runs to get 1 key: runsPerKey = 1 / D_i
//    - Expected time to get 1 key: timePerKey = runsPerKey * t_i
//    - If remaining time >= timePerKey: gain 1 key; spend timePerKey; add runsPerKey
//      Else: gain fractional key = remaining / timePerKey; add fractional runs; spend remaining; stop.
//    - If boss is Countess, accumulate countess_runs.
// B) extras EV and bonus EV are computed from countess_runs only.
// C) Key value uses: 1 key = 1/3 Ist (implied by 1 keyset=1 Ist).
//    totalIstExclBonus = keyIst + extrasRegularIst
//    bonusIst is tracked separately.
//
// Note: We optimize by grouping full "key-cycles" (C,S,N) where we complete 1 key each boss.

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function loadModelConfigs() {
  // GitHub Pages project site safe: resolve relative to this module's URL.
  const mpUrl = new URL("../config/model-parameters.json", import.meta.url);
  const ptUrl = new URL("../config/rune-price-table.json", import.meta.url);

  // Optional (used by MapEV-style models + key pipeline improvements)
  const tcUrl = new URL("../config/tc/tc-drop-table.hell.p1.json", import.meta.url);
  const runCountessUrl = new URL("../config/map_runs/tower-cellar-5.hell.p1.run.json", import.meta.url);
  const runSummonerUrl = new URL("../config/map_runs/arcane-sanctuary.hell.p1.run.json", import.meta.url);
  const runNihlUrl = new URL("../config/map_runs/nilh-halls.hell.p1.run.json", import.meta.url);

  const [modelParameters, priceTable, tcDropTable, runCountess, runSummoner, runNihl] = await Promise.all([
    fetchJson(mpUrl.href),
    fetchJson(ptUrl.href),
    fetchJson(tcUrl.href),
    fetchJson(runCountessUrl.href),
    fetchJson(runSummonerUrl.href),
    fetchJson(runNihlUrl.href),
  ]);

  const keyRuns = { countess: runCountess, summoner: runSummoner, nihl: runNihl };

  return {
    modelParameters,
    priceTable,
    tcDropTable,
    keyRuns,
    paths: {
      mp: mpUrl.href,
      pt: ptUrl.href,
      tc: tcUrl.href,
      runCountess: runCountessUrl.href,
      runSummoner: runSummonerUrl.href,
      runNihl: runNihlUrl.href,
    },
  };
}



function rotationEvValues({ schedule, tcDropTable, keyRuns, phaseData, predictableMinProb }) {
  const hasTc = tcDropTable && keyRuns && phaseData;
  if (!hasTc) {
    return { extrasRegularIst: 0, bonusIst: 0, vexPlusProb: 0 };
  }

  const bosses = [
    { id: "countess", runs: Number(schedule?.runs?.Rc ?? 0), runCfg: keyRuns.countess },
    { id: "summoner", runs: Number(schedule?.runs?.Rs ?? 0), runCfg: keyRuns.summoner },
    { id: "nihl", runs: Number(schedule?.runs?.Rn ?? 0), runCfg: keyRuns.nihl },
  ];

  let regularIst = 0;
  let bonusIst = 0;
  let vexPlusLambda = 0;

  for (const b of bosses) {
    if (!b.runCfg || !(b.runs > 0)) continue;
    const runTcCounts = deriveRunTcCounts({}, b.runCfg);
    const m = computeMapEvModel({ runTcCounts, tcDropTable, phaseData, predictableMinProb });

    regularIst += Number(m?.predictable?.istPerRun ?? 0) * b.runs;
    bonusIst += Number(m?.lottery?.istPerRun ?? 0) * b.runs;
    vexPlusLambda += Number(m?.lottery?.vexPlusExpected ?? 0) * b.runs;
  }

  const vexPlusProb = vexPlusLambda > 0 ? (1 - Math.exp(-vexPlusLambda)) : 0;
  return { extrasRegularIst: regularIst, bonusIst, vexPlusProb };
}

export function getPhaseOptions(priceTable) {
  const phases = priceTable?.phases ?? {};
  const keys = Object.keys(phases);
  const defaultPhase = String(priceTable?.defaultPhase ?? (keys.length ? keys[0] : "1"));
  return { phases, defaultPhase };
}

// Price-table convention: { O: items, N: ist } => 1 item = N/O Ist
export function priceInIst(name, phaseData) {
  // Align with /model/priceTable.js normalization: uppercase rune keys (e.g., "Ral" -> "RAL").
  const key = String(name ?? "").trim().toUpperCase();
  if (!key) return 0;

  const entry = phaseData?.[key];
  if (!entry) return 0;

  const O = Number(entry.O ?? 0);
  const N = Number(entry.N ?? 0);
  if (!(O > 0) || !(N > 0)) return 0;

  return N / O;
}


function splitExtras(extras) {
  const regular = [];
  const bonus = [];
  for (const x of (extras ?? [])) {
    const rawName = String(x?.name ?? "").trim();
    const dropPerRun = Number(x?.dropPerRun ?? 0);
    if (!rawName || !(dropPerRun > 0)) continue;

    if (/^BONUS\b/i.test(rawName)) {
      const name = rawName.replace(/^BONUS\s*/i, "").trim();
      if (name) bonus.push({ name, dropPerRun });
    } else {
      regular.push({ name: rawName, dropPerRun });
    }
  }
  return { regular, bonus };
}

function extrasValuePerCountessRun(extras, phaseData) {
  const { regular, bonus } = splitExtras(extras);
  const vRegular = regular.reduce((acc, x) => acc + x.dropPerRun * priceInIst(x.name, phaseData), 0);
  const vBonus = bonus.reduce((acc, x) => acc + x.dropPerRun * priceInIst(x.name, phaseData), 0);
  return { vRegular, vBonus, regular, bonus };
}

function scheduleFromHours({
  hours, Dc, Ds, Dn, tC_min, tS_min, tN_min
}) {
  const H = Number(hours);
  const totalMin = H * 60;

  // Expected runs/time for 1 key at each boss
  const rpkC = 1 / Dc, rpkS = 1 / Ds, rpkN = 1 / Dn;
  const tpkC = rpkC * tC_min, tpkS = rpkS * tS_min, tpkN = rpkN * tN_min;

  const cycleMin = tpkC + tpkS + tpkN;
  if (!(cycleMin > 0)) throw new Error("Invalid cycleMin (check D and t).");

  // Full cycles: 1 key per boss
  const fullCycles = Math.floor(totalMin / cycleMin);
  let rem = totalMin - fullCycles * cycleMin;

  // Keys gained (EV, can be fractional only for the last boss in the tail)
  let kT = fullCycles, kH = fullCycles, kD = fullCycles;

  // Runs used (EV, generally fractional due to 1/D)
  let Rc = fullCycles * rpkC;
  let Rs = fullCycles * rpkS;
  let Rn = fullCycles * rpkN;

  // Tail: try to complete +1 key for C, then S, then N, and last one may be fractional
  const tail = [];
  function step(label, tpk, rpk) {
    if (rem <= 1e-12) return { done: true, fracKey: 0, timeUsed: 0, runsUsed: 0 };
    if (rem >= tpk) {
      rem -= tpk;
      tail.push({ boss: label, key: 1, timeMin: tpk, runs: rpk, fractional: false });
      return { done: false, fracKey: 1, timeUsed: tpk, runsUsed: rpk };
    } else {
      const frac = rem / tpk;
      const timeUsed = rem;
      rem = 0;
      const runsUsed = rpk * frac;
      tail.push({ boss: label, key: frac, timeMin: timeUsed, runs: runsUsed, fractional: true });
      return { done: true, fracKey: frac, timeUsed, runsUsed };
    }
  }

  let s = step("C", tpkC, rpkC);
  kT += s.fracKey; Rc += s.runsUsed;
  if (!s.done) {
    s = step("S", tpkS, rpkS);
    kH += s.fracKey; Rs += s.runsUsed;
  }
  if (!s.done) {
    s = step("N", tpkN, rpkN);
    kD += s.fracKey; Rn += s.runsUsed;
  }

  const usedMin = totalMin - rem;
  const countessMin = Rc * tC_min;

  return {
    totalMin,
    usedMin,
    unusedMin: rem,
    fullCycles,
    cycleMin,
    runs: { Rc, Rs, Rn },
    keys: { terror: kT, hate: kH, destruction: kD },
    timePerKey: { C: tpkC, S: tpkS, N: tpkN },
    runsPerKey: { C: rpkC, S: rpkS, N: rpkN },
    tail,
    countessMin,
  };
}

export function computeTheoryFromHours(params) {
  const H = Number(params?.hours);
  if (!(H > 0)) throw new Error("hours must be > 0");

  const Dc = Number(params?.Dc), Ds = Number(params?.Ds), Dn = Number(params?.Dn);
  const tC_min = Number(params?.tC_min), tS_min = Number(params?.tS_min), tN_min = Number(params?.tN_min);
  const phaseData = params?.phaseData ?? {};
  const extras = params?.extras ?? [];
  const tcDropTable = params?.tcDropTable ?? null;
  const keyRuns = params?.keyRuns ?? null;
  const predictableMinProb = Number(params?.predictableMinProb ?? DEFAULT_PREDICTABLE_MIN_PROB);

  const sched = scheduleFromHours({ hours: H, Dc, Ds, Dn, tC_min, tS_min, tN_min });

  // Key value: 1 key = 1/3 Ist
  const kT = sched.keys.terror, kH = sched.keys.hate, kD = sched.keys.destruction;
  const keyIst = (kT + kH + kD) / 3;
  const keysetsEV = Math.min(kT, kH, kD);

  let extrasRegularIst = 0;
  let bonusIst = 0;
  let vexPlusProb = 0;

  if (tcDropTable && keyRuns) {
    const ev = rotationEvValues({ schedule: sched, tcDropTable, keyRuns, phaseData, predictableMinProb });
    extrasRegularIst = ev.extrasRegularIst;
    bonusIst = ev.bonusIst;
    vexPlusProb = ev.vexPlusProb;
  } else {
    const { vRegular, vBonus } = extrasValuePerCountessRun(extras, phaseData);
    const Rc = sched.runs.Rc;
    extrasRegularIst = Rc * vRegular;
    bonusIst = Rc * vBonus;
  }

  const totalIstExclBonus = keyIst + extrasRegularIst;
  const totalIstInclBonus = totalIstExclBonus + bonusIst;

  return {
    schedule: sched,
    values: {
      keyIst,
      keysetsEV,
      extrasRegularIst,
      bonusIst,
      totalIstExclBonus,
      totalIstInclBonus,
      vexPlusProb,
    },
    rates: {
      istPerHourExclBonus: totalIstExclBonus / H,
      bonusPerHour: bonusIst / H,
      istPerHourInclBonus: totalIstInclBonus / H,
      keysetsPerHourEV: keysetsEV / H,
      keysPerHourEV: { terror: kT / H, hate: kH / H, destruction: kD / H },
    }
  };
}

// Find hours needed to reach target Ist (exclude bonus) using bisection (monotonic).
export function computeTheoryFromTargetIst(params) {
  const Y = Number(params?.targetIst);
  if (!(Y > 0)) throw new Error("targetIst must be > 0");

  const Dc = Number(params?.Dc), Ds = Number(params?.Ds), Dn = Number(params?.Dn);
  const tC_min = Number(params?.tC_min), tS_min = Number(params?.tS_min), tN_min = Number(params?.tN_min);
  const phaseData = params?.phaseData ?? {};
  const extras = params?.extras ?? [];

  const f = (hours) => computeTheoryFromHours({
    hours,
    Dc, Ds, Dn,
    tC_min, tS_min, tN_min,
    extras,
    phaseData,
    tcDropTable: params?.tcDropTable ?? null,
    keyRuns: params?.keyRuns ?? null,
    predictableMinProb: params?.predictableMinProb ?? DEFAULT_PREDICTABLE_MIN_PROB,
  });

  // Upper bound search
  let lo = 0;
  let hi = Math.max(0.25, Y / 0.5); // start somewhat safely
  let rHi = f(hi);
  let guard = 0;
  while (rHi.values.totalIstExclBonus < Y && guard < 40) {
    hi *= 2;
    rHi = f(hi);
    guard++;
  }
  if (guard >= 40) throw new Error("Failed to bracket target hours (check parameters).");

  // Bisection
  let best = rHi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const rMid = f(mid);
    if (rMid.values.totalIstExclBonus >= Y) {
      hi = mid;
      best = rMid;
    } else {
      lo = mid;
    }
  }

  return {
    required: { hours: hi },
    result: best
  };
}
