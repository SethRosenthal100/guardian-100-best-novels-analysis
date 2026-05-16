"""
signature_plot.py — the elegant headline chart.

Builds out/signature.png : one composed figure with a top density-marginal
and a central per-book scatter that together show
  (a) where male vs female voters' ballots land along the subject-matter gradient
  (b) the asymmetry: women drive every category; men cluster in a narrow band of
      male-modernist titles, leaving the female-coded quadrant nearly empty.

Run with:
    python3 signature_plot.py
"""
from __future__ import annotations

import csv
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patheffects as pe
from matplotlib import font_manager
from matplotlib.gridspec import GridSpec
from matplotlib.lines import Line2D

import econ_style as es
es.setup_style()

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = ROOT / "out"
OUT.mkdir(exist_ok=True)


def nfc(s):
    return unicodedata.normalize("NFC", s) if isinstance(s, str) else s


def load(path):
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------
books = {int(r["rank"]): r for r in load(DATA / "books.csv")}
votes = load(DATA / "votes.csv")
subj = {int(r["rank"]): r for r in load(DATA / "book_subject.csv")}
ag = {nfc(r["author"]): r["gender"] for r in load(DATA / "author_gender.csv")}
vg = {nfc(r["voter"]): r["gender"] for r in load(DATA / "voter_gender.csv")}

rank_voters = defaultdict(list)
for v in votes:
    rank_voters[int(v["rank"])].append(vg.get(nfc(v["voter"]), "unknown"))

# per-book record for the scatter
book_pts = []
for rank, b in sorted(books.items()):
    vs = rank_voters[rank]
    n = len(vs)
    pctF = 100.0 * vs.count("F") / n if n else 0.0
    book_pts.append({
        "rank": rank,
        "title": b["title"],
        "author": b["author"],
        "author_g": ag.get(nfc(b["author"]), "unknown"),
        "subj": float(subj[rank]["handcoded_score"]),
        "votes": n,
        "pctF": pctF,
    })

# per-ballot stream for the density marginal
ballots_by_g = {"M": [], "F": []}
for v in votes:
    g = vg.get(nfc(v["voter"]), "unknown")
    if g in ballots_by_g:
        ballots_by_g[g].append(float(subj[int(v["rank"])]["handcoded_score"]))

# pool baseline
pool_F = sum(1 for g in vg.values() if g == "F") / len(vg) * 100

# ---------------------------------------------------------------------------
# Style (Economist-inspired — shared with author_gender_plot.py via econ_style)
# ---------------------------------------------------------------------------
RED  = es.RED       # used for the FEMALE series (women / female authors)
BLUE = es.BLUE      # used for the MALE series
INK  = es.INK
MID  = es.MID
PINK = RED          # back-compat alias: rest of file still uses PINK
LIGHT_GRID = es.LIGHT_GRID


# ---------------------------------------------------------------------------
# Figure
# ---------------------------------------------------------------------------
fig = plt.figure(figsize=(11.5, 10.5))
gs = GridSpec(2, 1, height_ratios=[1, 3.6], hspace=0.0, figure=fig,
              left=0.10, right=0.93, top=0.84, bottom=0.10)
ax_top = fig.add_subplot(gs[0])
ax = fig.add_subplot(gs[1], sharex=ax_top)

# remove the seam between the two panels: hide the marginal's bottom spine and
# the scatter's top spine so they meet flush against each other.
ax_top.spines["bottom"].set_visible(False)
ax.spines["top"].set_visible(False)

# --- Top marginal: smoothed curves, truncated at the data range -------------
# Curves read more naturally than bars, but a KDE that extends past the data
# range invents phantom density. We compute the KDE only over [-3, +3] and
# clip the line ends so the curve never strays beyond actual ballots.
def kde(values, xs, bw=0.55):
    arr = np.asarray(values, dtype=float)
    return np.mean(
        np.exp(-0.5 * ((xs[:, None] - arr[None, :]) / bw) ** 2)
        / (bw * np.sqrt(2 * np.pi)),
        axis=1,
    )

xs = np.linspace(-3.0, 3.0, 241)
d_m = kde(ballots_by_g["M"], xs)
d_f = kde(ballots_by_g["F"], xs)

ax_top.plot(xs, d_m, color=BLUE, lw=2.4, solid_capstyle="round",
            label=f"Male voters' ballots (n={len(ballots_by_g['M'])})")
ax_top.plot(xs, d_f, color=PINK, lw=2.4, solid_capstyle="round",
            label=f"Female voters' ballots (n={len(ballots_by_g['F'])})")

