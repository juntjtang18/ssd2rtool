// /model/keysPipelineDeterministic.js
// Deterministic rotation planner with INTEGER RUNS.
// - Rotate C -> S -> N
// - Each full key costs runsNeeded = ceil(1/p) (integer runs)
// - Time cost = runsNeeded * t (min/run)
// - Tail: spend remaining time on next boss only, using tailRuns = floor(remain/t) (integer runs)
//         fractional key progress = tailRuns * p  (only one boss can have a fraction)

function computeVextraC(extras) {
  return (extras || []).reduce((sum, e) => {
    const priceIst = Number(e.priceIst) || 0;
    const dropPerRun = Number(e.dropPerRun) || 0;
    return sum + priceIst * dropPerRun;
  }, 0);
}

export function planFromHoursDeterministic({
  hours,
  Dc, Ds, Dn,
  tC_min, tS_min, tN_min,
  extras,
  keyIst = 1 / 3,
  startBoss = "C"
}) {
  const totalMin = hours * 60;
  let remainMin = totalMin;

  const VextraC = computeVextraC(extras);

  // keys: two integer, one may include fractional tail
  const keys = { T: 0, H: 0, D: 0 };

  // runs are INTEGERS now
  let runsC = 0, runsS = 0, runsN = 0;

  // extras EV (Countess-only)
  let extrasIst = 0;

  const order = ["C", "S", "N"];
  let idx = Math.max(0, order.indexOf(startBoss));

  function bossParams(boss) {
    if (boss === "C") return { p: Dc, t: tC_min };
    if (boss === "S") return { p: Ds, t: tS_min };
    return { p: Dn, t: tN_min };
  }

  function runsForOneKey(boss) {
    const { p } = bossParams(boss);
    if (!(p > 0)) return Infinity;
    return Math.ceil(1 / p); // integer runs
  }

  function timeForOneKey(boss) {
    const { t } = bossParams(boss);
    const r = runsForOneKey(boss);
    if (!(t > 0) || !Number.isFinite(r)) return Infinity;
    return r * t; // minutes
  }

  // 1) Full keys via integer runs
  while (true) {
    const boss = order[idx];
    const needMin = timeForOneKey(boss);

    if (remainMin < needMin) break;

    remainMin -= needMin;

    const { p, t } = bossParams(boss);
    const r = Math.ceil(1 / p);

    if (boss === "C") {
      keys.T += 1;
      runsC += r;
      extrasIst += r * VextraC;
    } else if (boss === "S") {
      keys.H += 1;
      runsS += r;
    } else {
      keys.D += 1;
      runsN += r;
    }

    idx = (idx + 1) % order.length;
  }

  // 2) Tail: remaining time on next boss only, integer runs
  let tail = { boss: order[idx], runs: 0, fracKey: 0 };

  if (remainMin > 0) {
    const boss = order[idx];
    const { p, t } = bossParams(boss);

    if (p > 0 && t > 0) {
      const tailRuns = Math.floor(remainMin / t); // integer runs
      const fracKey = Math.min(0.999999, tailRuns * p); // keep < 1 by design

      tail = { boss, runs: tailRuns, fracKey };

      if (boss === "C") {
        keys.T += fracKey;
        runsC += tailRuns;
        extrasIst += tailRuns * VextraC;
      } else if (boss === "S") {
        keys.H += fracKey;
        runsS += tailRuns;
      } else {
        keys.D += fracKey;
        runsN += tailRuns;
      }

      remainMin -= tailRuns * t;
    }
  }

  const totalKeys = keys.T + keys.H + keys.D;
  const bankedKeyIst = totalKeys * keyIst;
  const totalIst = bankedKeyIst + extrasIst;

  const usedMin = totalMin - remainMin;
  const istPerHour = usedMin > 0 ? totalIst / (usedMin / 60) : 0;

  return {
    usedMin,
    remainMin,
    keys,
    runs: { runsC, runsS, runsN }, // integers
    tail,                          // tailRuns integer; fracKey may be fractional
    VextraC,
    bankedKeyIst,
    extrasIst,
    totalIst,
    istPerHour
  };
}
