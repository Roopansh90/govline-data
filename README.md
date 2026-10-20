# govline-data

Live data for the **GovLine – Global Helpline Directory** Chrome extension.

- `helplines.json`: the data the extension reads
- `scripts/update.mjs`: checks Microsoft's official emergency-numbers page
- `.github/workflows/update.yml`: runs the check every day for free and commits changes

New official numbers are added automatically. Numbers that vanish from the official page are **never** deleted automatically. They are listed under "Review by hand" in each run's summary (Actions tab → latest run).
