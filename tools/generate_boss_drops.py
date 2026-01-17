#!/usr/bin/env python3

"""Generate boss.<name>.drops.json (expected counts per kill) for RPK.

- Uses Diablo II 1.13d TXT tables shipped with pairofdocs/d2-drop-simulator.
- Deterministically traverses treasure classes to compute **expected item count per kill**.
- Outputs JSON containing only economy items from config/rune-price-table.json:
  RAL, TAL, HEL, IST, UM, MAL, VEX, CHAM, OHM, LO, SUR, BER, JAH, plus gem currency buckets:
  PG (perfect gems excl. amethyst), PA, FG (flawless gems excl. amethyst), FA.

Notes
-----
This matches the simulator's treasure-class traversal model (a single roll per TC until a leaf),
with NoDrop adjusted by /players the same way.

Run:
  python tools/generate_boss_drops.py --difficulty H --players 1

Outputs files under config/boss_drops/ by default.
"""

import argparse
import csv
import json
import os
from collections import defaultdict
from typing import Dict


def load_tsv_dict(path: str, key_field: str) -> Dict[str, Dict[str, str]]:
    out: Dict[str, Dict[str, str]] = {}
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t", quotechar='"', skipinitialspace=True)
        for row in reader:
            out[row[key_field]] = row
    return out


def load_misc_code_to_name(path: str) -> Dict[str, str]:
    misc = load_tsv_dict(path, "name")
    code_to_name: Dict[str, str] = {}
    for row in misc.values():
        code = row.get("code")
        if code:
            code_to_name[code] = row.get("name", "").title()
    return code_to_name


def nodrop_adjusted_weight(nodrop_orig: int, sumprobs: int, players: int) -> int:
    # mirrors data_util.one_roll_from_tc
    players = max(1, min(8, int(players)))
    nd_exp = int(float(players) / 2.0 + 0.5)
    ratio = (nodrop_orig / (nodrop_orig + sumprobs)) ** nd_exp
    nodrop_final = ((ratio) / (1 - ratio)) * sumprobs
    return int(round(nodrop_final))


def outcome_probs(tc: str, tcdict: Dict[str, Dict[str, str]], players: int) -> Dict[str, float]:
    row = tcdict[tc]
    items = []
    probs = []
    for k, v in row.items():
        if k.startswith("Item") and v:
            items.append(v)
            probs.append(int(row[f"Prob{len(items)}"]))
    if row.get("NoDrop"):
        nodrop_orig = int(row["NoDrop"])
        sumprobs = sum(probs)
        nd = nodrop_adjusted_weight(nodrop_orig, sumprobs, players)
        items.append("")
        probs.append(nd)
    total = float(sum(probs))
    return {items[i]: probs[i] / total for i in range(len(items))}


def leaf_dist(tc_or_item: str, tcdict: Dict[str, Dict[str, str]], players: int, memo: Dict[str, Dict[str, float]]) -> Dict[str, float]:
    """Distribution over leaf item codes reached by repeatedly rolling a TC until a leaf."""
    if tc_or_item == "":
        return {}
    if tc_or_item not in tcdict:
        return {tc_or_item: 1.0}
    key = f"{tc_or_item}::p{players}"
    if key in memo:
        return memo[key]

    dist: Dict[str, float] = defaultdict(float)
    for outcome, p in outcome_probs(tc_or_item, tcdict, players).items():
        if outcome == "":
            continue
        if outcome in tcdict:
            sub = leaf_dist(outcome, tcdict, players, memo)
            for k, v in sub.items():
                dist[k] += p * v
        else:
            dist[outcome] += p
    memo[key] = dict(dist)
    return memo[key]


def expected_counts_for_one_pick(root_tc: str, tcdict: Dict[str, Dict[str, str]], players: int, memo: Dict[str, Dict[str, float]]) -> Dict[str, float]:
    """Expected leaf item counts produced by ONE outer pick (one call to nested_rolls_in_tc on root)."""
    out: Dict[str, float] = defaultdict(float)
    for tc1, p1 in outcome_probs(root_tc, tcdict, players).items():
        if tc1 == "":
            continue
        if tc1 in tcdict:
            inner_picks = int(tcdict[tc1].get("Picks") or 1)
            ld = leaf_dist(tc1, tcdict, players, memo)
            for leaf, p_leaf in ld.items():
                out[leaf] += p1 * inner_picks * p_leaf
        else:
            out[tc1] += p1
    return dict(out)


def expected_counts_per_kill(root_tc: str, tcdict: Dict[str, Dict[str, str]], players: int) -> Dict[str, float]:
    memo: Dict[str, Dict[str, float]] = {}
    picks = int(tcdict[root_tc].get("Picks") or 1)

    # IMPORTANT: Act-boss treasure classes (Andariel/Mephisto/Diablo/Baal) in
    # TreasureClassEx.txt often have Picks=7 with an explicit gold outcome like
    # "gld,mul=...".
    #
    # Most popular drop calculators report *item* drop rates for these bosses
    # using 6 item drops (gold handled separately). If we keep Picks=7 here,
    # every non-gold item rate becomes ~7/6 higher than those calculators.
    #
    # To align our per-kill expected counts with dropcalc-style outputs, we
    # subtract 1 pick when the root TC includes an explicit gold outcome.
    if picks > 0:
        item1 = str(tcdict[root_tc].get("Item1") or "")
        if item1.startswith("gld"):
            picks = max(0, picks - 1)

    # Negative picks (Countess) are handled as a deterministic sequence of inner TCs.
    if picks < 0:
        innertcs = []
        rollnum = []
        for k, v in tcdict[root_tc].items():
            if k.startswith("Item") and v:
                innertcs.append(v)
                rollnum.append(int(tcdict[root_tc][f"Prob{len(innertcs)}"]))
        rollseq = []
        for tc, n in zip(innertcs, rollnum):
            rollseq.extend([tc] * n)
        rollseq = rollseq[: abs(picks)]

        out: Dict[str, float] = defaultdict(float)
        for tc_roll in rollseq:
            inner_picks = int(tcdict[tc_roll].get("Picks") or 1) if tc_roll in tcdict else 1
            ld = leaf_dist(tc_roll, tcdict, players, memo)
            for leaf, p_leaf in ld.items():
                out[leaf] += inner_picks * p_leaf
        return dict(out)

    # Positive picks: do `picks` independent outer picks.
    one = expected_counts_for_one_pick(root_tc, tcdict, players, memo)
    return {k: v * picks for k, v in one.items()}


