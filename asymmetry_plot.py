"""
asymmetry_plot.py — the headline gender-asymmetry stat in one image.

Just two numbers: how often men pick women authors vs how often women
pick men authors. Across all 1,720 ballots in the dataset.

Output: out/asymmetry.png
"""
from __future__ import annotations
import json
from pathlib import Path
import matplotlib.pyplot as plt

import econ_style as es
es.setup_style()

ROOT = Path(__file__).resolve().parent
d = json.load(open(ROOT / "web" / "data_extended.json"))
vbyid = {v["id"]: v for v in d["voters"]}

counts = {"F": {"F": 0, "M": 0}, "M": {"F": 0, "M": 0}}
for b in d["books"]:
    ag = b["author_gender"]
    if ag not in ("F", "M"):
        continue
    for vid in b["voters"]:
        vg = vbyid[vid]["gender"]
        if vg in ("F", "M"):
            counts[vg][ag] += 1

# % of male voters that went to F authors
m_to_f = 100 * counts["M"]["F"] / (counts["M"]["F"] + counts["M"]["M"])
f_to_m = 100 * counts["F"]["M"] / (counts["F"]["F"] + counts["F"]["M"])
m_to_f_count = counts["M"]["F"]
m_total = counts["M"]["F"] + counts["M"]["M"]
f_to_m_count = counts["F"]["M"]
f_total = counts["F"]["F"] + counts["F"]["M"]

# ---------------------------------------------------------------------------
fig = plt.figure(figsize=(11, 6))

# Top-left signature bar + headline
es.add_signature(fig, x=0.07, y=0.93, width=0.020, height=0.011)
es.add_title(
    fig,
    "Women cross the author-gender line nearly twice as often as men",
    "Of ballots cast for F- or M-authored books, % going to the opposite gender's authors.",
    x=0.07, top=0.88,
)

# Two big stats, side by side
ax = fig.add_axes([0.07, 0.20, 0.86, 0.50])
ax.set_xlim(0, 100); ax.set_ylim(0, 100)
ax.axis("off")

# Left half — men picking women
left_x = 25
ax.text(left_x, 78, f"{m_to_f:.0f}%",
        ha="center", va="center", fontsize=98, color=es.BLUE,
        fontweight="bold", family="sans-serif")
ax.text(left_x, 38,
        "of male voters'\nballots go to\nfemale authors",
        ha="center", va="center", fontsize=15, color=es.INK,
        linespacing=1.35)
ax.text(left_x, 14, f"({m_to_f_count} of {m_total} ballots)",
        ha="center", va="center", fontsize=11, color="#666",
        fontstyle="italic")

# Right half — women picking men
right_x = 75
ax.text(right_x, 78, f"{f_to_m:.0f}%",
        ha="center", va="center", fontsize=98, color=es.RED,
        fontweight="bold")
ax.text(right_x, 38,
        "of female voters'\nballots go to\nmale authors",
        ha="center", va="center", fontsize=15, color=es.INK,
        linespacing=1.35)
ax.text(right_x, 14, f"({f_to_m_count} of {f_total} ballots)",
        ha="center", va="center", fontsize=11, color="#666",
        fontstyle="italic")

# Vertical separator line
ax.plot([50, 50], [12, 95], color=es.LIGHT_GRID, linewidth=1)

es.add_source(
    fig,
    "Source: Guardian, 'The 100 best novels of all time' (May 2026). "
    "1,687 ballots cast for books with F or M authors (NB/unknown authors excluded).",
    x=0.07, y=0.05,
)

out = ROOT / "out" / "asymmetry.png"
fig.savefig(out, dpi=200, facecolor=fig.get_facecolor(), bbox_inches="tight")
plt.close(fig)
print(f"Wrote {out}")
print(f"  Male voters → female authors: {m_to_f:.1f}% ({m_to_f_count}/{m_total})")
print(f"  Female voters → male authors: {f_to_m:.1f}% ({f_to_m_count}/{f_total})")
