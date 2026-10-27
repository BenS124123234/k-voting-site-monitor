# Alaska voting site monitor

Checks the Alaska Division of Elections every hour and records every change to
Election Day polling places and early / absentee in-person voting sites.

Nothing here needs hands-on care. GitHub runs the check on its own schedule.

## What it watches

| Source | What | Where |
|---|---|---|
| Election Day polling places | 402 sites (as of Oct 27, 2026) | DOE's ArcGIS layer behind the precinct map |
| Early voting and absentee in-person sites | 194 sites (as of Oct 27, 2026) | The table on elections.alaska.gov/avo |

## Where the results are

- `data/changes.jsonl`: every change found, one per line, oldest first.
- `data/election_day.json` and `data/early_voting.json`: the current list.
- `data/status.json`: when the last check ran and whether both sources loaded.
- `data/raw/`: the latest raw responses from DOE, for auditing.

The commit history is a full timeline: each commit is one hourly check that
found something new to save.

## If something breaks

- A failed check shows up as a red X on the **Actions** tab, and GitHub emails
  the account owner. The last good data is kept, so nothing is lost.
- To run a check by hand: **Actions** tab, then **Hourly DOE check**, then
  **Run workflow**.

## Notes

- DOE's web server sends the wrong intermediate security certificate. Browsers
  fix this silently; scripts don't. The correct certificate is stored in
  `certs/` (verified against GlobalSign's published fingerprint), and full
  certificate checking stays on.
- If a pull suddenly returns far fewer sites than the last one, it is treated
  as a bad pull, not as mass removals.
- GitHub's scheduler can run a few minutes late during busy periods.
