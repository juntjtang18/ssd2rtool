// /model/modelCore.js
// Theory EV model for D2R key farming rotation (Countess / Summoner / Nihl).
// File-structure assumptions (site root):
//   /config/model-parameters.json
//   /config/rune-price-table.json
//
// Key ideas:
// - NO ceil/floor/bankable constraints (pure EV)
// - Rotation closes via balanced production: keysets throughput determined by minutes/keyset
// - Extras + bonus are injected ONLY through Countess runs/time
// - Bonus items are identified by name prefix "BONUS " in model-parameters extras list
//
// Price-table convention: { "O": items, "N": ist } => 1 item = N/O Ist

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function loadModelConfigs() {
  // IMPORTANT for GitHub Pages under a repo subpath:
  // Use URLs relative to this module file (/model/modelCore.js),
  // so it works at:
  //   https://<user>.github.io/<repo>/...
  // not only at domain root.
  const mpUrl = new URL("../config/model-parameters.json", import.meta.url);
  const ptUrl = new URL("../config/rune-price-table.json", import.meta.url);

  const [modelParameters, priceTable] = await Promise.all([
    fetchJson(mpUrl.href),
    fetchJson(ptUrl.href),
  ]);
  return { modelParameters, priceTable };
}

export function getPhaseOptions(priceTable) {
  const phases = priceTable?.phases ?? {};
  const keys = Object.keys(phases);
  const defaultPhase = String(priceTable?.defaultPhase ?? (keys.length ? keys[0] : "1"));
  return { phases, defaultPhase };
}

export function priceInIst(name, phaseData) {
  const entry = phaseData?.[name];
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


export function computeTheoryFromHours(params) {
  const H = Number(params?.hours);
  if (!(H > 0)) throw new Error("hours must be > 0");

  const Dc = Number(params?.Dc), Ds = Number(params?.Ds), Dn = Number(params?.Dn);
  const tC = Number(params?.tC_min), tS = Number(params?.tS_min), tN = Number(params?.tN_min);
  const phaseData = params?.phaseData ?? {};
  const extras = params?.extras ?? [];

  // --- Run scheduling (as requested) ---
  // We run: Countess -> Summoner -> Nihl, repeating.
  // The last run is fractional based on remaining time, so at most ONE of Rc/Rs/Rn is fractional.
  const totalMin = H * 60;
  const cycleMin = tC + tS + tN;
  if (!(cycleMin > 0)) throw new Error("Invalid inputs: tC+tS+tN must be > 0");

  const fullCycles = Math.floor(totalMin / cycleMin);
  let remaining = totalMin - fullCycles * cycleMin;

  let Rc = fullCycles, Rs = fullCycles, Rn = fullCycles;

  // Add partial cycle in order C -> S -> N (only one can be fractional)
  if (remaining > 1e-12) {
    const fracC = Math.min(1, remaining / tC);
    Rc += fracC;
    remaining -= fracC * tC;

    if (remaining > 1e-12) {
      const fracS = Math.min(1, remaining / tS);
      Rs += fracS;
      remaining -= fracS * tS;

      if (remaining > 1e-12) {
        const fracN = Math.min(1, remaining / tN);
        Rn += fracN;
        remaining -= fracN * tN;
      }
    }
  }

  // Expected keys (decimal EV) from scheduled runs
  const kT = Rc * Dc;
  const kH = Rs * Ds;
  const kD = Rn * Dn;

  // Keysets sellable as balanced sets (theoretical EV): limited by the minimum of the 3 streams
  const keysets = Math.min(kT, kH, kD);

  const { regular, bonus } = splitExtras(extras);
  const vRegularPerCRun = regular.reduce((acc, x) => acc + x.dropPerRun * priceInIst(x.name, phaseData), 0);
  const vBonusPerCRun = bonus.reduce((acc, x) => acc + x.dropPerRun * priceInIst(x.name, phaseData), 0);

  const keysIst = keysets; // 1 keyset = 1 Ist
  const extrasRegularIst = Rc * vRegularPerCRun;
  const bonusIst = Rc * vBonusPerCRun;

  const totalIstExclBonus = keysIst + extrasRegularIst;
  const totalIstInclBonus = totalIstExclBonus + bonusIst;

  return {
    keysets,
    keys: { terror: kT, hate: kH, destruction: kD },
    runs: { Rc, Rs, Rn },
    minutes: {
      totalMin,
      cycleMin,
      fullCycles,
      // time actually spent on Countess drives extras/bonus
      countessMin: Rc * tC,
      // leftover after partial cycle (should be ~0)
      unusedMin: Math.max(0, remaining),
    },
    values: {
      keysIst,
      extrasRegularIst,
      totalIstExclBonus,
      bonusIst,
      totalIstInclBonus,
    },
    rates: {
      istPerHourExclBonus: totalIstExclBonus / H,
      bonusPerHour: bonusIst / H,
      istPerHourInclBonus: totalIstInclBonus / H,
      keysetsPerHour: keysets / H,
    }
  };
}


export function computeTheoryFromTargetIst(params) {
  const Y = Number(params?.targetIst);
  if (!(Y > 0)) throw new Error("targetIst must be > 0");

  const Dc = Number(params?.Dc), Ds = Number(params?.Ds), Dn = Number(params?.Dn);
  const tC = Number(params?.tC_min), tS = Number(params?.tS_min), tN = Number(params?.tN_min);
  const phaseData = params?.phaseData ?? {};
  const extras = params?.extras ?? [];

  const minPerKeyset = (tC / Dc) + (tS / Ds) + (tN / Dn);
  if (!(minPerKeyset > 0)) throw new Error("Invalid inputs: minPerKeyset <= 0 (check D and t).");

  const { regular, bonus } = splitExtras(extras);
  const vRegularPerCRun = regular.reduce((acc, x) => acc + x.dropPerRun * priceInIst(x.name, phaseData), 0);
  const vBonusPerCRun = bonus.reduce((acc, x) => acc + x.dropPerRun * priceInIst(x.name, phaseData), 0);

  // Per keyset: 1 Ist from keys + (Countess runs per keyset)*(regular extra value per C run)
  const istPerKeysetExclBonus = 1 + (vRegularPerCRun / Dc);
  const bonusPerKeyset = (vBonusPerCRun / Dc);

  const keysets = Y / istPerKeysetExclBonus;
  const totalMin = keysets * minPerKeyset;
  const hours = totalMin / 60;

  const Rc = keysets / Dc;
  const Rs = keysets / Ds;
  const Rn = keysets / Dn;

  const keysIst = keysets;
  const extrasRegularIst = Rc * vRegularPerCRun;
  const bonusIst = Rc * vBonusPerCRun;

  const totalIstExclBonus = keysIst + extrasRegularIst;
  const totalIstInclBonus = totalIstExclBonus + bonusIst;

  return {
    required: { hours, keysets, runs: { Rc, Rs, Rn } },
    minutes: {
      totalMin,
      minPerKeyset,
      countessMin: Rc * tC,
    },
    values: {
      keysIst,
      extrasRegularIst,
      totalIstExclBonus,
      bonusIst,
      totalIstInclBonus,
    },
    rates: {
      istPerHourExclBonus: totalIstExclBonus / hours,
      bonusPerHour: bonusIst / hours,
      istPerHourInclBonus: totalIstInclBonus / hours,
      keysetsPerHour: keysets / hours,
    },
    perKeyset: {
      min: minPerKeyset,
      istExclBonus: istPerKeysetExclBonus,
      bonusIst: bonusPerKeyset,
      countessRuns: 1 / Dc,
    }
  };
}
