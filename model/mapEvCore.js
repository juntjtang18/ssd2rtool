// /model/mapEvCore.js
// Map EV model (currency-only) with a split:
//   PredictableValue: priced items with per-mob probability >= 1%
//   LotteryValue: priced items with per-mob probability < 1%
//   Vex+ odds: probability of getting at least one Vex+ rune (Poisson approx)
//
// PredictableValue (IST/run):
//   sum_tc( Nt * sum_item( V_item * P_tc_item ) ) for P_tc_item >= 0.01
//
// LotteryValue (IST/run):
//   sum_tc( Nt * sum_item( V_item * P_tc_item ) ) for 0 < P_tc_item < 0.01
//
// Vex+ odds (prob/run):
//   Let lambda = sum_over_VexPlus( expected_count_per_run(rune) )
//   Then P(at least one Vex+ rune) ~= 1 - exp(-lambda)
//   Per-rune: P(at least one of rune R) ~= 1 - exp(-lambda_R)
//
// Inputs:
//  - /config/rune-price-table.json (phase-based pricing; V_item in Ist)
//  - /config/tc/tc-drop-table.hell.p1.json (P_tc_item)
//  - /config/maps/<map>.hell.p1.json (baseline N_tc for a full clear; "median source")
//  - /config/map_runs/<map>.hell.p1.run.json (run filter knobs; model input)

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function loadMapEvIndex(indexName = "map-ev-index.hell.p1.json") {
  const idxUrl = new URL(`../config/${indexName}`, import.meta.url);
  return { index: await fetchJson(idxUrl.href), url: idxUrl.href };
}