# (no end caps — the truncated curve ends are self-evident at the axis bounds)

mean_m = np.mean(ballots_by_g["M"])
mean_f = np.mean(ballots_by_g["F"])

peak_density = max(d_m.max(), d_f.max())
ax_top.set_ylim(0, peak_density * 1.55)
ymax = ax_top.get_ylim()[1]

def density_at(x_val, values, bw=0.55):
    arr = np.asarray(values, dtype=float)
    return np.mean(np.exp(-0.5 * ((x_val - arr) / bw) ** 2)
                   / (bw * np.sqrt(2 * np.pi)))

# means as bold diamond markers on each curve (distinguishes them from
# the modal circles); their values labeled inline
mean_m_y = density_at(mean_m, ballots_by_g["M"])
mean_f_y = density_at(mean_f, ballots_by_g["F"])
ax_top.scatter([mean_m], [mean_m_y], s=55, color=BLUE, edgecolor="white",
               linewidth=1.0, marker="D", zorder=6)
ax_top.scatter([mean_f], [mean_f_y], s=55, color=PINK, edgecolor="white",
               linewidth=1.0, marker="D", zorder=6)
ax_top.annotate(f"male mean {mean_m:+.2f}",
                xy=(mean_m, mean_m_y),
                xytext=(mean_m - 0.20, mean_m_y - ymax * 0.18),
                color=BLUE, fontsize=10, fontstyle="italic",
                ha="right", va="center",
                arrowprops=dict(arrowstyle="-", color=BLUE, lw=0.6,
                                alpha=0.65, shrinkA=2, shrinkB=4))
ax_top.annotate(f"female mean {mean_f:+.2f}",
                xy=(mean_f, mean_f_y),
                xytext=(mean_f + 0.20, mean_f_y - ymax * 0.18),
                color=PINK, fontsize=10, fontstyle="italic",
                ha="left", va="center",
                arrowprops=dict(arrowstyle="-", color=PINK, lw=0.6,
                                alpha=0.65, shrinkA=2, shrinkB=4))

# Modal annotations: find local maxima of the smoothed KDE curves rather
# than discrete bin counts, so the modes track the visual peaks of each curve.
def local_maxima(ys, xs, min_height_frac=0.4):
    """Return x-positions of local maxima above a fractional-height threshold."""
    out = []
    cutoff = ys.max() * min_height_frac
    for i in range(1, len(ys) - 1):
        if ys[i] > ys[i - 1] and ys[i] > ys[i + 1] and ys[i] > cutoff:
            out.append(xs[i])
    return out

# share-of-ballots at a given x bin for label purposes
def share_within(x_val, values, halfwidth=0.5):
    arr = np.asarray(values, dtype=float)
    n = np.sum(np.abs(arr - x_val) <= halfwidth)
    return n / len(arr)

male_peaks = local_maxima(d_m, xs)
female_peaks = local_maxima(d_f, xs)
mode_m = male_peaks[0] if male_peaks else xs[int(np.argmax(d_m))]
modes_f = female_peaks if len(female_peaks) >= 1 else [xs[int(np.argmax(d_f))]]

MODE_LABEL_FONTSIZE = 10.5

# male mode marker + callout
m_y = density_at(mode_m, ballots_by_g["M"])
male_share = share_within(mode_m, ballots_by_g["M"])
ax_top.scatter([mode_m], [m_y], s=55, color=BLUE, edgecolor="white",
               linewidth=1.0, zorder=5)
ax_top.annotate(
    f"single male peak\n({male_share*100:.0f}% of male ballots cluster here)",
    xy=(mode_m, m_y),
    xytext=(-2.95, ymax * 0.95),
    color=BLUE, fontsize=MODE_LABEL_FONTSIZE, ha="left", va="top",
    fontstyle="italic", linespacing=1.3,
    arrowprops=dict(arrowstyle="-", color=BLUE, lw=0.7, alpha=0.65,
                    shrinkA=2, shrinkB=4),
)

# female peak markers
for fm in modes_f:
    ax_top.scatter([fm], [density_at(fm, ballots_by_g["F"])],
                   s=55, color=PINK, edgecolor="white",
                   linewidth=1.0, zorder=5)

