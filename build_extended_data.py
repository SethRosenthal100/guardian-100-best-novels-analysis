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
from collections import Counter, defaultdict
from pathlib import Path

import networkx as nx
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

# 2) Near-miss books (3+ voters; coded for subject/canonicity)
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

# Helper indexes and aliases for ballot-pick resolution. The Guardian source
# sometimes uses a different title string than our books.csv for the same
# work (shorter form, translation alias, etc.) — we fall back through several
# match strategies before giving up.
books_by_author = {}
for (t, a), k in key_by_title_author.items():
    books_by_author.setdefault(a, []).append((t, k))

# Hand-coded title aliases for picks whose words don't overlap with the
# canonical title at all (e.g. translation aliases). Keyed by lowercase
# (title, author).
TITLE_ALIASES = {
    ("the stranger", "albert camus"): "The Outsider",
}


def _normalize_title_words(s):
    """Lowercase, strip punctuation, return set of significant words (>2 chars,
    not a small stopword)."""
    cleaned = re.sub(r"[^\w\s]", " ", (s or "").lower())
    stop = {"the", "and", "for", "with", "from"}
    return {w for w in cleaned.split() if len(w) > 2 and w not in stop}


def resolve_pick(p):
    """Resolve a voter-pick to a book key, trying progressively looser matches."""
    title = nfc(p["name"]); author = nfc(p["author"])
    rank = p.get("rank")

    # 1. Exact (title, author) match.
    key = key_by_title_author.get((title, author))
    if key:
        return key

    # 2. Title-only fallback (any author).
    matches = [k for (t, a), k in key_by_title_author.items() if t == title]
    if matches:
        return matches[0]

    # 3. Rank-based — for picks ranked 1..100 the Guardian rank uniquely
    #    identifies the book; use it whenever the title string drifted.
    if rank is not None and 1 <= rank <= 100:
        rank_key = f"top-{rank}"
        if rank_key in books_by_key:
            return rank_key

    # 4. Hand-coded title aliases (mainly translation differences).
    alias = TITLE_ALIASES.get((title.lower(), author.lower()))
    if alias is not None:
        for (t, a), k in key_by_title_author.items():
            if t == alias and a == author:
                return k

    # 5. Author + title-word overlap. Among books by the same author, find one
    #    whose normalized title shares ≥ 2 significant words with the pick's
    #    title. Picks "Alice in Wonderland" → "Alice's Adventures in Wonderland";
    #    "Strange Case of Dr Jekyll..." → "Dr. Jekyll and Mr. Hyde"; etc.
    if author in books_by_author:
        pick_words = _normalize_title_words(title)
        best_key = None
        best_overlap = 0
        for (book_title, k) in books_by_author[author]:
            book_words = _normalize_title_words(book_title)
            overlap = len(pick_words & book_words)
            if overlap >= 2 and overlap > best_overlap:
                best_overlap = overlap
                best_key = k
        if best_key:
            return best_key

    return None


for v in voters_full:
    vname = nfc(v["name"])
    vid = voter_to_id[vname]
    vg = voter_gender.get(vname, {})
    ballot = []
    for p in v["topTen"]:
        key = resolve_pick(p)
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
# Voter co-pick clustering + layout (baked once here so the live site renders
# directly without running networkx/spring-layout in the browser)
# ============================================================================
# Jaccard threshold for edges; modularity resolution; spring-layout knobs.
# LAYOUT_BOOST multiplies intra-community edge weights before spring-solve so
# communities pull into visually tight blobs. Seed is fixed so the layout
# (and therefore the published chart) is reproducible.
CLUSTER_JACCARD = 0.15
CLUSTER_RESOLUTION = 0.5
LAYOUT_K = 2.5
LAYOUT_BOOST = 3.0
LAYOUT_ITERATIONS = 400
LAYOUT_SEED = 7

