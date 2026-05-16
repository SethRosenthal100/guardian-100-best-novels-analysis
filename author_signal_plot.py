"""
author_signal_plot.py — standalone chart for inspecting whether author
gender carries a signal beyond subject coding.

Two lines, one per voter gender. X-axis: subject band (5 buckets).
Y-axis: % of that group's ballots going to female-authored books.

Where the two lines meet → author gender is fully explained by subject.
Where they diverge → there's an independent "prefer F/M author" signal.

Output: out/author_signal.png (standalone, NOT embedded in the page)
"""
from __future__ import annotations

import collections
import json
from pathlib import Path

import matplotlib.pyplot as plt

import econ_style as es

es.setup_style()

ROOT = Path(__file__).resolve().parent
data = json.load(open(ROOT / "web" / "data_extended.json"))
voter_by_id = {v["id"]: v for v in data["voters"]}


def band(s):
    if s <= -2: return 0
    if s <= -0.5: return 1
    if s < 0.5: return 2
    if s < 2: return 3
    return 4


band_labels = [
    "very\nmale-coded",
    "male-coded",
    "neutral",
    "female-coded",
    "very\nfemale-coded",
]
band_x_data = [-2.5, -1.25, 0, 1.25, 2.5]  # representative subject scores

# Count F-author / total votes per (voter_gender, band)
counts = collections.defaultdict(lambda: [0, 0])
for b in data["books"]:
    if b["subject"] is None:
        continue
    bnd = band(b["subject"])
    is_F_author = b["author_gender"] == "F"
    for vid in b["voters"]:
        v = voter_by_id[vid]
        vg = v["gender"]
        if vg not in ("F", "M"):
            continue
        counts[(vg, bnd)][1] += 1
        if is_F_author:
            counts[(vg, bnd)][0] += 1


def pct(vg, bnd):
    nf, nt = counts[(vg, bnd)]
    return 100 * nf / nt if nt else 0


y_F = [pct("F", i) for i in range(5)]
y_M = [pct("M", i) for i in range(5)]
gaps = [yf - ym for yf, ym in zip(y_F, y_M)]
ns_F = [counts[("F", i)][1] for i in range(5)]
ns_M = [counts[("M", i)][1] for i in range(5)]

# ---------------------------------------------------------------------------
fig = plt.figure(figsize=(11.5, 7.5))
ax = fig.add_axes([0.10, 0.16, 0.83, 0.62])  # leave room for title at top

x = list(range(5))

# Shade the gap between the two lines so divergence is visible as area
ax.fill_between(x, y_F, y_M,
                where=[yf >= ym for yf, ym in zip(y_F, y_M)],
                facecolor=es.RED, alpha=0.10, interpolate=True)
ax.fill_between(x, y_F, y_M,
                where=[yf < ym for yf, ym in zip(y_F, y_M)],
                facecolor=es.BLUE, alpha=0.10, interpolate=True)

# Lines
ax.plot(x, y_F, color=es.RED, marker="o", linewidth=2.6, markersize=9,
        markeredgecolor="white", markeredgewidth=1.5, zorder=3)
ax.plot(x, y_M, color=es.BLUE, marker="o", linewidth=2.6, markersize=9,
        markeredgecolor="white", markeredgewidth=1.5, zorder=3)

# Inline endpoint labels (no legend)
ax.text(4.18, y_F[4], f"Female voters\n({y_F[4]:.0f}%)",
        ha="left", va="center", color=es.RED, fontsize=11.5, fontweight="bold")
ax.text(4.18, y_M[4], f"Male voters\n({y_M[4]:.0f}%)",
        ha="left", va="center", color=es.BLUE, fontsize=11.5, fontweight="bold")

# Annotate each band's percentages near the dots and the gap
for i in range(5):
    # F voter pct label
    ax.annotate(f"{y_F[i]:.0f}%", xy=(i, y_F[i]), xytext=(0, 14),
                textcoords="offset points", ha="center",
                color=es.RED, fontsize=10.5)
    # M voter pct label
    ax.annotate(f"{y_M[i]:.0f}%", xy=(i, y_M[i]), xytext=(0, -18),
                textcoords="offset points", ha="center",
                color=es.BLUE, fontsize=10.5)
    # Gap call-out where meaningful
    gap = gaps[i]
    if abs(gap) >= 5:
        mid_y = (y_F[i] + y_M[i]) / 2
        ax.annotate(f"{gap:+.0f}pp gap",
                    xy=(i, mid_y), ha="center", va="center",
                    fontsize=10.5, color="#2a2a2a",
                    fontstyle="italic",
                    bbox=dict(facecolor=es.BG, edgecolor="none", alpha=0.92, pad=3))

# Axis styling
ax.set_xticks(x)
ax.set_xticklabels(band_labels, fontsize=11.5, color=es.INK)
ax.set_yticks([0, 25, 50, 75, 100])
ax.set_yticklabels([f"{p}%" for p in [0, 25, 50, 75, 100]], fontsize=11)
ax.set_ylim(-8, 108)
ax.set_xlim(-0.4, 4.9)
ax.set_ylabel("% of voter's ballots going to female-authored books",
              fontsize=12, color=es.INK)

# x-axis hint
ax.text(2, -22, "subject-matter band of the book voted for",
        ha="center", va="top", fontsize=11, color="#3a3a3a",
        fontstyle="italic")

# n's under x-tick labels
for i in range(5):
    ax.text(i, -16,
            f"n={ns_F[i]+ns_M[i]} ballots",
            ha="center", va="top", fontsize=9, color="#666")

# Title & subtitle
es.add_signature(fig, x=0.10, y=0.95, width=0.022, height=0.010)
es.add_title(
    fig,
    "Same subject — different choice of author",
    "At a given subject-matter level, female voters pick female authors at a higher rate than male\n"
    "voters do. The gap is largest in the middle of the subject gradient.",
    x=0.10, top=0.91,
)
es.add_source(
    fig,
    "Source: Guardian, 'The 100 best novels of all time' (May 2026). "
    "All 694 books × 172 voters; 1,720 ballots. F+M voters only (NB excluded for the binary comparison).",
    x=0.10, y=0.04,
)

out = ROOT / "out" / "author_signal.png"
fig.savefig(out, dpi=200, facecolor=fig.get_facecolor(), bbox_inches="tight")
plt.close(fig)
print(f"Wrote {out}")
print()
print("Numbers behind the chart:")
print(f"{'band':<22}  {'F voters':<22}  {'M voters':<22}  gap")
for i, lbl in enumerate(band_labels):
    print(f"  {lbl.replace(chr(10),' '):<20}  "
          f"{counts[('F',i)][0]:>3}/{counts[('F',i)][1]:<4} = {y_F[i]:>4.0f}%      "
          f"{counts[('M',i)][0]:>3}/{counts[('M',i)][1]:<4} = {y_M[i]:>4.0f}%      "
          f"{gaps[i]:+.0f}pp")
