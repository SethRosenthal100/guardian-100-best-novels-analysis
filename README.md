# Guardian 100 best novels: Voting patterns, trends, and structure

Interactive analysis of voting patterns in The Guardian's *"100 best novels of all time"* feature (May 2026) — how 172 contributors' ballots form clusters of books, how the clusters reveal and contrast voting patterns, and how the votes reveal gender trends.

**Live site:** https://sethrosenthal100.github.io/guardian-100-best-novels-analysis/

## Repo layout

- `docs/` — the static interactive site (served by GitHub Pages)
- `data/` — coded CSVs: voter gender; author gender (top-100 authors and long-tail authors in separate files); subject and canonicity scores for the top 100; near-miss codings (books with 3+ voters that missed the top 100); long-tail subject codings (see methodology page for how the coding was done)
- `raw/voters_full.json` — the parsed Guardian ballot extract (172 voters &times; 10 ranked picks)
- `build_extended_data.py` — joins the CSVs and bakes cluster computation, layout, and rankings into the JSON blob the site loads
- `extract_full_ballots.py` — parser that produced `voters_full.json` from the Guardian page

## Reproducing the analysis

```bash
python3 build_extended_data.py              # regenerates docs/data_extended.json
cd docs && python3 -m http.server 8000      # serves the site locally
```

Modify any `data/*.csv`, rerun `build_extended_data.py`, refresh the browser.

## Methodology

See the [methodology page](https://sethrosenthal100.github.io/guardian-100-best-novels-analysis/methodology.html) for a frank discussion of how the codings were done, the assumptions made, and the limitations of this kind of work.

## Data source and attribution

All data is derived from The Guardian's published feature *"100 best novels of all time"* (May 2026). The raw Guardian source files are not redistributed in this repository. Short editorial passages referenced in the analysis are used under fair-dealing provisions for research and critical commentary.
