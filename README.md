# Guardian 100 best novels: gendered voting trends

Interactive analysis of voting patterns in The Guardian's *"100 best novels of all time"* feature (May 2026) — how 172 contributors' ballots split along gender lines, both in the **authors** they picked and in the **subjects** of the books they chose.

**Live site:** https://sethrosenthal100.github.io/guardian-100-best-novels-analysis/

## Repo layout

- `docs/` — the static interactive site (served by GitHub Pages)
- `data/` — hand- and agent-coded CSVs: voter gender, author gender, book subject, canonicity
- `out/` — generated static charts and analysis outputs
- `analyze.py` — statistical analysis report (top-100 only)
- `build_extended_data.py` — joins all the CSVs into the single JSON blob the site loads
- `extract_full_ballots.py` — parser that extracted ballot data from the Guardian's page
- `signature_plot.py`, `author_gender_plot.py`, etc. — standalone static chart scripts

## Methodology

See the [methodology page](https://sethrosenthal100.github.io/guardian-100-best-novels-analysis/methodology.html) for a frank discussion of how the codings were done, the assumptions made, and the limitations of this kind of work.

## Data source and attribution

All data is derived from The Guardian's published feature *"100 best novels of all time"* (May 2026). The raw Guardian source files are not redistributed in this repository. Short editorial passages referenced in the analysis are used under fair-dealing provisions for research and critical commentary.
