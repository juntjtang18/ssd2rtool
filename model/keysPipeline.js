// model/keysPipeline.js
// Keyset pipeline closed-form model.
//
// Units:
// - Y: target value in Ist
// - Dc, Ds, Dn: expected keys per run for Countess/Summoner/Nihl
// - tC_min, tS_min, tN_min: minutes per run
// - extras: Countess-only extras: [{ name, priceIst, dropPerRun }]

function toNum(x, fallback = NaN) {
  const n = typeof x === "string" ? parseFloat(x) : x;
  return Number.isFinite(n) ? n : fallback;
}

function assertPos(name, x) {
  if (!Number.isFinite(x) || x <= 0) throw new Error(`${name} must be > 0`);
}

export function compute(params) {
  const Y = toNum(params.Y);
  const Dc = toNum(params.Dc);
  const Ds = toNum(params.Ds);
  const Dn = toNum(params.Dn);

  const tC_min = toNum(params.tC_min);
  const tS_min = toNum(params.tS_min);
  const tN_min = toNum(params.tN_min);

  assertPos("Y", Y);
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

  // Core closed-form
  const X = Y / (1 + VextraC / Dc); // keysets needed

  // Runs needed
  const Rc = X / Dc;
  const Rs = X / Ds;
  const Rn = X / Dn;

  // Time
  const tC_sec = tC_min * 60;
  const tS_sec = tS_min * 60;
  const tN_sec = tN_min * 60;

  const secPerKeyset = (tC_sec / Dc) + (tS_sec / Ds) + (tN_sec / Dn);
  const totalHours = (X * secPerKeyset) / 3600;

  // Rates
  const istPerKeyset = 1 + VextraC / Dc;
  const istPerHour = (3600 * istPerKeyset) / secPerKeyset;

  return {
    Y,
    X,
    Rc,
    Rs,
    Rn,
    VextraC,
    istPerKeyset,
    secPerKeyset,
    totalHours,
    istPerHour,
  };
}

