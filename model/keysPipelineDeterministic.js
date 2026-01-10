// /model/keysPipelineDeterministic.js
// Deterministic planner:
// - Rotate C -> S -> N
// - Each step "buys" 1 key using expected runs = 1/p and expected time = (1/p)*t
// - Keys are counted as INTEGERS
// - Value counts every key as 1/3 Ist (banked), plus Countess extras EV during Countess time.

// /model/keysPipelineDeterministic.js

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

  // integer keys + at most ONE fractional tail key
  const keys = { T: 0, H: 0, D: 0 };

  // expected run counts (can be fractional)
  let runsC = 0, runsS = 0, runsN = 0;

  // expected extras (Countess-only)
  let extrasIst = 0;

  const order = ["C", "S", "N"];
  let idx = Math.max(0, order.indexOf(startBoss));

  function bossParams(boss) {
    if (boss === "C") return { p: Dc, t: tC_min };
    if (boss === "S") return { p: Ds, t: tS_min };
    return { p: Dn, t: tN_min };
  }

  function timeForOneKey(boss) {
    const { p, t } = bossParams(boss);
    if (!(p > 0) || !(t > 0)) return Infinity;
    return (1 / p) * t; // minutes
  }

  // 1) Buy as many full integer keys as possible, rotating strictly
  while (true) {
    const boss = order[idx];
    const needMin = timeForOneKey(boss);
    if (remainMin < needMin) break;

    remainMin -= needMin;

    const { p } = bossParams(boss);
    const expRuns = 1 / p;

    if (boss === "C") {
      keys.T += 1;
      runsC += expRuns;
      extrasIst += expRuns * VextraC;
    } else if (boss === "S") {
      keys.H += 1;
      runsS += expRuns;
    } else {
      keys.D += 1;
      runsN += expRuns;
    }

    idx = (idx + 1) % order.length;
  }

  // 2) Tail: spend remaining time ONLY on the next boss in rotation
  // and give that boss a fractional expected key progress (< 1 key).
  let tail = { boss: order[idx], runs: 0, fracKey: 0 };

  if (remainMin > 0) {
    const boss = order[idx];
    const { p, t } = bossParams(boss);

    if (p > 0 && t > 0) {
      const tailRuns = remainMin / t;
      const fracKey = Math.min(0.999999, tailRuns * p); // keep it < 1 by design

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

      // all time used
      remainMin = 0;
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
    keys,                       // two are integers, one may have fraction
    runs: { runsC, runsS, runsN },
    tail,                       // tells you which boss got the fractional key
    VextraC,
    bankedKeyIst,
    extrasIst,
    totalIst,
    istPerHour
  };
}

