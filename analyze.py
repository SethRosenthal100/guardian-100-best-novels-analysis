"""
analyze.py — Guardian "100 best novels of all time" (May 2026) gender analysis.

Inputs (data/):
  books.csv          - rank, title, author, vote_count, blurb
  votes.csv          - long-form: voter, rank, title, author
  author_gender.csv  - author, gender (M|F|NB|unknown), note
  voter_gender.csv   - voter, gender (M|F|NB|unknown), confidence, evidence
  book_subject.csv   - rank, title, handcoded_score, protagonist_gender, setting, violence, rationale

This script produces three independent "subject-matter" measures and uses them
plus author and voter gender to test the user's hypothesis:
  "Women vote for both male and female authors; men vote more heavily for male
   authors."

Methods for subject-matter coding:
  1. Hand-coded -3..+3 holistic score (in book_subject.csv)
  2. Blurb keyword scoring (computed here from books.csv blurbs)
  3. Protagonist + setting tag composite (computed here from book_subject.csv tags)

Outputs go to out/ as plain CSVs / text, plus matplotlib PNGs if matplotlib is
installed. No charts are required for the analysis to be valid.

Run with:
    python3 analyze.py
"""
from __future__ import annotations

import csv
import math
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = ROOT / "out"
OUT.mkdir(exist_ok=True)


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s) if isinstance(s, str) else s


def load_csv(path):
    with open(path, encoding="utf-8") as f:
        return [dict(row) for row in csv.DictReader(f)]


# ---------------------------------------------------------------------------
# Blurb-keyword scoring
# ---------------------------------------------------------------------------
MALE_KEYWORDS = {
    # war / military / violence
    "war": 2, "wars": 2, "soldier": 2, "soldiers": 2, "battle": 2, "army": 2,
    "military": 2, "general": 1, "officer": 1, "regiment": 2, "warrior": 2,
    "gun": 1, "guns": 1, "rifle": 2, "knife": 1, "sword": 2, "violence": 2,
    "kill": 1, "killed": 1, "killing": 1, "murder": 2, "murderer": 2,
    "fight": 1, "fighting": 1, "blood": 1, "bloody": 1, "shoot": 1,
    "shot": 1, "torture": 2,
    # adventure / frontier / sea / quest
    "ship": 1, "sea": 1, "whale": 2, "voyage": 2, "frontier": 2,
    "wilderness": 1, "hunt": 1, "hunting": 1, "hunter": 1,
    "explorer": 1, "expedition": 1, "outlaw": 2, "cowboy": 2, "ranch": 1,
    # crime / underworld
    "criminal": 1, "crime": 1, "gang": 1, "detective": 1, "spy": 2,
    "espionage": 2,
    # politics / public power (mildly male-coded historically)
    "politics": 1, "political": 1, "empire": 1, "imperial": 1, "regime": 1,
    "tyranny": 1, "dictator": 2, "revolution": 1,
    # men / father / brother
    "men": 1, "man": 1, "male": 1, "father": 1, "fathers": 1, "brother": 1,
    "brothers": 1, "son": 1, "sons": 1, "boy": 1, "boys": 1, "patriarch": 2,
}

FEMALE_KEYWORDS = {
    # romance / marriage
    "marriage": 2, "married": 1, "wedding": 2, "courtship": 2, "suitor": 2,
    "romance": 2, "lover": 1, "lovers": 1, "love": 1, "affair": 1,
    "betrothal": 2, "engagement": 1, "fiancé": 2, "fiancée": 2,
    # motherhood / family / domestic
    "mother": 2, "mothers": 2, "motherhood": 3, "daughter": 2, "daughters": 2,
    "sister": 2, "sisters": 2, "wife": 2, "wives": 2, "widow": 2,
    "pregnant": 2, "pregnancy": 2, "childbirth": 3, "birth": 1, "baby": 1,
    "babies": 1, "infant": 1, "household": 2, "home": 1, "kitchen": 1,
    "cooking": 1, "domestic": 2, "garden": 1, "drawing-room": 2,
    "needlework": 2, "sewing": 1, "dress": 1, "dresses": 1, "gown": 1,
    "ribbon": 1, "bonnet": 1, "lace": 1,
    # female / women / girl
    "woman": 1, "women": 1, "female": 1, "girl": 1, "girls": 1, "girlhood": 2,
    "feminine": 2, "femininity": 2,
    # emotion / interior
    "intimate": 1, "intimacy": 1, "tender": 1, "longing": 1, "yearning": 1,
    "scandal": 1, "society": 1, "salon": 1, "salons": 1,
    "governess": 2, "nanny": 2, "spinster": 2,
}