# Cluster colors are assigned by VOTE RANK (rank 0 = most-voted = plum).
# 22 hues cover all 22 communities; nothing falls through to default_gray
# in the current dataset, but default_gray remains as a safety fallback.
#
# PRISM12 (the original 12-color CARTO-Prism-softened palette) is kept here
# as a named alternative — switch ACTIVE_PALETTE to revert.
PRISM12 = {
    "name": "prism_soft",
    "main": [
        "#8A3D6B", "#614D88", "#296589", "#439B9A", "#1A7951",
        "#74A452", "#D6A21E", "#CB7A1A", "#BD5A4C", "#6A446B",
        "#91558E", "#666666",
    ],
    "default_gray": "#CCCCCC",
}

# PRISM22 extends the soft-Prism register to 22 distinguishable hues.
# Ranks 0-8 and rank 10 keep their PRISM12 colors; rank 9 (was dark purple,
# too close to rank-0 plum) and rank 11 (was dark gray, too close to default)
# are swapped for dusty rose and slate blue. Ranks 12-21 fill the long tail.
PRISM22 = {
    "name": "prism_soft_22",
    "main": [
        "#8A3D6B", "#614D88", "#296589", "#439B9A", "#1A7951",
        "#74A452", "#D6A21E", "#CB7A1A", "#BD5A4C", "#B57D8E",
        "#91558E", "#5F7891", "#8FA063", "#875E32", "#62888B",
        "#8E5C7F", "#7E7733", "#4E6079", "#5C9080", "#B86A7C",
        "#98604A", "#444E5E",
    ],
    "default_gray": "#CCCCCC",
}

CLUSTER_PALETTE = PRISM22


print("Computing voter co-pick clusters + layout...")

# Set vote_count up front so we can use it here; the per-book aggregates
# section below will set it again to the same value (harmless).
for b in books:
    b["vote_count"] = len(b["voters"])

# Voter sets per book (only books with at least one voter participate)
voters_for_book = defaultdict(set)
for v in voters_out:
    for p in v["ballot"]:
        if p["book_key"]:
            voters_for_book[p["book_key"]].add(v["id"])

cluster_book_keys = [b["key"] for b in books if voters_for_book[b["key"]]]

G = nx.Graph()
for k in cluster_book_keys:
    G.add_node(k)
for i, ka in enumerate(cluster_book_keys):
    sa = voters_for_book[ka]
    for kb in cluster_book_keys[i + 1:]:
        sb = voters_for_book[kb]
        inter = len(sa & sb)
        if not inter:
            continue
        jac = inter / len(sa | sb)
        if jac >= CLUSTER_JACCARD:
            G.add_edge(ka, kb, weight=jac)

# Keep only the largest connected component for clustering + layout.
largest = max(nx.connected_components(G), key=len)
G_lcc = G.subgraph(largest).copy()
isolated_keys = set(G.nodes) - set(G_lcc.nodes)

communities = list(
    nx.community.greedy_modularity_communities(
        G_lcc, weight="weight", resolution=CLUSTER_RESOLUTION
    )
)
node_to_comm = {n: i for i, c in enumerate(communities) for n in c}

# Spring layout on a copy with intra-community edge weights boosted — pulls
# clusters tighter; matches the offline renderer.
H = G_lcc.copy()
for u, v, d in H.edges(data=True):
    if node_to_comm.get(u) == node_to_comm.get(v):
        d["weight"] = d["weight"] * LAYOUT_BOOST
pos = nx.spring_layout(
    H, weight="weight", iterations=LAYOUT_ITERATIONS, seed=LAYOUT_SEED, k=LAYOUT_K
)

# Attach cluster_id + layout to each book; books not in LCC get null.
for b in books:
    k = b["key"]
    if k in pos:
        cid = node_to_comm[k]
        b["cluster_id"] = cid
        b["layout_x"] = round(float(pos[k][0]), 5)
        b["layout_y"] = round(float(pos[k][1]), 5)
    else:
        b["cluster_id"] = None
        b["layout_x"] = None
        b["layout_y"] = None

