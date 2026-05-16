"""
build_extended_data.py — produce docs/data_extended.json.

Currently exposes a single axis (gender) on the chart, but the data
shape supports adding more axes later (region, age) by appending to
`axes_meta` and `membership_predicates_for_axis`. Metrics that don't
depend on the axis (narrowness, canonicity, contrarianism, mean
subject) are computed once per voter per mode. Axis-dependent
artifacts (group means, KDE per group, against-trend rankings,
per-book pct-in-group) are computed per (mode, axis).
"""
from __future__ import annotations

import csv
import json
import re
import unicodedata
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
WEB = ROOT / "docs"
WEB.mkdir(exist_ok=True)


def nfc(s):
    return unicodedata.normalize("NFC", s) if isinstance(s, str) else s


def load_csv(p):
    return list(csv.DictReader(open(p, encoding="utf-8")))


def slugify(name):
    s = name.lower()
    s = unicodedata.normalize("NFKD", s)
    s = s.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


# ============================================================================
# Load inputs
# ============================================================================
voters_full = json.load(open(ROOT / "raw" / "voters_full.json"))
top100 = {int(r["rank"]): r for r in load_csv(DATA / "books.csv")}
subj_rows = {int(r["rank"]): r for r in load_csv(DATA / "book_subject.csv")}
canon_rows = {int(r["rank"]): r for r in load_csv(DATA / "book_canonicity.csv")}
ag_main = {nfc(r["author"]): r["gender"] for r in load_csv(DATA / "author_gender.csv")}
ag_new = {}
if (DATA / "author_gender_new.csv").exists():
    ag_new = {nfc(r["author"]): r["gender"] for r in load_csv(DATA / "author_gender_new.csv")}
near_miss = {nfc(r["title"]): r for r in load_csv(DATA / "near_miss_codings.csv")}
# Long-tail codings (1-2 voter books, coded by agent). Keyed by (title, author).
longtail = {}
lt_path = DATA / "longtail_codings.csv"
if lt_path.exists():
    for r in load_csv(lt_path):
        longtail[(nfc(r["title"]), nfc(r["author"]))] = r
voter_gender = {nfc(r["voter"]): r for r in load_csv(DATA / "voter_gender.csv")}


def author_gender(name):
    name = nfc(name)
    return ag_main.get(name) or ag_new.get(name, "unknown")


# ============================================================================
# Books — one record per distinct book across all 1720 picks
# ============================================================================
books = []

# 1) Top-100 books, fully coded
for rank, b in sorted(top100.items()):
    s = subj_rows.get(rank, {})
    c = canon_rows.get(rank, {})
    books.append({
        "key": f"top-{rank}",
        "rank": rank,
        "title": b["title"],
        "author": b["author"],
        "author_gender": author_gender(b["author"]),
        "subject": float(s.get("handcoded_score", 0)),
        "canonicity": float(c["canonicity"]) if c.get("canonicity") else None,
        "year": int(c["year"]) if c.get("year") else None,
        "in_top_100": True,
        "voters": [],
    })

# 2) Near-miss books (3+ voters; hand-coded for subject/canonicity)
for title, c in near_miss.items():
    books.append({
        "key": "near-" + slugify(title),
        "rank": None,
        "title": title,
        "author": c["author"],
        "author_gender": author_gender(c["author"]),
        "subject": float(c["subject"]),
        "canonicity": float(c["canonicity"]),
        "year": int(c["year"]) if c["year"] else None,
        "in_top_100": False,
        "near_miss": True,
        "voters": [],
    })

# 3) Remaining picks (1-2 voters; no subject/canonicity coding)
known_titles = {nfc(b["title"]) for b in books}
seen_remaining = {}
for v in voters_full:
    for p in v["topTen"]:
        if p["rank"] is not None or nfc(p["name"]) in known_titles:
            continue
        olid = p["openLibraryId"]
        if olid in seen_remaining:
            continue
        seen_remaining[olid] = p

