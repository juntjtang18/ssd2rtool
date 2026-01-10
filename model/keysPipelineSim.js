// model/keysPipelineSim.js
// Discrete time simulator for key farming.
// Routing: Policy A (balance-first). Tie-break: choose highest EV/min (Countess usually).
// Valuation: EVERY key is worth 1/3 Ist (banked value toward future keysets).
// Extras: Countess-only EV per run from config extras[].

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function computeVextraC(extras) {
  return (extras || []).reduce((sum, e) => {
    const priceIst = Number(e.priceIst) || 0;
    const dropPerRun = Number(e.dropPerRun) || 0;
    return sum + priceIst * dropPerRun;
  }, 0);
}

function bestBossByEVPerMinute({ Dc, Ds, Dn, tC_min, tS_min, tN_min, VextraC, keyIst }) {
  // Expected Ist per minute for each node
  const evC = (Dc * keyIst + VextraC) / tC_min; // keys + extras
  const evS = (Ds * keyIst) / tS_min;
  const evN = (Dn * keyIst) / tN_min;

  if (evC >= evS && evC >= evN) return "C";
  if (evS >= evN) return "S";
  return "N";
}

function pickNextBossBalanceFirst(st, params) {
  // Policy A: run the boss for the key type you have the least of.
  const m = Math.min(st.T, st.H, st.D);
  const candidates = [];
  if (st.T === m) candidates.push("C");
  if (st.H === m) candidates.push("S");
  if (st.D === m) candidates.push("N");

  // If only one most-needed key, do it.
  if (candidates.length === 1) return candidates[0];

  // Tie-break: choose the most profitable (EV/min).
  const best = bestBossByEVPerMinute(params);
  if (candidates.includes(best)) return best;

  // If best isn't in candidates (rare), just pick first.
  return candidates[0];
}

export function simulateBankedKeyValue({
  hours,
  Dc, Ds, Dn,
  tC_min, tS_min, tN_min,
  extras,
  keyIst = 1 / 3,      // each key banked as 1/3 Ist
  trials = 20000,
  seed = 12345
}) {
  const rand = lcg(seed);
  const VextraC = computeVextraC(extras);

  const totalMinutes = hours * 60;

  let sumT = 0, sumH = 0, sumD = 0;
  let sumRunsC = 0, sumRunsS = 0, sumRunsN = 0;
  let sumExtrasIst = 0;
  let sumKeyIst = 0;

  for (let k = 0; k < trials; k++) {
    let t = 0;
    const st = { T: 0, H: 0, D: 0 };
    let runsC = 0, runsS = 0, runsN = 0;
    let extrasIst = 0;

    while (true) {
      const boss = pickNextBossBalanceFirst(st, {
        Dc, Ds, Dn, tC_min, tS_min, tN_min, VextraC, keyIst
      });

      let p = 0, dt = 0;
      if (boss === "C") { p = Dc; dt = tC_min; }
      if (boss === "S") { p = Ds; dt = tS_min; }
      if (boss === "N") { p = Dn; dt = tN_min; }

      if (t + dt > totalMinutes) break;
      t += dt;

      if (boss === "C") { runsC++; extrasIst += VextraC; }
      if (boss === "S") runsS++;
      if (boss === "N") runsN++;

      // key drop Bernoulli
      if (rand() < p) {
        if (boss === "C") st.T += 1;
        if (boss === "S") st.H += 1;
        if (boss === "N") st.D += 1;
      }
    }

    const keys = st.T + st.H + st.D;
    const keyIstVal = keys * keyIst;

    sumT += st.T; sumH += st.H; sumD += st.D;
    sumRunsC += runsC; sumRunsS += runsS; sumRunsN += runsN;
    sumExtrasIst += extrasIst;
    sumKeyIst += keyIstVal;
  }

  const avgT = sumT / trials;
  const avgH = sumH / trials;
  const avgD = sumD / trials;

  const avgRunsC = sumRunsC / trials;
  const avgRunsS = sumRunsS / trials;
  const avgRunsN = sumRunsN / trials;

  const avgExtrasIst = sumExtrasIst / trials;
  const avgKeyIst = sumKeyIst / trials;

  const avgTotalIst = avgKeyIst + avgExtrasIst;

  return {
    trials,
    VextraC,
    avg: {
      runsC: avgRunsC,
      runsS: avgRunsS,
      runsN: avgRunsN,
      T: avgT,
      H: avgH,
      D: avgD,
      keys: avgT + avgH + avgD,
      keysets: Math.min(avgT, avgH, avgD), // informational only
      keyIst: avgKeyIst,                   // banked key value
      extrasIst: avgExtrasIst,
      totalIst: avgTotalIst,
      istPerHour: avgTotalIst / hours
    }
  };
}