# female bimodality callout. If two clear peaks exist, draw arrows to both;
# otherwise just label the single mode.
if len(modes_f) >= 2:
    # take the leftmost and rightmost peaks (most distinct)
    lo = min(modes_f)
    hi = max(modes_f)
    f_lo_y = density_at(lo, ballots_by_g["F"])
    f_hi_y = density_at(hi, ballots_by_g["F"])
    lo_share = share_within(lo, ballots_by_g["F"])
    hi_share = share_within(hi, ballots_by_g["F"])
    label_text = (
        f"two near-equal female peaks\n"
        f"({lo_share*100:.0f}% and {hi_share*100:.0f}% of female ballots)"
    )
    text_right_x = 2.95
    text_top_y = ymax * 0.95
    txt = ax_top.text(text_right_x, text_top_y, label_text,
                      color=PINK, fontsize=MODE_LABEL_FONTSIZE,
                      ha="right", va="top", fontstyle="italic",
                      linespacing=1.3, zorder=4)
    fig.canvas.draw()
    bb = txt.get_window_extent().transformed(ax_top.transData.inverted())
    # connector from bottom-right of text to the right (hi) peak
    ax_top.plot([bb.x1 - 0.04, hi],
                [bb.y0 - ymax * 0.005, f_hi_y],
                color=PINK, lw=0.7, alpha=0.65, zorder=1,
                solid_capstyle="round")
    # connector from bottom-left of text to the left (lo) peak
    ax_top.plot([bb.x0 + 0.04, lo],
                [bb.y0 - ymax * 0.005, f_lo_y],
                color=PINK, lw=0.7, alpha=0.65, zorder=1,
                solid_capstyle="round")

ax_top.set_yticks([])
ax_top.spines["left"].set_visible(False)
ax_top.tick_params(axis="x", labelbottom=False, bottom=False)
ax_top.set_xlim(-3.3, 3.3)

# --- Central scatter: per-book ---------------------------------------------
# Horizontal jitter so dots at the same integer subject score don't stack.
# At the extreme scores we bias jitter inward so no dot drifts past -3 or +3.
rng = np.random.default_rng(7)
JITTER = 0.14
rank_to_xy = {}

def votes_to_size(v):
    return 12 + 5.0 * v   # tuned so 3-vote books are visible and Middlemarch dominates

for p in book_pts:
    s = p["subj"]
    if s <= -3:
        jx = rng.uniform(0, JITTER)        # only push right
    elif s >= 3:
        jx = rng.uniform(-JITTER, 0)       # only push left
    else:
        jx = rng.uniform(-JITTER, JITTER)
    color = PINK if p["author_g"] == "F" else BLUE if p["author_g"] == "M" else "#aaa"
    x = s + jx
    ax.scatter(x, p["pctF"], s=votes_to_size(p["votes"]), color=color,
               edgecolor="white", linewidth=0.8, alpha=0.85, zorder=3)
    rank_to_xy[p["rank"]] = (x, p["pctF"])

# voter-pool baseline
ax.axhline(pool_F, color=MID, lw=0.9, ls="--", alpha=0.6, zorder=1)
ax.text(-3.5, pool_F + 1.0,
        f"voter pool baseline = {pool_F:.0f}% female",
        ha="left", va="bottom", color=MID, fontsize=9, fontstyle="italic")

# vertical zero line on subject axis
ax.axvline(0, color=MID, lw=0.6, alpha=0.3, zorder=1)

# annotate signature books. (dx, dy, ha) in data-coordinates.
HIGHLIGHT = [
    (34, "Wolf Hall",             (0.30, -5.0),  "left"),
    (97, "Catch-22",              (0.30, -7.0),  "left"),
    (36, "The Handmaid's Tale",   (-0.25, -5.0), "right"),
    (56, "Mansfield Park",        (0.25, 6.0),   "left"),
    (27, "The Trial",             (-0.30, 0),    "right"),
    ( 3, "Ulysses",               (-0.30, 0),    "right"),
    (28, "Brothers Karamazov",    (-0.30, -3.0), "right"),
    (15, "Moby-Dick",             (-0.30, 0),    "right"),
    ( 8, "Jane Eyre",             (-0.30, 2.5),  "right"),
    ( 2, "Beloved",               (-0.30, -3.0), "right"),
    ( 1, "Middlemarch",           (0.30, 0),     "left"),
    (68, "Blood Meridian",        (0.30, -2.0),  "left"),
    ( 6, "Anna Karenina",         (0.30, 3.0),   "left"),
]
for rank, label, (dx, dy), ha in HIGHLIGHT:
    p = next(b for b in book_pts if b["rank"] == rank)
    color = PINK if p["author_g"] == "F" else BLUE
    x_dot, y_dot = rank_to_xy[rank]
    ax.annotate(label,
                xy=(x_dot, y_dot),
                xytext=(x_dot + dx, y_dot + dy),
                color=INK, fontsize=9.5, fontstyle="italic",
                ha=ha, va="center",
                arrowprops=dict(arrowstyle="-", color=color, lw=0.6, alpha=0.55,
                                shrinkA=2, shrinkB=4))