for olid, p in seen_remaining.items():
    lt = longtail.get((nfc(p["name"]), nfc(p["author"])))
    books.append({
        "key": "other-" + slugify(p["name"])[:60] + "-" + (olid or "noid"),
        "rank": None,
        "title": p["name"],
        "author": p["author"],
        "author_gender": author_gender(p["author"]),
        "subject":    float(lt["subject"])    if lt and lt.get("subject")    not in (None, "") else None,
        "canonicity": float(lt["canonicity"]) if lt and lt.get("canonicity") not in (None, "") else None,
        "year":       int(lt["year"])         if lt and lt.get("year")       not in (None, "", "0") else None,
        "in_top_100": False,
        "near_miss": False,
        "voters": [],
    })

key_by_title_author = {(nfc(b["title"]), nfc(b["author"])): b["key"] for b in books}
books_by_key = {b["key"]: b for b in books}


# ============================================================================
# Voters — attach attributes and ballots
# ============================================================================
voter_to_id = {nfc(v["name"]): slugify(v["name"]) for v in voters_full}
voters_out = []

for v in voters_full:
    vname = nfc(v["name"])
    vid = voter_to_id[vname]
    vg = voter_gender.get(vname, {})
    ballot = []
    for p in v["topTen"]:
        title = nfc(p["name"]); author = nfc(p["author"])
        key = key_by_title_author.get((title, author))
        if key is None:
            matches = [k for (t, a), k in key_by_title_author.items() if t == title]
            key = matches[0] if matches else None
        ballot.append({
            "position": p["position"],
            "book_key": key,
            "title": p["name"],
            "author": p["author"],
            "rank": p["rank"],
        })
        if key:
            books_by_key[key]["voters"].append(vid)
    voters_out.append({
        "id": vid,
        "name": v["name"],
        "gender": vg.get("gender", "unknown"),
        "note": vg.get("evidence", ""),
        "confidence": vg.get("confidence", ""),
        "ballot": ballot,
    })

n_total = len(voters_out)


# ============================================================================
# Axis definitions
# ============================================================================
def membership_predicates_for_axis(axis_key):
    """Return {group_key: predicate(voter) -> bool}. Only gender is wired in
    right now; other axes (region, age) can be added here later."""
    if axis_key == "gender":
        return {
            "F": lambda v: v["gender"] == "F",
            "M": lambda v: v["gender"] == "M",
            "NB": lambda v: v["gender"] == "NB",
        }
    raise ValueError(axis_key)


axes_meta = [
    {
        "key": "gender",
        "label": "Gender",
        "groups": [
            {"key": "F",  "label": "female voters"},
            {"key": "M",  "label": "male voters"},
            {"key": "NB", "label": "non-binary voters"},
        ],
        "author_parallel": True,            # authors are gender-coded too
        "groupings_exclusive": True,
        "default_highlight": "F",
    },
]

# fill in group counts
for axis in axes_meta:
    preds = membership_predicates_for_axis(axis["key"])
    for g in axis["groups"]:
        g["count"] = sum(1 for v in voters_out if preds[g["key"]](v))


# ============================================================================
# Per-book aggregates: pct_in_group for every (axis, group) pair
# ============================================================================
voter_by_id = {v["id"]: v for v in voters_out}

for b in books:
    n = len(b["voters"])
    b["vote_count"] = n
    b["pct_voters_by_group"] = {}
    for axis in axes_meta:
        preds = membership_predicates_for_axis(axis["key"])
        b["pct_voters_by_group"][axis["key"]] = {
            g["key"]: round(
                100 * sum(1 for vid in b["voters"] if preds[g["key"]](voter_by_id[vid])) / n, 1
            ) if n else 0.0
            for g in axis["groups"]
        }

# legacy back-compat field
for b in books:
    b["pct_F_voters"] = b["pct_voters_by_group"]["gender"]["F"]


