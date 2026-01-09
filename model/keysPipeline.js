// model/keysPipeline.js
// Keyset pipeline closed-form model.
//
// Definitions:
// - Dc, Ds, Dn: expected keys per run (NOT runs per key)
// - 1 keyset = 1 Ist (because 3 keys = 1 Ist in your assumption)
// - extras are Countess-only, valued in Ist/run for Countess
//
// Modes:
// A) Given target Y (Ist) -> solve X, runs, hours
// B) Given hours -> solve X, runs, and earned Ist

function toNum(x, fallback = NaN) {
  const n = typeof x === "string" ? parseFloat(x) : x;
  return Number.isFinite(n) ? n : fallback;
}

function assertPos(name, x) {
  if (!Number.isFinite(x) || x <= 0) throw new Error(`${name} must be > 0`);
}

export function computeFromIst(params) {
  const Y = toNum(params.Y);
  const base = normalizeParams(params);
  assertPos("Y", Y);

  const { Dc, Ds, Dn, tC_sec, tS_sec, tN_sec, VextraC } = base;

  // keysets needed
  const X = Y / (1 + VextraC / Dc);

  return finalize({
    mode: "fromIst",
    Y_target: Y,
    hours_input: null,
    X,
    Dc, Ds, Dn,
    tC_sec, tS_sec, tN_sec,
    VextraC
  });
}

export function computeFromHours(params) {
  const hours = toNum(params.hours);
  const base = normalizeParams(params);
  assertPos("hours", hours);

  const { Dc, Ds, Dn, tC_sec, tS_sec, tN_sec, VextraC } = base;

  const secPerKeyset = (tC_sec / Dc) + (tS_sec / Ds) + (tN_sec / Dn);
  const totalSec = hours * 3600;

  // keysets producible within given time
  const X = totalSec / secPerKeyset;

  return finalize({
    mode: "fromHours",
    Y_target: null,
    hours_input: hours,
    X,
    Dc, Ds, Dn,
    tC_sec, tS_sec, tN_sec,
    VextraC
  });
}

// -------- helpers --------

function normalizeParams(params) {
  const Dc = toNum(params.Dc);
  const Ds = toNum(params.Ds);
  const Dn = toNum(params.Dn);

  const tC_min = toNum(params.tC_min);
  const tS_min = toNum(params.tS_min);
  const tN_min = toNum(params.tN_min);

  assertPos("Dc", Dc);
  assertPos("Ds", Ds);
  assertPos("Dn", Dn);
  assertPos("tC_min", tC_min);
  assertPos("tS_min", tS_min);
  assertPos("tN_min", tN_min);

  const extras = Array.isArray(params.extras) ? params.extras : [];
  const VextraC = extras.reduce((sum, e) => {
    const priceIst = toNum(e.priceIst, 0);
    const dropPerRun = toNum(e.dropPerRun, 0);
    if (!Number.isFinite(priceIst) || !Number.isFinite(dropPerRun)) return sum;
    return sum + priceIst * dropPerRun;
  }, 0);

  return {
    Dc, Ds, Dn,
    tC_sec: tC_min * 60,
    tS_sec: tS_min * 60,
    tN_sec: tN_min * 60,
    VextraC
  };
}

function finalize({ mode, Y_target, hours_input, X, Dc, Ds, Dn, tC_sec, tS_sec, tN_sec, VextraC }) {
  // runs required (balanced production)
  const Rc = X / Dc;
  const Rs = X / Ds;
  const Rn = X / Dn;

  // total time implied by X
  const secPerKeyset = (tC_sec / Dc) + (tS_sec / Ds) + (tN_sec / Dn);
  const totalHours = (X * secPerKeyset) / 3600;

  // value per keyset and total value
  const istPerKeyset = 1 + (VextraC / Dc); // because per keyset we do X/Dc Countess runs
  const Y_total = X * istPerKeyset;

  // productivity
  const istPerHour = Y_total / totalHours;

  // extras breakdown
  const extrasIst = Rc * VextraC;

  return {
    mode,
    X,
    Rc, Rs, Rn,
    secPerKeyset,
    totalHours,
    istPerKeyset,
    istPerHour,
    VextraC,        // Ist/run from Countess extras
    extrasIst,      // total extras Ist
    Y_target,       // only in fromIst
    hours_input,    // only in fromHours
    Y_total         // earned (fromHours) or should match input (fromIst)
  };
}
