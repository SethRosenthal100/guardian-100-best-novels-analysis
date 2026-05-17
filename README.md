# Guardian 100 best novels: gendered voting trends

Interactive analysis of voting patterns in The Guardian's *"100 best novels of all time"* feature (May 2026) — how 172 contributors' ballots split along gender lines, both in the **authors** they picked and in the **subjects** of the books they chose.

**Live site:** https://sethrosenthal100.github.io/guardian-100-best-novels-analysis/

## Repo layout

- `docs/` — the static interactive site (served by GitHub Pages)
- `data/` — hand- and agent-coded CSVs: voter gender, author gender, book subject, canonicity
- `raw/voters_full.json` — the parsed Guardian ballot extract (172 voters &times; 10 ranked picks)
- `build_extended_data.py` — joins all the CSVs into the single JSON blob the site loads
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