# Cluster summaries — counts, total votes, color, ranked book keys. We
# assign colors by VOTE RANK (not by modularity-output id) so that the same
# storyline cluster (e.g. the canon, always #1 by votes) keeps the same color
# across rebuilds even when greedy_modularity returns communities in a
# different order. Top 12 by votes get the 12 palette colors; the rest fall
# to default gray.
cluster_summary = []
for cid, members in enumerate(communities):
    book_keys = sorted(
        members,
        key=lambda k: (-books_by_key[k]["vote_count"], books_by_key[k]["title"]),
    )
    total_votes = sum(books_by_key[k]["vote_count"] for k in members)
    cluster_summary.append({
        "id": cid,
        "book_count": len(members),
        "vote_count": total_votes,
        "votes_per_book": round(total_votes / len(members), 2) if members else 0,
        "top_book_keys": book_keys[:10],  # for legend / cluster panel
    })
# Sort by total votes desc — vote rank also drives color assignment.
cluster_summary.sort(key=lambda c: -c["vote_count"])
palette_main = CLUSTER_PALETTE["main"]
for rank, c in enumerate(cluster_summary):
    c["color"] = (palette_main[rank] if rank < len(palette_main)
                  else CLUSTER_PALETTE["default_gray"])

# Book edges for rendering (only LCC, only above threshold). Keep them small.
book_edges = [
    {"a": u, "b": v, "w": round(float(d["weight"]), 4)}
    for u, v, d in G_lcc.edges(data=True)
]

# Per-voter cluster picks — sorted dominant-cluster-first (anchor at inner
# ring of the donut) with gray (-1, books not in graph) pushed to the end.
for v in voters_out:
    picks_clusters = []
    for p in v["ballot"]:
        bk = p.get("book_key")
        if not bk:
            picks_clusters.append(-1)
            continue
        cid = node_to_comm.get(bk)
        picks_clusters.append(-1 if cid is None else cid)
    in_graph = [c for c in picks_clusters if c >= 0]
    out_graph = [c for c in picks_clusters if c < 0]
    counts = Counter(in_graph)
    sorted_picks = []
    for c, n in counts.most_common():
        sorted_picks.extend([c] * n)
    sorted_picks.extend(out_graph)
    while len(sorted_picks) < 10:
        sorted_picks.append(-1)
    if counts:
        dominant, dominant_count = counts.most_common(1)[0]
    else:
        dominant, dominant_count = None, 0
    v["cluster_picks_sorted"] = sorted_picks[:10]
    v["dominant_cluster"] = dominant
    v["dominant_cluster_count"] = dominant_count
    v["n_distinct_clusters"] = len(counts)

print(f"  {G_lcc.number_of_nodes()} books in graph, "
      f"{len(isolated_keys)} isolated, "
      f"{G_lcc.number_of_edges()} edges, "
      f"{len(communities)} communities "
      f"(sizes={[len(c) for c in communities[:8]]}...)")

# Canon cluster = the one with the highest votes-per-book ratio (densely-
# voted, regardless of size). Used by the "anchored in canon" ranking.
canon_cluster_id = max(cluster_summary, key=lambda c: c["votes_per_book"])["id"]
print(f"  canon cluster: id={canon_cluster_id} "
      f"({cluster_summary[0]['vote_count']} votes / {cluster_summary[0]['book_count']} books)")


