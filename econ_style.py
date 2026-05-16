"""
econ_style.py — shared Economist-inspired styling for the project's charts.

Imported by signature_plot.py and author_gender_plot.py.

Public colour names:
    RED, BLUE, INK, MID, LIGHT_GRID, BG
Public helpers:
    setup_style()    # call once at module top, sets rcParams
    add_signature(fig)  # adds the red "Economist bar" at top-left
    add_title(fig, title, subtitle)  # left-aligned title + subtitle
    add_source(fig, source)  # source line in bottom-left
"""
from __future__ import annotations

import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import Rectangle


# Editorial palette. The signature bar at top-left stays Economist-red, but
# the two data series use a non-gendered pair. Variable names "RED" / "BLUE"
# are retained for code stability, but the actual values are:
#   RED  = terracotta (warm) — FEMALE series
#   BLUE = teal (cool)       — MALE series
SIGNATURE  = "#E3120B"
RED        = "#B85A3A"   # FEMALE series — terracotta
BLUE       = "#2A6F7C"   # MALE series   — teal
INK        = "#121212"
MID        = "#5A5A5A"
LIGHT_GRID = "#D7D7D5"
BG         = "#F2F2EE"


def _first_available(candidates):
    for name in candidates:
        try:
            font_manager.findfont(name, fallback_to_default=False)
            return name
        except Exception:
            pass
    return None


def setup_style():
    sans = _first_available([
        "Helvetica Neue", "Helvetica", "Arial",
        "Liberation Sans", "DejaVu Sans",
    ])
    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": [sans] if sans else plt.rcParams["font.sans-serif"],
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.spines.left": False,
        "axes.spines.bottom": True,
        "axes.edgecolor": MID,
        "axes.labelcolor": INK,
        "xtick.color": MID,
        "ytick.color": MID,
        "axes.titlesize": 13,
        "axes.labelsize": 11,
        "xtick.labelsize": 10,
        "ytick.labelsize": 10,
        "figure.facecolor": BG,
        "axes.facecolor": BG,
        "axes.axisbelow": True,
        "axes.grid": True,
        "axes.grid.axis": "y",
        "grid.color": LIGHT_GRID,
        "grid.linewidth": 0.7,
        "grid.linestyle": "-",
        "xtick.direction": "out",
        "ytick.direction": "out",
        "xtick.major.size": 3,
        "xtick.major.pad": 4,
        "ytick.major.size": 0,
    })


def add_signature(fig, x=0.10, y=0.965, width=0.022, height=0.008):
    """Draw the small red rectangle in the top-left, the Economist's signature."""
    fig.add_artist(Rectangle((x, y), width, height,
                             facecolor=SIGNATURE, edgecolor="none",
                             transform=fig.transFigure))


def add_title(fig, title, subtitle, x=0.10, top=0.945):
    """Left-aligned headline + dek, sitting just below add_signature."""
    fig.text(x, top, title,
             fontsize=18, weight="bold", color=INK, ha="left", va="top")
    fig.text(x, top - 0.038, subtitle,
             fontsize=11.5, color=MID, ha="left", va="top",
             linespacing=1.3)


def add_source(fig, source, x=0.10, y=0.025):
    fig.text(x, y, source,
             fontsize=8.5, color=MID, ha="left", style="italic")
