// modelCore.js
// Theoretical EV model for D2R key farming rotation (Countess/Summoner/Nihl).
// - Uses decimal expected runs/time (no ceil/floor)
// - Treats keys as sold as keysets (1 keyset = 1 Ist).
// - Extras + bonus are injected ONLY via Countess time/runs.
// - Bonus items are tracked separately (names starting with "BONUS").

async function fetchFirstJson(paths) {
  const errors = [];
  for (const p of paths) {
    try {
      const res = await fetch(p, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return { json: await res.json(), path: p };
    } catch (e) {
      errors.push(`${p}: ${e?.message ?? e}`);
    }
  }
  const err = new Error("Failed to load config JSON from all candidate paths.");
  err.details = errors;
  throw err;
}

export async function loadModelConfigs() {
  const mp = await fetchFirstJson([
    "./config/model-parameters.json",
    "../config/model-parameters.json",
    "./github/config/model-parameters.json",
    "../github/config/model-parameters.json",
    "./model-parameters.json",
    "../model-parameters.json",
  ]);

  const pt = await fetchFirstJson([
    "./config/rune-price-table.json",
    "../config/rune-price-table.json",
    "./github/config/rune-price-table.json",
    "../github/config/rune-price-table.json",
    "./rune-price-table.json",
    "../rune-price-table.json",
  ]);

  return {
    modelParameters: mp.json,
    modelParametersPath: mp.path,
    priceTable: pt.json,
    priceTablePath: pt.path,
  };
}

export function getPhaseOptions(priceTable) {
  const phases = priceTable?.phases ?? {};
  const defaultPhase = String(priceTable?.defaultPhase ?? Object.keys(phases)[0] ?? "1");
  return { phases, defaultPhase };
}

// Returns price in Ist for 1 unit of `name` under given phase.
// Price-table convention: { O: <items>, N: <ist> } => O items = N Ist => 1 item = N/O Ist
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
    const n = String(x?.name ?? "").trim();
    const d = Number(x?.dropPerRun ?? 0);
    if (!n || !(d > 0)) continue;
    if (/^BONUS\b/i.test(n)) bonus.push({ name: n.replace(/^BONUS\s*/i, "").trim(), dropPerRun: d });
    else regular.push({ name: n, dropPerRun: d });
  }
  return { regular, bonus };
}

export function computeTheoryFromHours({
  hours,
  Dc, Ds, Dn,
  tC_min, tS_min, tN_min,
  extras,
  phaseData,
}) {
  const H = Number(hours);
  if (!(H > 0)) throw new Error("hours must be > 0");

  // rates are encoded via expected time per keyset (minutes)
  const timePerKeysetMin =
    (Number(tC_min) / Number(Dc)) +
    (Number(tS_min) / Number(Ds)) +
    (Number(tN_min) / Number(Dn));

  if (!(timePerKeysetMin > 0)) throw new Error("Invalid timePerKeysetMin (check D and t).");

  const totalMin = H * 60;
  const keysets = totalMin / timePerKeysetMin;

  const Rc = keysets / Number(Dc);
  const Rs = keysets / Number(Ds);
  const Rn = keysets / Number(Dn);

  // Countess time / runs
  const countessMin = keysets * (Number(tC_min) / Number(Dc));

  const { regular, bonus } = splitExtras(extras);
  const vRegularPerCRun = regular.reduce((acc, x) => acc + x.dropPerRun * priceInIst(x.name, phaseData), 0);
  const vBonusPerCRun = bonus.reduce((acc, x) => acc + x.dropPerRun * priceInIst(x.name, phaseData), 0);

  const extrasRegularIst = Rc * vRegularPerCRun;
  const bonusIst = Rc * vBonusPerCRun;

  const keysIst = keysets; // 1 keyset = 1 Ist (theoretical liquidity assumption)
  const totalIstExclBonus = keysIst + extrasRegularIst;
  const totalIstInclBonus = totalIstExclBonus + bonusIst;

  return {
    mode: "fromHours",
    inputs: { hours: H },
    keysets,
    runs: { Rc, Rs, Rn },
    minutes: { totalMin, timePerKeysetMin, countessMin },
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
    },
    perKeyset: {
      istExclBonus: totalIstExclBonus / keysets,
      bonusIst: bonusIst / keysets,
      timeMin: timePerKeysetMin,
      countessRuns: Rc / keysets,
    }
  };
}

export function computeTheoryFromTargetIst({
  targetIst,
  Dc, Ds, Dn,
  tC_min, tS_min, tN_min,
  extras,
  phaseData,
}) {
  const Y = Number(targetIst);
  if (!(Y > 0)) throw new Error("targetIst must be > 0");

  const timePerKeysetMin =
    (Number(tC_min) / Number(Dc)) +
    (Number(tS_min) / Number(Ds)) +
    (Number(tN_min) / Number(Dn));
  if (!(timePerKeysetMin > 0)) throw new Error("Invalid timePerKeysetMin (check D and t).");

  const { regular, bonus } = splitExtras(extras);
  const vRegularPerCRun = regular.reduce((acc, x) => acc + x.dropPerRun * priceInIst(x.name, phaseData), 0);
  const vBonusPerCRun = bonus.reduce((acc, x) => acc + x.dropPerRun * priceInIst(x.name, phaseData), 0);

  // Per keyset, Countess runs = 1/Dc
  const istPerKeysetExclBonus = 1 + (vRegularPerCRun / Number(Dc));
  const bonusPerKeyset = (vBonusPerCRun / Number(Dc));

  const keysets = Y / istPerKeysetExclBonus;
  const totalMin = keysets * timePerKeysetMin;
  const hours = totalMin / 60;

  const Rc = keysets / Number(Dc);
  const Rs = keysets / Number(Ds);
  const Rn = keysets / Number(Dn);

  const extrasRegularIst = Rc * vRegularPerCRun;
  const bonusIst = Rc * vBonusPerCRun;
  const keysIst = keysets;

  const totalIstExclBonus = keysIst + extrasRegularIst; // should equal Y (up to float error)
  const totalIstInclBonus = totalIstExclBonus + bonusIst;

  return {
    mode: "fromTargetIst",
    inputs: { targetIst: Y },
    required: {
      hours,
      keysets,
      runs: { Rc, Rs, Rn },
    },
    minutes: {
      totalMin,
      timePerKeysetMin,
      countessMin: keysets * (Number(tC_min) / Number(Dc)),
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
      istExclBonus: istPerKeysetExclBonus,
      bonusIst: bonusPerKeyset,
      timeMin: timePerKeysetMin,
      countessRuns: 1 / Number(Dc),
    }
  };
}
