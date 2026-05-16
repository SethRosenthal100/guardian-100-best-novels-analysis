"""
author_gender_plot.py — companion to signature.png.

The subject-matter story is nuanced (means agree, shapes differ, bimodality).
The author-gender story is sharper: men vote 70/30 for male authors, women
vote 50/50. This chart isolates that finding so the two stories don't muddy
each other.

Output: out/author_gender.png
"""
from __future__ import annotations

import csv
import unicodedata
from collections import defaultdict, Counter
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.gridspec import GridSpec

import econ_style as es
es.setup_style()

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = ROOT / "out"
OUT.mkdir(exist_ok=True)


def nfc(s): return unicodedata.normalize("NFC", s) if isinstance(s, str) else s

def load(path):
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


# -- data -------------------------------------------------------------------
votes = load(DATA / "votes.csv")
ag = {nfc(r["author"]): r["gender"] for r in load(DATA / "author_gender.csv")}
vg = {nfc(r["voter"]): r["gender"] for r in load(DATA / "voter_gender.csv")}

cross = defaultdict(Counter)
for v in votes:
    vg_ = vg.get(nfc(v["voter"]), "unknown")
    ag_ = ag.get(nfc(v["author"]), "unknown")
    cross[vg_][ag_] += 1


# -- style (Economist-inspired) --------------------------------------------
RED  = es.RED          # female series
BLUE = es.BLUE         # male series
INK  = es.INK
MID  = es.MID
PINK = RED             # back-compat alias

# this chart has no x/y axis lines or grid — turn them off for this file only
plt.rcParams.update({
    "axes.spines.bottom": False,
    "axes.grid": False,
})


# -- figure -----------------------------------------------------------------
fig = plt.figure(figsize=(11.5, 5.6))
gs = GridSpec(1, 1, left=0.10, right=0.93, top=0.74, bottom=0.18, figure=fig)
ax = fig.add_subplot(gs[0])

groups = ["Female voters", "Male voters"]   # plot F on top so M sits at "ground" visually
ns = [sum(cross["F"].values()), sum(cross["M"].values())]
m_share = [cross["F"]["M"] / ns[0], cross["M"]["M"] / ns[1]]
f_share = [cross["F"]["F"] / ns[0], cross["M"]["F"] / ns[1]]

y_positions = [1, 0]
bar_h = 0.55

# stacked horizontal bars
for y, mm, ff, n, group_name in zip(y_positions, m_share, f_share, ns, groups):
    ax.barh(y, mm, height=bar_h, color=BLUE, edgecolor="white", linewidth=0,
            zorder=2)
    ax.barh(y, ff, left=mm, height=bar_h, color=PINK, edgecolor="white",
            linewidth=0, zorder=2)
    # in-bar percentage labels
    ax.text(mm / 2, y, f"{mm*100:.1f}%",
            ha="center", va="center", color="white",
            fontsize=14, fontweight="medium")
    ax.text(mm + ff / 2, y, f"{ff*100:.1f}%",
            ha="center", va="center", color="white",
            fontsize=14, fontweight="medium")
    # group label outside bar, with ballot count
    ax.text(-0.012, y, f"{group_name}\n(n={n} ballots)",
            ha="right", va="center", color=INK, fontsize=11,
            linespacing=1.3)

# parity reference line at 50%
ax.axvline(0.5, ymin=0.05, ymax=0.95, color=MID, lw=0.8, ls="--", alpha=0.6,
           zorder=3)
ax.text(0.5, 1.65, "50/50 parity", ha="center", va="bottom",
        color=MID, fontsize=9, fontstyle="italic")

# small inline color key under the bars, using coloured swatches
swatch_y = -0.95
ax.add_patch(plt.Rectangle((0.03, swatch_y - 0.10), 0.025, 0.22,
                            facecolor=BLUE, edgecolor="none", clip_on=False))
ax.text(0.07, swatch_y, "to male authors",
        color=INK, fontsize=10.5, ha="left", va="center",
        fontstyle="italic")
ax.add_patch(plt.Rectangle((0.94, swatch_y - 0.10), 0.025, 0.22,
                            facecolor=PINK, edgecolor="none", clip_on=False))
ax.text(0.93, swatch_y, "to female authors",
        color=INK, fontsize=10.5, ha="right", va="center",
        fontstyle="italic")

# author-gender baseline annotation: 63 of 100 books are by men
ax.text(0.5, -1.55,
        "(For reference: the 100 books are 63% male-authored / 37% female-authored.\n"
        "Female voters track that mix closely; male voters skew further toward male authors.)",
        ha="center", va="top", color=MID, fontsize=9.5, fontstyle="italic",
        linespacing=1.4)

ax.set_xlim(-0.02, 1.02)
ax.set_ylim(-1.75, 1.85)
ax.set_xticks([])
ax.set_yticks([])

# title & subtitle (Economist-style)
es.add_signature(fig, x=0.10, y=0.94, width=0.022, height=0.012)
es.add_title(
    fig,
    "Who votes for whom: ballots cast by author gender",
    "Female voters split their ballots almost evenly between male and female authors.\n"
    "Male voters give 70% of theirs to male authors.",
    x=0.10, top=0.91,
)
es.add_source(
    fig,
    "Source: Guardian, 'The 100 best novels of all time' (May 2026). 962 ballots from 170 voters.",
    x=0.10, y=0.04,
)

out_path = OUT / "author_gender.png"
fig.savefig(out_path, dpi=200, facecolor=fig.get_facecolor())
plt.close(fig)
print(f"Wrote {out_path}")