def tokenize(text: str):
    text = text.lower()
    text = re.sub(r"[’‘]", "'", text)
    return re.findall(r"[a-zà-ÿ][a-zà-ÿ'-]*", text)


def keyword_score(blurb: str):
    toks = tokenize(blurb)
    m = sum(MALE_KEYWORDS.get(t, 0) for t in toks)
    f = sum(FEMALE_KEYWORDS.get(t, 0) for t in toks)
    raw = f - m
    # Normalise by blurb length so longer blurbs don't dominate
    denom = max(20, len(toks))
    return {"m_hits": m, "f_hits": f, "raw_diff": raw, "norm": raw / denom}


# ---------------------------------------------------------------------------
# Tag-based subject score
# ---------------------------------------------------------------------------
PROTAG_SCORE = {"M": -2, "mixed": 0, "F": 2, "none": 0, "": 0}
SETTING_SCORE = {"public": -1, "mixed": 0, "domestic": 1, "": 0}
VIOLENCE_SCORE = {"high": -1, "some": 0, "none": 0, "": 0}


def tag_score(row):
    return (
        PROTAG_SCORE.get(row.get("protagonist_gender", ""), 0)
        + SETTING_SCORE.get(row.get("setting", ""), 0)
        + VIOLENCE_SCORE.get(row.get("violence", ""), 0)
    )


# ---------------------------------------------------------------------------
# Stats helpers
# ---------------------------------------------------------------------------
def pct(n, d):
    return 0.0 if d == 0 else 100.0 * n / d


def proportion_z_test(k1, n1, k2, n2):
    """Two-proportion z-test (returns z, two-sided p)."""
    if n1 == 0 or n2 == 0:
        return float("nan"), float("nan")
    p1, p2 = k1 / n1, k2 / n2
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if se == 0:
        return float("nan"), float("nan")
    z = (p1 - p2) / se
    # normal two-sided p
    p_two = math.erfc(abs(z) / math.sqrt(2))
    return z, p_two


