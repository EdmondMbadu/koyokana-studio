# Koyokana script

- `koyokana-script-v1.csv` — 1,004 sentences (~65 min of reading), columns `text,category`.
  Import it on the Script page (Import sentences → Choose file). Re-importing skips sentences already in the script.
- `tools/` — the generator. `cd script/tools && python3 build.py` rebuilds the CSV and prints any rule violations.

Spelling rules: see the "Koyokana Script — Spelling Rules" doc. The importer enforces them (src/app/core/spelling.ts).