export async function loadMapEvBundle(entry, indexMeta) {
  // entry.mapFile / entry.runFile are relative to /config
  const base = new URL("../config/", import.meta.url);

  const mapUrl = new URL(entry.mapFile.replace(/^\.\//, ""), base);
  const runUrl = new URL(entry.runFile.replace(/^\.\//, ""), base);

  // tcDropTable path comes from indexMeta.tcDropTable
  const tcUrl = new URL(indexMeta.tcDropTable.replace(/^\.\//, ""), base);
  const ptUrl = new URL(indexMeta.priceTable.replace(/^\.\//, ""), base);

  const [map, run, tcDrop, priceTable] = await Promise.all([
    fetchJson(mapUrl.href),
    fetchJson(runUrl.href),
    fetchJson(tcUrl.href),
    fetchJson(ptUrl.href),
  ]);

  return {
    map,
    run,
    tcDrop,
    priceTable,
    urls: { map: mapUrl.href, run: runUrl.href, tc: tcUrl.href, pt: ptUrl.href },
  };
}

export function getPhaseOptions(priceTable) {
  const phases = priceTable?.phases ?? {};
  const keys = Object.keys(phases);
  const defaultPhase = String(priceTable?.defaultPhase ?? (keys.length ? keys[0] : "1"));
  return { phases, defaultPhase };
}

// ------------------------------
// Case-insensitive key handling
// ------------------------------
// We treat ALL lookups (TC names, item names, price keys) as case-insensitive.
// Internally we still keep a canonical key for display/aggregation:
//  - For priced items: canonical key comes from the price table key casing.
//  - For TCs: canonical key comes from the tc-drop-table key casing.

const _caseIndexCache = new WeakMap();

function getCaseIndex(obj) {
  if (!obj || typeof obj !== "object") return null;
  let idx = _caseIndexCache.get(obj);
  if (idx) return idx;
  idx = new Map();
  for (const k of Object.keys(obj)) {
    idx.set(String(k).toLowerCase(), k);
  }
  _caseIndexCache.set(obj, idx);
  return idx;
}

function canonicalKey(rawKey, obj) {
  const k = String(rawKey ?? "").trim();
  if (!k) return "";
  const idx = getCaseIndex(obj);
  return idx?.get(k.toLowerCase()) ?? k;
}

// Price-table convention: { O: items, N: ist } => 1 item = N/O Ist
function lookupPrice(itemKey, phaseData) {
  const raw = String(itemKey ?? "").trim();
  if (!raw) return { key: "", value: 0 };

  const key = canonicalKey(raw, phaseData);
  const entry = phaseData?.[key];
  if (!entry) return { key, value: 0 };

  const O = Number(entry.O ?? 0);
  const N = Number(entry.N ?? 0);
  if (!(O > 0) || !(N > 0)) return { key, value: 0 };

  return { key, value: N / O };
}

export function priceInIst(itemKey, phaseData) {
  return lookupPrice(itemKey, phaseData).value;
}

export function deriveRunTcCounts(mapTcCounts, runCfg) {
  // NOTE: killPct has been removed.
  // We now support either:
  //  - baseline map tcCounts (default)
  //  - tcSet-only runs (base.useMapTcCounts=false) for boss rushes / measured runs
  // Back-compat: if legacy runCfg.killModel exists, we still read tcMul/tcZero.
  const legacyKillModel = runCfg?.killModel ?? {};
  const tcOverride = runCfg?.tcOverride ?? {};
  const guaranteed = runCfg?.guaranteed ?? {};

  const useMapTcCounts = runCfg?.base?.useMapTcCounts !== false;

  const tcMul = tcOverride.tcMul ?? legacyKillModel.tcMul ?? {};
  const tcZero = new Set([...(tcOverride.tcZero ?? []), ...(legacyKillModel.tcZero ?? [])].map(String));

  const tcSet = guaranteed.tcSet ?? {};
  const tcAdd = guaranteed.tcAdd ?? {};

  const out = {};

  // 1) baseline map tcCounts (optional)
  if (useMapTcCounts) {
    for (const [tc, n] of Object.entries(mapTcCounts ?? {})) {
      const base = Number(n ?? 0);
      if (!Number.isFinite(base) || base <= 0) continue;
      out[tc] = base;
    }
  }

  // 2) tcMul overrides
  for (const [tc, mul] of Object.entries(tcMul ?? {})) {
    const base = Number(mapTcCounts?.[tc] ?? 0);
    const m = Number(mul);
    if (!(base > 0) || !Number.isFinite(m)) continue;
    out[tc] = base * m;
  }

  // 3) tcZero
  for (const tc of tcZero) out[tc] = 0;

  // 4) tcSet (force exact)
  for (const [tc, v] of Object.entries(tcSet ?? {})) {
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) continue;
    out[tc] = x;
  }

  // 5) tcAdd
  for (const [tc, v] of Object.entries(tcAdd ?? {})) {
    const x = Number(v);
    if (!Number.isFinite(x) || x === 0) continue;
    out[tc] = Number(out[tc] ?? 0) + x;
  }

  return out;
}

const VEX_PLUS_RUNES = ["VEX", "OHM", "LO", "SUR", "BER", "JAH", "CHAM", "ZOD"];
const VEX_PLUS_SET = new Set(VEX_PLUS_RUNES);

export function computeMapEvModel({
  runTcCounts,
  tcDropTable,
  phaseData,
  predictableMinProb = 0.01,
}) {
  const tcTable = tcDropTable?.tc ?? tcDropTable ?? {};
  const tcKeyIdx = getCaseIndex(tcTable);

  // IMPORTANT:
  // The predictable/lottery split must be mutually exclusive per ITEM.
  // Otherwise the same item can appear in both buckets when it is common
  // in one TC and rare in another (e.g., FG in a boss TC vs FG from trash).
  //
  // Rule:
  //   maxProb(item) = max over all TCs in this run of P(item | that TC)
  //   Predictable if maxProb(item) >= predictableMinProb, else Lottery.

  const itemIstAll = {}; // IST/run contribution (priced items only)
  const itemExpectedAll = {}; // expected count/run (priced items only)
  const itemMaxProbAll = {}; // max per-mob probability across included TCs

  const vexPlusExpected = {}; // expected count (lambda) per rune per run
  const missingTc = [];

  for (const [tcRaw, Nt] of Object.entries(runTcCounts ?? {})) {
    const n = Number(Nt ?? 0);
    if (!(n > 0)) continue;

    const tcCanon = tcKeyIdx?.get(String(tcRaw).toLowerCase()) ?? tcRaw;
    const drops = tcTable[tcCanon];
    if (!drops) {
      missingTc.push(tcRaw);
      continue;
    }

    for (const [itemRaw, pRaw] of Object.entries(drops)) {
      const prob = Number(pRaw ?? 0);
      if (!(prob > 0)) continue;

      const itemInput = String(itemRaw ?? "").trim();
      if (!itemInput) continue;

      // Price lookup is case-insensitive; canonical casing comes from the price table.
      const { key: itemCanon, value: v } = lookupPrice(itemInput, phaseData);
      if (!(v > 0)) {
        // Not priced => ignore for predictable/lottery value buckets.
        // (Still fine to skip here.)
        continue;
      }

      itemIstAll[itemCanon] = (itemIstAll[itemCanon] ?? 0) + n * prob * v;
      itemExpectedAll[itemCanon] = (itemExpectedAll[itemCanon] ?? 0) + n * prob;
      itemMaxProbAll[itemCanon] = Math.max(itemMaxProbAll[itemCanon] ?? 0, prob);

      // Vex+ odds: include all contributions (doesn't matter for runes since they're always <1%).
      const itemUpper = String(itemCanon || itemInput).toUpperCase();
      if (VEX_PLUS_SET.has(itemUpper)) {
        vexPlusExpected[itemUpper] = (vexPlusExpected[itemUpper] ?? 0) + n * prob;
      }
    }
  }

  // Split by itemMaxProbAll
  let predictableIst = 0;
  const predictableByItemIst = {};
  const predictableExpectedDrops = {};

  let lotteryIst = 0;
  const lotteryByItemIst = {};
  const lotteryExpectedDrops = {};

  for (const [itemCanon, ist] of Object.entries(itemIstAll)) {
    const maxProb = Number(itemMaxProbAll[itemCanon] ?? 0);
    const exp = Number(itemExpectedAll[itemCanon] ?? 0);

    if (maxProb >= predictableMinProb) {
      predictableIst += ist;
      predictableByItemIst[itemCanon] = ist;
      predictableExpectedDrops[itemCanon] = exp;
    } else {
      lotteryIst += ist;
      lotteryByItemIst[itemCanon] = ist;
      lotteryExpectedDrops[itemCanon] = exp;
    }
  }

  const lambdaTotal = Object.values(vexPlusExpected).reduce((a, b) => a + Number(b || 0), 0);
  const vexPlusProb = 1 - Math.exp(-Math.max(0, lambdaTotal));

  // Per-rune probability (at least one) using Poisson approximation
  const vexPlusProbByRune = {};
  for (const [r, lam] of Object.entries(vexPlusExpected)) {
    const l = Math.max(0, Number(lam || 0));
    vexPlusProbByRune[r] = 1 - Math.exp(-l);
  }

  return {
    predictable: {
      istPerRun: predictableIst,
      byItemIst: predictableByItemIst,
      expectedDrops: predictableExpectedDrops,
    },
    lottery: {
      // EV for all priced items with per-mob prob < predictableMinProb
      istPerRun: lotteryIst,
      byItemIst: lotteryByItemIst,
      expectedDrops: lotteryExpectedDrops,

      // Vex+ odds (kept for "lottery realization" reference)
      vexPlusProb,
      vexPlusExpected,
      vexPlusProbByRune,
    },
    missingTc,
  };
}

// Back-compat: old name returns the predictable (>=1%) IST/run only.
export function computeMapEvIst({ runTcCounts, tcDropTable, phaseData }) {
  const m = computeMapEvModel({ runTcCounts, tcDropTable, phaseData });
  return {
    totalIstPerRun: m.predictable.istPerRun,
    byItemIst: m.predictable.byItemIst,
    missingTc: m.missingTc,
  };
}

export function computePerHour(totalIstPerRun, minutesPerRun) {
  const m = Number(minutesPerRun ?? 0);
  if (!(m > 0)) return 0;
  return totalIstPerRun * (60 / m);
}