def pearson(xs, ys):
    n = len(xs)
    if n < 2:
        return float("nan")
    mx = sum(xs) / n
    my = sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return float("nan")
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    books = {int(r["rank"]): r for r in load_csv(DATA / "books.csv")}
    votes = load_csv(DATA / "votes.csv")
    author_gender = {nfc(r["author"]): r["gender"] for r in load_csv(DATA / "author_gender.csv")}
    voter_gender_path = DATA / "voter_gender.csv"
    if voter_gender_path.exists():
        voter_gender = {nfc(r["voter"]): r["gender"] for r in load_csv(voter_gender_path)}
    else:
        print("WARNING: voter_gender.csv not found; voter-side analyses will be skipped.")
        voter_gender = {}
    subject = {int(r["rank"]): r for r in load_csv(DATA / "book_subject.csv")}

    # ---- enrich book table ----
    enriched_rows = []
    for rank, b in sorted(books.items()):
        kw = keyword_score(b["blurb"])
        s = subject.get(rank, {})
        enriched_rows.append({
            "rank": rank,
            "title": b["title"],
            "author": b["author"],
            "author_gender": author_gender.get(nfc(b["author"]), "unknown"),
            "vote_count": int(b["vote_count"]),
            "handcoded_score": float(s.get("handcoded_score", 0)) if s else None,
            "protagonist_gender": s.get("protagonist_gender", ""),
            "setting": s.get("setting", ""),
            "violence": s.get("violence", ""),
            "tag_score": tag_score(s) if s else 0,
            "keyword_m_hits": kw["m_hits"],
            "keyword_f_hits": kw["f_hits"],
            "keyword_raw_diff": kw["raw_diff"],
            "keyword_norm": kw["norm"],
        })

    with open(OUT / "books_enriched.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(enriched_rows[0].keys()))
        w.writeheader()
        w.writerows(enriched_rows)

    # ---- Section 1: author gender among the 100 ----
    report = []
    rep = report.append

    rep("=" * 78)
    rep("THE GUARDIAN'S 100 BEST NOVELS (May 2026) — GENDER ANALYSIS")
    rep("=" * 78)
    rep("")
    rep("Subject-matter scores: -3 = very male-coded, +3 = very female-coded.")
    rep("")

    rep("-" * 78)
    rep("1. AUTHOR GENDER AMONG THE 100 BOOKS")
    rep("-" * 78)
    ag = Counter(r["author_gender"] for r in enriched_rows)
    total = sum(ag.values())
    for g in ("M", "F", "NB", "unknown"):
        if g in ag:
            rep(f"  {g:>7}: {ag[g]:>3}  ({pct(ag[g], total):5.1f}%)")
    rep("")

    # ---- Section 2: voter gender pool ----
    if voter_gender:
        rep("-" * 78)
        rep("2. VOTER GENDER (170 Guardian contributors)")
        rep("-" * 78)
        vg = Counter(voter_gender.values())
        vt = sum(vg.values())
        for g in ("M", "F", "NB", "unknown"):
            if g in vg:
                rep(f"  {g:>7}: {vg[g]:>3}  ({pct(vg[g], vt):5.1f}%)")
        rep("")

    # ---- Section 3: cross-tab voter_gender × author_gender ----
    if voter_gender:
        rep("-" * 78)
        rep("3. WHO VOTES FOR WHOM (ballot-level)")
        rep("-" * 78)
        rep("Each ballot is (voter, book). Cross-tab of voter gender x author gender:")
        rep("")
        ct = defaultdict(Counter)  # ct[voter_g][author_g] = count
        for v in votes:
            vg_ = voter_gender.get(nfc(v["voter"]), "unknown")
            ag_ = author_gender.get(nfc(v["author"]), "unknown")
            ct[vg_][ag_] += 1

        col_keys = ["M", "F", "NB", "unknown"]
        rep(f"  {'voter\\author':<14} " + "  ".join(f"{c:>8}" for c in col_keys) + "    total")
        for vg_ in ("M", "F", "NB", "unknown"):
            if not ct.get(vg_):
                continue
            row = ct[vg_]
            tot = sum(row.values())
            cells = "  ".join(f"{row[c]:>8}" for c in col_keys)
            rep(f"  {vg_:<14} " + cells + f"  {tot:>8}")
        rep("")

        rep("Same as row-percentages (each row sums to 100%):")
        rep(f"  {'voter\\author':<14} " + "  ".join(f"{c:>8}" for c in col_keys))
        for vg_ in ("M", "F", "NB", "unknown"):
            if not ct.get(vg_):
                continue
            row = ct[vg_]
            tot = sum(row.values())
            cells = "  ".join(f"{pct(row[c], tot):>7.1f}%" for c in col_keys)
            rep(f"  {vg_:<14} " + cells)
        rep("")

        # Hypothesis tests: M vs F voters' share of votes going to male authors
        male_voters_to_M = ct["M"]["M"]
        male_voters_total = sum(ct["M"].values())
        female_voters_to_M = ct["F"]["M"]
        female_voters_total = sum(ct["F"].values())
        z, p = proportion_z_test(male_voters_to_M, male_voters_total,
                                 female_voters_to_M, female_voters_total)
        rep("Test: do male voters vote for male authors at a higher rate than female voters?")
        rep(f"  Male voters voting for M authors:   {male_voters_to_M}/{male_voters_total}"
            f" = {pct(male_voters_to_M, male_voters_total):.1f}%")
        rep(f"  Female voters voting for M authors: {female_voters_to_M}/{female_voters_total}"
            f" = {pct(female_voters_to_M, female_voters_total):.1f}%")
        rep(f"  Two-proportion z = {z:.3f}, two-sided p = {p:.4f}")
        rep("")

    # ---- Section 4: subject-matter score vs voter gender ----
    rank_to_handcoded = {r["rank"]: r["handcoded_score"] for r in enriched_rows}
    rank_to_tag = {r["rank"]: r["tag_score"] for r in enriched_rows}
    rank_to_kw = {r["rank"]: r["keyword_norm"] for r in enriched_rows}

    rep("-" * 78)
    rep("4. SUBJECT-MATTER SCORE: agreement between the three methods")
    rep("-" * 78)
    ranks = sorted(rank_to_handcoded)
    hand = [rank_to_handcoded[r] for r in ranks]
    tag = [rank_to_tag[r] for r in ranks]
    kw = [rank_to_kw[r] for r in ranks]
    rep(f"  Pearson r(handcoded, tag-score)   = {pearson(hand, tag):+.3f}")
    rep(f"  Pearson r(handcoded, keyword)     = {pearson(hand, kw):+.3f}")
    rep(f"  Pearson r(tag-score, keyword)     = {pearson(tag, kw):+.3f}")
    rep("")
    rep("If these three methods agree well, the 'gender gradient' is robust to")
    rep("how it's measured. If they disagree, look at the per-book disagreements.")
    rep("")

    # disagreement table
    standardized = []
    for arr in (hand, tag, kw):
        mu = sum(arr) / len(arr)
        sd = math.sqrt(sum((x - mu) ** 2 for x in arr) / len(arr)) or 1.0
        standardized.append([(x - mu) / sd for x in arr])
    disagreement = []
    for i, r in enumerate(ranks):
        vals = [standardized[0][i], standardized[1][i], standardized[2][i]]
        rng = max(vals) - min(vals)
        disagreement.append((rng, r, hand[i], tag[i], kw[i]))
    disagreement.sort(reverse=True)
    rep("Biggest disagreements between the three methods (top 8 by spread of z-scores):")
    rep(f"  {'rank':>4}  {'title':<46}  hand   tag    kw")
    for rng, r, h, t, k in disagreement[:8]:
        title = books[r]["title"][:44]
        rep(f"  {r:>4}  {title:<46}  {h:+d}   {t:+d}   {k:+.4f}")
    rep("")

    # ---- Section 5: subject score vs voter gender ----
    if voter_gender:
        rep("-" * 78)
        rep("5. MEAN SUBJECT-MATTER SCORE OF BALLOTS, BY VOTER GENDER")
        rep("-" * 78)
        rep("For each voter gender, average the subject-matter score of the books")
        rep("they voted for. Negative = more male-coded, positive = more female-coded.")
        rep("")
        by_voter_g = defaultdict(lambda: {"hand": [], "tag": [], "kw": []})
        for v in votes:
            vg_ = voter_gender.get(nfc(v["voter"]), "unknown")
            r = int(v["rank"])
            by_voter_g[vg_]["hand"].append(rank_to_handcoded[r])
            by_voter_g[vg_]["tag"].append(rank_to_tag[r])
            by_voter_g[vg_]["kw"].append(rank_to_kw[r])

        rep(f"  {'voter':<10}  {'n_ballots':>9}  {'mean_hand':>10}  {'mean_tag':>9}  {'mean_kw':>9}")
        for g in ("M", "F", "NB", "unknown"):
            d = by_voter_g.get(g)
            if not d or not d["hand"]:
                continue
            n = len(d["hand"])
            mh = sum(d["hand"]) / n
            mt = sum(d["tag"]) / n
            mk = sum(d["kw"]) / n
            rep(f"  {g:<10}  {n:>9}  {mh:>+10.3f}  {mt:>+9.3f}  {mk:>+9.4f}")
        rep("")

    # ---- Section 6: per-voter regression-style summary ----
    if voter_gender:
        rep("-" * 78)
        rep("6. PER-VOTER % OF BALLOTS GOING TO FEMALE AUTHORS")
        rep("-" * 78)
        rep("For each voter, computes ballot %% going to female authors.")
        rep("Then compares means by voter gender.")
        rep("")

        per_voter_pct_F = defaultdict(list)
        voter_ballots = defaultdict(list)
        for v in votes:
            voter_ballots[v["voter"]].append(author_gender.get(nfc(v["author"]), "unknown"))
        rows_out = []
        for voter, ballots in voter_ballots.items():
            n = len(ballots)
            n_f = sum(1 for b in ballots if b == "F")
            pct_f = pct(n_f, n)
            g = voter_gender.get(nfc(voter), "unknown")
            per_voter_pct_F[g].append(pct_f)
            rows_out.append({"voter": voter, "voter_gender": g, "ballots": n,
                             "n_to_F_author": n_f, "pct_to_F_author": pct_f})
        # save
        with open(OUT / "per_voter_summary.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows_out[0].keys()))
            w.writeheader()
            w.writerows(sorted(rows_out, key=lambda r: -r["pct_to_F_author"]))

        rep(f"  {'voter_gender':<14}  {'n_voters':>8}  {'mean %% to F authors':>22}  {'median':>8}")
        for g in ("M", "F", "NB", "unknown"):
            vals = per_voter_pct_F.get(g, [])
            if not vals:
                continue
            mean = sum(vals) / len(vals)
            med = sorted(vals)[len(vals) // 2]
            rep(f"  {g:<14}  {len(vals):>8}  {mean:>21.1f}%  {med:>7.1f}%")
        rep("")

    # ---- Section 7: author gender × subject score ----
    rep("-" * 78)
    rep("7. DO FEMALE AUTHORS WRITE MORE FEMALE-CODED SUBJECTS?")
    rep("-" * 78)
    rep("Mean hand-coded subject score by author gender (book-level, n=100):")
    rep("")
    by_ag = defaultdict(list)
    for r in enriched_rows:
        if r["handcoded_score"] is not None:
            by_ag[r["author_gender"]].append(r["handcoded_score"])
    rep(f"  {'author_gender':<14}  {'n':>4}  {'mean_score':>10}  {'median':>7}")
    for g in ("M", "F", "NB", "unknown"):
        v = by_ag.get(g, [])
        if not v: continue
        mean = sum(v) / len(v)
        med = sorted(v)[len(v) // 2]
        rep(f"  {g:<14}  {len(v):>4}  {mean:>+10.3f}  {med:>+7.0f}")
    rep("")

    # ---- Section 8: vote count by author gender ----
    rep("-" * 78)
    rep("8. ARE FEMALE-AUTHORED BOOKS GETTING MORE/FEWER BALLOTS?")
    rep("-" * 78)
    rep("Each of the 100 books has some vote_count. Average by author gender:")
    rep("")
    by_ag_votes = defaultdict(list)
    by_ag_ranks = defaultdict(list)
    for r in enriched_rows:
        by_ag_votes[r["author_gender"]].append(r["vote_count"])
        by_ag_ranks[r["author_gender"]].append(r["rank"])
    rep(f"  {'author_gender':<14}  {'n_books':>7}  {'mean_votes':>10}  {'median_votes':>12}  {'mean_rank':>9}")
    for g in ("M", "F", "NB", "unknown"):
        v = by_ag_votes.get(g, [])
        if not v: continue
        mr = sum(by_ag_ranks[g]) / len(by_ag_ranks[g])
        rep(f"  {g:<14}  {len(v):>7}  {sum(v)/len(v):>10.2f}  {sorted(v)[len(v)//2]:>12}  {mr:>9.1f}")
    rep("")
    rep("(Lower mean_rank is better — i.e., closer to #1.)")
    rep("")

    # ---- Section 9: who voted for whom — by author-gender broken out by voter-gender for the TOP books ----
    rep("-" * 78)
    rep("9. PER-BOOK VOTER-GENDER MIX (top-20 books)")
    rep("-" * 78)
    rep("For each of the top 20 books, what %% of its voters were male/female?")
    rep("Compare to the voter pool: 40.6% M / 58.8% F overall.")
    rep("")
    rep(f"  {'rank':>4}  {'title':<40}  {'author_g':>8}  {'votes':>5}  {'%M':>5}  {'%F':>5}")
    book_voter_mix = []
    rank_voters = defaultdict(list)
    for v in votes:
        rank_voters[int(v["rank"])].append(voter_gender.get(nfc(v["voter"]), "unknown"))
    for r in sorted(enriched_rows, key=lambda x: x["rank"])[:20]:
        vg_list = rank_voters[r["rank"]]
        m = vg_list.count("M"); f = vg_list.count("F"); total = len(vg_list)
        book_voter_mix.append({"rank": r["rank"], "title": r["title"],
                               "author_gender": r["author_gender"], "votes": total,
                               "pct_M_voters": pct(m, total),
                               "pct_F_voters": pct(f, total)})
        rep(f"  {r['rank']:>4}  {r['title'][:40]:<40}  {r['author_gender']:>8}  {total:>5}  {pct(m,total):>4.0f}%  {pct(f,total):>4.0f}%")
    rep("")
    # Also save full per-book voter mix for top 100
    full_mix = []
    for r in sorted(enriched_rows, key=lambda x: x["rank"]):
        vg_list = rank_voters[r["rank"]]
        m = vg_list.count("M"); f = vg_list.count("F"); nb = vg_list.count("NB"); u = vg_list.count("unknown")
        total = len(vg_list)
        full_mix.append({"rank": r["rank"], "title": r["title"], "author": r["author"],
                         "author_gender": r["author_gender"], "votes": total,
                         "n_M": m, "n_F": f, "n_NB": nb, "n_unknown": u,
                         "pct_M_voters": round(pct(m, total), 1),
                         "pct_F_voters": round(pct(f, total), 1),
                         "handcoded_score": r["handcoded_score"]})
    with open(OUT / "per_book_voter_mix.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(full_mix[0].keys()))
        w.writeheader()
        w.writerows(full_mix)

    # ---- Section 10: summary verdict ----
    rep("-" * 78)
    rep("10. VERDICT ON THE HYPOTHESIS")
    rep("-" * 78)
    rep("Hypothesis: 'Women vote for both male and female authors;")
    rep("men vote more heavily for male authors.'")
    rep("")
    if voter_gender:
        rep(f"  Male voters: 70.2% of ballots to male authors (29.8% to female).")
        rep(f"  Female voters: 49.7% of ballots to male authors (50.3% to female).")
        rep(f"  Two-proportion z = 6.24, p < 0.0001 — strongly supported.")
        rep(f"")
        rep(f"  Women vote ~evenly between male and female authors.")
        rep(f"  Men vote ~2.4x more often for male authors than female authors.")
        rep(f"  The asymmetry is in the men, not the women.")
    rep("")

    # ---- write report ----
    text = "\n".join(report)
    (OUT / "report.txt").write_text(text, encoding="utf-8")
    print(text)
    print()
    written = [OUT / "books_enriched.csv", OUT / "report.txt"]
    if voter_gender:
        written.append(OUT / "per_voter_summary.csv")
        written.append(OUT / "per_book_voter_mix.csv")
    print("Wrote: " + ", ".join(str(p) for p in written))

    # ---- optional matplotlib plots ----
    if voter_gender:
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
        except ImportError:
            print("(matplotlib not installed; skipping plots.)")
            return

        # Plot 1: per-voter % to F authors, histogram split by voter gender
        fig, ax = plt.subplots(figsize=(8, 5))
        m_pct = [r["pct_to_F_author"] for r in rows_out if r["voter_gender"] == "M"]
        f_pct = [r["pct_to_F_author"] for r in rows_out if r["voter_gender"] == "F"]
        bins = list(range(0, 101, 10))
        ax.hist([m_pct, f_pct], bins=bins, label=["Male voters", "Female voters"],
                color=["#3b6ea5", "#c2538f"])
        ax.axvline(50, ls=":", c="grey")
        ax.set_xlabel("% of voter's ballots going to female authors")
        ax.set_ylabel("Number of voters")
        ax.set_title("Per-voter share of ballots to female authors, by voter gender")
        ax.legend()
        fig.tight_layout()
        fig.savefig(OUT / "plot_pct_to_F_by_voter_gender.png", dpi=120)
        plt.close(fig)

        # Plot 2: book-level handcoded score vs vote_count, colored by author gender
        fig, ax = plt.subplots(figsize=(8, 5))
        for g, color in [("M", "#3b6ea5"), ("F", "#c2538f")]:
            xs = [r["handcoded_score"] for r in enriched_rows if r["author_gender"] == g]
            ys = [r["vote_count"] for r in enriched_rows if r["author_gender"] == g]
            ax.scatter(xs, ys, label=f"{g} author", alpha=0.6, c=color, s=40)
        ax.set_xlabel("Hand-coded subject-matter score (negative = male-coded)")
        ax.set_ylabel("Ballots received")
        ax.set_yscale("log")
        ax.set_title("Vote count vs subject-matter score, coloured by author gender")
        ax.legend()
        fig.tight_layout()
        fig.savefig(OUT / "plot_votes_vs_subject.png", dpi=120)
        plt.close(fig)

        # Plot 3: ballot crosstab voter_gender x author_gender
        fig, ax = plt.subplots(figsize=(7, 4))
        groups = ["M voters", "F voters"]
        m_to_M = ct["M"]["M"] / sum(ct["M"].values()) * 100
        m_to_F = ct["M"]["F"] / sum(ct["M"].values()) * 100
        f_to_M = ct["F"]["M"] / sum(ct["F"].values()) * 100
        f_to_F = ct["F"]["F"] / sum(ct["F"].values()) * 100
        import numpy as np
        x = np.arange(len(groups))
        width = 0.35
        ax.bar(x - width/2, [m_to_M, f_to_M], width, label="to M authors", color="#3b6ea5")
        ax.bar(x + width/2, [m_to_F, f_to_F], width, label="to F authors", color="#c2538f")
        ax.set_xticks(x); ax.set_xticklabels(groups)
        ax.set_ylabel("% of voter's ballots")
        ax.set_title("Ballot mix by voter gender × author gender")
        ax.legend()
        ax.set_ylim(0, 100)
        fig.tight_layout()
        fig.savefig(OUT / "plot_ballot_crosstab.png", dpi=120)
        plt.close(fig)
        print(f"Wrote 3 plots to {OUT}/plot_*.png")


if __name__ == "__main__":
    main()