def voter_cluster_metrics_for_mode(voter, mode_key):
    """Compute one voter's cluster-shape metrics for the given mode.

    In `top100` mode, picks whose book isn't in_top_100 count as off-grid.
    In `all` mode, only picks outside the cluster graph (cluster_id is None,
    i.e. the 14 isolated / under-connected books) count as off-grid.
    """
    picks_clusters = []
    pick_vote_counts = []
    for p in voter["ballot"]:
        bk = p.get("book_key")
        if not bk:
            picks_clusters.append(-1); pick_vote_counts.append(0); continue
        b = books_by_key.get(bk)
        if not b:
            picks_clusters.append(-1); pick_vote_counts.append(0); continue
        if mode_key == "top100" and not b["in_top_100"]:
            picks_clusters.append(-1)
            pick_vote_counts.append(b["vote_count"])
            continue
        cid = b.get("cluster_id")
        picks_clusters.append(cid if cid is not None else -1)
        pick_vote_counts.append(b["vote_count"])
    in_graph = [c for c in picks_clusters if c >= 0]
    off_grid_count = sum(1 for c in picks_clusters if c < 0)
    counts = Counter(in_graph)
    most_common = counts.most_common()
    dominant = most_common[0][0] if most_common else None
    dom_count = most_common[0][1] if most_common else 0
    dom_cluster_size = len(communities[dominant]) if dominant is not None else None
    second_count = most_common[1][1] if len(most_common) > 1 else 0
    second_cluster = most_common[1][0] if len(most_common) > 1 else None
    return {
        "dom_count": dom_count,
        "dominant": dominant,
        "dom_cluster_size": dom_cluster_size,
        "n_distinct": len(counts),
        "sum_vote_count": sum(pick_vote_counts),
        "off_grid_count": off_grid_count,
        "canon_count": counts.get(canon_cluster_id, 0),
        "second_count": second_count,
        "second_cluster": second_cluster,
        "bridge_balance": dom_count - second_count,
        "bridge_total": dom_count + second_count,
    }


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

    # voters with enough coded picks to be eligible for the gender-axis
    # against-trend rankings (which still use subject coding).
    eligible = [v for v in voters_out if (v[metric_key]["n_coded_subj"] or 0) >= 3]

    # Per-voter cluster metrics for THIS mode. Attached to v["metrics_<mode>"]
    # so the panel/tooltips can display them; also fed into the cluster
    # rankings below.
    cluster_metric_records = []
    for v in voters_out:
        cm = voter_cluster_metrics_for_mode(v, mode_key)
        v[metric_key]["cluster"] = cm
        cluster_metric_records.append({"id": v["id"], **cm})

    # Cluster-native rankings (replaces the old subject/canonicity-based set).
    cluster_rankings = {
        "most_cluster_loyal": top_n(
            cluster_metric_records,
            lambda r: -r["dom_count"]),
        "most_cluster_diverse": top_n(
            cluster_metric_records,
            lambda r: -r["n_distinct"]),
        "anchored_in_canon": top_n(
            cluster_metric_records,
            lambda r: -r["canon_count"],
            predicate=lambda r: r["canon_count"] >= 3),
        "anchored_in_niche": top_n(
            cluster_metric_records,
            lambda r: (r["dom_cluster_size"] or 99999, -r["dom_count"]),
            predicate=lambda r: r["dominant"] is not None and r["dom_count"] >= 3),
        "picks_popular_books": top_n(
            cluster_metric_records,
            lambda r: -r["sum_vote_count"]),
        "picks_obscure_books": top_n(
            cluster_metric_records,
            lambda r: r["sum_vote_count"]),
        "most_off_grid": top_n(
            cluster_metric_records,
            lambda r: -r["off_grid_count"]),
        "bridges_two_clusters": top_n(
            cluster_metric_records,
            lambda r: (r["bridge_balance"], -r["bridge_total"]),
            predicate=lambda r: r["bridge_total"] >= 6),
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
        "rankings_cluster": cluster_rankings,
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
    "clusters": {
        "palette_name": CLUSTER_PALETTE["name"],
        "default_gray": CLUSTER_PALETTE["default_gray"],
        "items": cluster_summary,
        "params": {
            "jaccard_threshold": CLUSTER_JACCARD,
            "resolution": CLUSTER_RESOLUTION,
            "layout_k": LAYOUT_K,
            "layout_boost": LAYOUT_BOOST,
            "layout_iterations": LAYOUT_ITERATIONS,
            "layout_seed": LAYOUT_SEED,
        },
    },
    "book_edges": book_edges,
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
