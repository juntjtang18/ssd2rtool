// /model/rpk.js
// Revenue Per Kill (RPK) for bosses based on pre-distilled expected drop counts.
//
// Conventions:
// - boss drops JSON provides expected item count per kill (not "chance at least one")
// - prices come from /config/rune-price-table.json using O/N -> Ist per item

import { getRuneQuote, normRune } from "./priceTable.js";

export const BOSSES = [
  { id: "countess", label: "Countess" },
  { id: "summoner", label: "Summoner" },
  { id: "nihl", label: "Nihlathak" },
  { id: "council", label: "Council (1)" },
  { id: "council11", label: "Council (11)" },
  { id: "andariel", label: "Andariel" },
  { id: "mephisto", label: "Mephisto" },
  { id: "diablo", label: "Diablo" },
  { id: "baal", label: "Baal" },
];

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function loadBossDropsByFileId(fileId) {
  const url = new URL(`../config/boss_drops/boss.${fileId}.drops.json`, import.meta.url);
  return fetchJson(url.href);
}

// Backwards-compatible: bossId maps directly to fileId.
export async function loadBossDrops(bossId) {
  return loadBossDropsByFileId(bossId);
}

export async function loadAllBossDrops(bosses = BOSSES) {
  const rows = await Promise.all(
    bosses.map(async (b) => ({ ...b, data: await loadBossDrops(b.id) }))
  );
  return rows;
}

export function computeBossRpk({ bossDropsJson, priceTable, phase, assumeAndarielQuestBug = false }) {
  const drops = bossDropsJson?.drops ?? {};
  const rows = [];
  let rpkIst = 0;

  const bossId = String(bossDropsJson?.boss || "").trim().toLowerCase();

  for (const [rawItem, rawCount] of Object.entries(drops)) {
    // Keep original key for matching; canonicalize only for comparisons.
    const rawKey = String(rawItem || "").trim();
    const perKill0 = Number(rawCount);
    if (!(perKill0 > 0)) continue;

    // Optional: Andariel "quest-bug" affects essence frequency in our model.
    // We keep the base dataset as non-quest and only override the essence rate when enabled.
    let perKill = perKill0;
    if (assumeAndarielQuestBug && bossId === "andariel") {
      const k = normRune(rawKey); // uppercase
      if (k === "BLUEESS") perKill = 1 / 9; // quest-bugged Andariel essence
    }
    if (!(perKill > 0)) continue;

    const q = getRuneQuote(priceTable, phase, rawKey);
    const item = q.key ?? rawKey;
    const priceIst = q.priceIst || 0;
    const valueIst = perKill * priceIst;

    rows.push({ item, perKill, priceIst, valueIst });
    rpkIst += valueIst;
  }

  rows.sort((a, b) => (b.valueIst - a.valueIst));
  return { rpkIst, rows };
}

export function formatBossMeta(bossDropsJson) {
  const boss = bossDropsJson?.boss ?? "";
  const difficulty = bossDropsJson?.difficulty ?? "";
  const players = bossDropsJson?.players ?? "";
  const parts = [];
  if (boss) parts.push(String(boss));
  if (difficulty) parts.push(`diff=${difficulty}`);
  if (players) parts.push(`/p${players}`);
  return parts.join(" · ");
}