# ============================================================================
# Per-voter axis-INDEPENDENT metrics, per mode
# ============================================================================
def compute_axis_indep_metrics(picks):
    subs, canons, years, pops = [], [], [], []
    for p in picks:
        b = books_by_key.get(p["book_key"])
        if not b:
            continue
        if b["subject"] is not None: subs.append(b["subject"])
        if b["canonicity"] is not None: canons.append(b["canonicity"])
        if b["year"]: years.append(b["year"])
        pops.append(b["vote_count"])
    return {
        "n_picks": len(picks),
        "n_coded_subj": len(subs),
        "mean_subject":         round(float(np.mean(subs)), 3)   if subs   else None,
        "std_subject":          round(float(np.std(subs)), 3)    if len(subs) > 1 else 0.0,
        "mean_canonicity":      round(float(np.mean(canons)), 3) if canons else None,
        "mean_year":            round(float(np.mean(years)), 1)  if years  else None,
        "mean_pick_popularity": round(float(np.mean(pops)), 2)   if pops   else None,
    }


def pct_authors_in_group(picks, axis_key, group_key, preds_for_author):
    """% of picks whose author is in the named group, when author_parallel."""
    n = 0; hits = 0
    for p in picks:
        b = books_by_key.get(p["book_key"])
        if not b: continue
        n += 1
        if preds_for_author[axis_key].get(group_key, lambda _: False)(b):
            hits += 1
    return round(100 * hits / n, 1) if n else 0.0


# author-side predicates per axis (only for axes with author_parallel)
def author_predicates_for_axis(axis_key):
    if axis_key == "gender":
        return {
            "F":  lambda b: b["author_gender"] == "F",
            "M":  lambda b: b["author_gender"] == "M",
            "NB": lambda b: b["author_gender"] == "NB",
        }
    return {}


author_preds = {a["key"]: author_predicates_for_axis(a["key"]) for a in axes_meta}


for v in voters_out:
    top_picks = [p for p in v["ballot"] if p["rank"] is not None]
    all_picks = v["ballot"]
    for mode_key, picks in [("top100", top_picks), ("all", all_picks)]:
        m = compute_axis_indep_metrics(picks)
        # per-axis pct-author breakdowns (only for author-parallel axes)
        m["pct_authors_by_group"] = {}
        for axis in axes_meta:
            if not axis["author_parallel"]:
                continue
            m["pct_authors_by_group"][axis["key"]] = {
                g["key"]: pct_authors_in_group(picks, axis["key"], g["key"], author_preds)
                for g in axis["groups"]
            }
        v[f"metrics_{mode_key}"] = m


# ============================================================================
# Per (mode, axis): group means, KDE, against-trend rankings
# ============================================================================
def ballot_subjects_for_group(picks, group_pred, voters_in_group):
    """Subjects of all picks across voters in a group."""
    out = []
    for v in voters_in_group:
        for p in picks(v):
            b = books_by_key.get(p["book_key"])
            if b and b["subject"] is not None:
                out.append(b["subject"])
    return out


def kde(values, xs, bw=0.55):
    arr = np.asarray(values, dtype=float)
    if arr.size == 0:
        return [0.0] * len(xs)
    return np.mean(
        np.exp(-0.5 * ((xs[:, None] - arr[None, :]) / bw) ** 2)
        / (bw * np.sqrt(2 * np.pi)),
        axis=1,
    ).tolist()


def local_maxima(ys, xs, frac=0.4):
    if not ys: return []
    peak = max(ys); out = []
    for i in range(1, len(ys) - 1):
        if ys[i] > ys[i - 1] and ys[i] > ys[i + 1] and ys[i] > peak * frac:
            out.append({"x": float(xs[i]), "y": float(ys[i])})
    return out


def top_n(records, key, n=8, reverse=False, predicate=None):
    candidates = records if predicate is None else [r for r in records if predicate(r)]
    return [r["id"] for r in sorted(candidates, key=key, reverse=reverse)[:n]]