def economy_bucketize(leaf_counts: Dict[str, float], code_to_name: Dict[str, str]) -> Dict[str, float]:
    out: Dict[str, float] = defaultdict(float)

    for code, cnt in leaf_counts.items():
        name = code_to_name.get(code, "").strip()
        if not name:
            continue

        # Runes
        if name.endswith(" Rune"):
            rune = name.replace(" Rune", "").upper()
            out[rune] += cnt
            continue

        # Uber keys (Key of Terror/Hate/Destruction)
        # misc.txt names are title-cased by load_misc_code_to_name().
        if name in ("Key Of Terror", "Key Of Hate", "Key Of Destruction"):
            out["UKEY"] += cnt
            continue

        # Gem currencies
        # Perfect gems
        if name.startswith("Perfect "):
            if "Amethyst" in name:
                out["PA"] += cnt
            else:
                out["PG"] += cnt
            continue

        # Flawless gems
        if name.startswith("Flawless "):
            if "Amethyst" in name:
                out["FA"] += cnt
            else:
                out["FG"] += cnt
            continue

    return dict(out)


def load_price_table(path: str, phase: str | None = None) -> Dict[str, float]:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    if isinstance(raw, dict) and "phases" in raw:
        phases = raw["phases"]
        if phase is None:
            phase = str(raw.get("defaultPhase", "1"))
        raw = phases[phase]

    out: Dict[str, float] = {}
    for k, v in raw.items():
        out[k] = float(v["N"]) / float(v["O"])  # O items == N Ist
    return out


def rpk_from_drops(d: Dict[str, float], price: Dict[str, float]) -> float:
    return sum(d.get(k, 0.0) * price.get(k, 0.0) for k in d.keys())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--data",
        default=os.path.join(os.path.dirname(__file__), "..", "vendor", "d2-drop-simulator", "data-113d"),
        help="Path to d2-drop-simulator data-113d folder",
    )
    ap.add_argument("--players", type=int, default=1)
    ap.add_argument("--difficulty", default="H", choices=["N", "NM", "H"], help="N=Normal, NM=Nightmare, H=Hell")
    ap.add_argument(
        "--out-dir",
        default=os.path.join(os.path.dirname(__file__), "..", "config", "boss_drops"),
        help="Output directory for boss.<name>.drops.json",
    )
    ap.add_argument(
        "--price-phase",
        default=None,
        help="Price phase key in config/rune-price-table.json. If omitted, uses defaultPhase.",
    )
    args = ap.parse_args()

    diff_suffix = "" if args.difficulty == "N" else " (N)" if args.difficulty == "NM" else " (H)"

    tcdict = load_tsv_dict(os.path.join(args.data, "TreasureClassEx.txt"), "Treasure Class")
    code_to_name = load_misc_code_to_name(os.path.join(args.data, "misc.txt"))

    price_path = os.path.join(os.path.dirname(__file__), "..", "config", "rune-price-table.json")
    price = load_price_table(price_path, phase=args.price_phase)

    bosses = {
        "diablo": f"Diablo{diff_suffix}",
        "baal": f"Baal{diff_suffix}",
        "mephisto": f"Mephisto{diff_suffix}",
        "andariel": f"Andariel{diff_suffix}",
        "nihl": f"Nihlathak{diff_suffix}",
        "countess": f"Countess{diff_suffix}",
        "summoner": f"Summoner{diff_suffix}",
        "council": f"Council{diff_suffix}",
    }

    os.makedirs(args.out_dir, exist_ok=True)

    summary = []
    for out_name, tc in bosses.items():
        leaf_counts = expected_counts_per_kill(tc, tcdict, args.players)
        econ = economy_bucketize(leaf_counts, code_to_name)

        # keep only price-table keys (plus rune names already match)
        econ = {k: float(v) for k, v in econ.items() if k in price}

        out_path = os.path.join(args.out_dir, f"boss.{out_name}.drops.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"boss": out_name, "difficulty": args.difficulty, "players": args.players, "drops": econ}, f, indent=2, sort_keys=True)

        summary.append((out_name, rpk_from_drops(econ, price)))

    # Travincal (5 council members)
    council_tc = bosses["council"]
    council_leaf = expected_counts_per_kill(council_tc, tcdict, args.players)
    council_econ = economy_bucketize({k: v * 5 for k, v in council_leaf.items()}, code_to_name)
    council_econ = {k: float(v) for k, v in council_econ.items() if k in price}
    out_path = os.path.join(args.out_dir, "boss.council5.drops.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"boss": "council5", "difficulty": args.difficulty, "players": args.players, "drops": council_econ}, f, indent=2, sort_keys=True)
    summary.append(("council5", rpk_from_drops(council_econ, price)))

    summary.sort(key=lambda x: x[1], reverse=True)
    print(f"RPK (Ist units) — expected value per kill (players={args.players}, diff={args.difficulty})")
    for k, v in summary:
        print(f"- {k:10s}: {v:.10f}")


if __name__ == "__main__":
    main()