# shade the conspicuously empty region: female-coded books, male-majority voters
ax.add_patch(plt.Rectangle((0.5, -3), 3.2, pool_F + 3,
                            facecolor=MID, alpha=0.045, zorder=0, lw=0))
ax.text(2.0, 16,
        "Hardly any books occupy this region:\nfemale-coded subjects with majority-male voters.\n"
        "Mansfield Park is the only exception.",
        ha="center", va="bottom", fontsize=9.5, color="#555", fontstyle="italic",
        linespacing=1.3)

# axes
ax.set_xlabel("")  # custom verbal labels below in place of numeric axis
ax.set_ylabel("% of book's voters who are women", fontsize=11, color="#333", labelpad=10)
ax.set_xlim(-3.3, 3.3)
ax.set_ylim(-2, 105)
ax.set_xticks(range(-3, 4))
ax.set_xticklabels([""] * 7)            # hide numeric tick labels
ax.tick_params(axis="x", length=3, color="#888")
ax.set_yticks(range(0, 101, 25))
ax.set_yticklabels([f"{y}%" for y in range(0, 101, 25)])

# verbal axis labels under the tick row (x in data coords, y in axes coords)
trans = ax.get_xaxis_transform()
ax.text(-3, -0.04, "male-coded",
        transform=trans, ha="center", va="top",
        fontsize=11, color=INK, weight="medium")
ax.text(0, -0.04, "neutral",
        transform=trans, ha="center", va="top",
        fontsize=11, color=INK, weight="medium")
ax.text(3, -0.04, "female-coded",
        transform=trans, ha="center", va="top",
        fontsize=11, color=INK, weight="medium")
# small parenthetical
ax.text(0, -0.085, "(hand-coded score, range −3 to +3)",
        transform=trans, ha="center", va="top",
        fontsize=9.5, color=MID, fontstyle="italic")

# legend (author gender)
legend_handles = [
    Line2D([0], [0], marker="o", color="none", markerfacecolor=PINK,
           markeredgecolor="white", markersize=9, label="Female author"),
    Line2D([0], [0], marker="o", color="none", markerfacecolor=BLUE,
           markeredgecolor="white", markersize=9, label="Male author"),
]
ax.legend(handles=legend_handles, loc="lower left", frameon=False, fontsize=10,
          handletextpad=0.5)

# size legend (dot area ∝ number of voters who selected the book) — placed in the
# upper-empty space to the right of the colour legend
ax_size = fig.add_axes([0.30, 0.115, 0.22, 0.07])
ax_size.set_facecolor(fig.get_facecolor())
for spine in ax_size.spines.values():
    spine.set_visible(False)
ax_size.set_xticks([]); ax_size.set_yticks([])
sample_votes = [3, 10, 30, 56]
sample_x = [0.10, 0.32, 0.58, 0.92]
for vx, vv in zip(sample_x, sample_votes):
    ax_size.scatter(vx, 0.60, s=votes_to_size(vv), color="#888",
                    edgecolor="white", linewidth=0.8, alpha=0.85)
    ax_size.text(vx, 0.05, f"{vv}", ha="center", va="top", fontsize=8.5, color=MID)
ax_size.text(0.5, 1.10, "dot size = ballots received",
             ha="center", va="bottom", fontsize=9, color=MID, fontstyle="italic",
             transform=ax_size.transAxes)
ax_size.set_xlim(-0.05, 1.05); ax_size.set_ylim(-0.1, 1.0)

# --- titles & framing (Economist-style) ------------------------------------
es.add_signature(fig, x=0.10, y=0.965, width=0.022, height=0.010)
es.add_title(
    fig,
    "Who votes for whom on the Guardian's 100 best novels",
    "Female voters cast ballots across the whole subject gradient;\n"
    "male voters cluster in a narrow band of male-coded modernist titles.",
    x=0.10, top=0.93,
)
es.add_source(
    fig,
    "Source: Guardian, 'The 100 best novels of all time' (May 2026). "
    "962 ballots from 170 voters. Subject score: analyst's hand-coded -3..+3 holistic measure.",
)

out_path = OUT / "signature.png"
fig.savefig(out_path, dpi=200, facecolor=fig.get_facecolor())
plt.close(fig)
print(f"Wrote {out_path}")