xs = np.linspace(-3, 3, 121)
modes_out = {}
for mode_key in ("top100", "all"):
    pick_fn = (lambda v: [p for p in v["ballot"] if p["rank"] is not None]) if mode_key == "top100" else (lambda v: v["ballot"])
    metric_key = f"metrics_{mode_key}"

    # chartable books
    if mode_key == "top100":
        chart_keys = [b["key"] for b in books if b["in_top_100"]]
    else:
        chart_keys = [b["key"] for b in books if b["subject"] is not None]

    # voters with enough coded picks to be eligible for rankings
    eligible = [v for v in voters_out if (v[metric_key]["n_coded_subj"] or 0) >= 3]

    # axis-INDEPENDENT rankings (same across all axes)
    indep_rankings = {
        "narrowest":          top_n(eligible, lambda v: v[metric_key]["std_subject"]),
        "broadest":           top_n(eligible, lambda v: v[metric_key]["std_subject"], reverse=True),
        "most_male_coded":    top_n(eligible, lambda v: v[metric_key]["mean_subject"]),
        "most_female_coded":  top_n(eligible, lambda v: v[metric_key]["mean_subject"], reverse=True),
        "most_canonical":     top_n(eligible, lambda v: v[metric_key]["mean_canonicity"]),
        "most_idiosyncratic": top_n(eligible, lambda v: v[metric_key]["mean_canonicity"], reverse=True),
        "most_contrarian":    top_n(eligible, lambda v: v[metric_key]["mean_pick_popularity"]),
        "most_consensus":     top_n(eligible, lambda v: v[metric_key]["mean_pick_popularity"], reverse=True),
    }

    # per-axis: group means, KDE per group, against-trend rankings
    by_axis = {}
    for axis in axes_meta:
        preds = membership_predicates_for_axis(axis["key"])
        group_means = {}
        group_kdes = {}
        group_modes = {}
        against_trend = {}

        for g in axis["groups"]:
            group_voters = [v for v in voters_out if preds[g["key"]](v)]
            subs = ballot_subjects_for_group(pick_fn, lambda gv=group_voters: None, group_voters)
            # gather subjects via flatten
            subs = []
            for v in group_voters:
                for p in pick_fn(v):
                    b = books_by_key.get(p["book_key"])
                    if b and b["subject"] is not None:
                        subs.append(b["subject"])
            group_means[g["key"]] = round(float(np.mean(subs)), 3) if subs else None
            ys = kde(subs, xs)
            group_kdes[g["key"]] = ys
            group_modes[g["key"]] = local_maxima(ys, xs)

            # against-trend: voters in this group, sorted by |mean - group_mean|
            gm = group_means[g["key"]]
            if gm is not None:
                eligible_in_group = [v for v in eligible if preds[g["key"]](v)]
                # most extreme deviation in EACH direction — pick top-8 by distance
                against_trend[f"{g['key']}_against_trend"] = top_n(
                    eligible_in_group,
                    lambda v: abs((v[metric_key]["mean_subject"] or gm) - gm),
                    reverse=True,
                )

        by_axis[axis["key"]] = {
            "group_means": group_means,
            "kde_xs": [float(v) for v in xs],
            "kde_by_group": group_kdes,
            "modes_by_group": group_modes,
            "rankings_against_trend": against_trend,
        }

    modes_out[mode_key] = {
        "chart_book_keys": chart_keys,
        "rankings_axis_independent": indep_rankings,
        "by_axis": by_axis,
    }


# pool baseline by group
pool_by_axis = {}
for axis in axes_meta:
    preds = membership_predicates_for_axis(axis["key"])
    pool_by_axis[axis["key"]] = {
        g["key"]: round(100 * sum(1 for v in voters_out if preds[g["key"]](v)) / n_total, 1)
        for g in axis["groups"]
    }


out = {
    "books": books,
    "voters": voters_out,
    "axes": axes_meta,
    "pool_by_axis": pool_by_axis,
    "pool_F_pct": pool_by_axis["gender"]["F"],  # legacy
    "modes": modes_out,
    "n_voters": n_total,
    "n_books": len(books),
}

(WEB / "data_extended.json").write_text(
    json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
)
size_kb = (WEB / "data_extended.json").stat().st_size / 1024
print(f"Wrote docs/data_extended.json: "
      f"{len(books)} books, {n_total} voters, {size_kb:.1f} KB")
for axis in axes_meta:
    print(f"  axis '{axis['key']}': "
          f"{ {g['key']: g['count'] for g in axis['groups']} }")
