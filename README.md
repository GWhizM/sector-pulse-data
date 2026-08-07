# Sector Pulse data updater

Public, credential-free updater for the Sector Pulse research dashboard.

The Cloudflare Worker Cron Trigger dispatches the GitHub workflow. A second,
native GitHub schedule runs as a no-cost fallback if Cloudflare misses a cycle:

- runs every five minutes during regular U.S. market hours;
- downloads daily market data through `yfinance` and current prices through
  Yahoo's direct chart responses;
- retries stale provider responses up to three times per scheduled cycle;
- allows delayed GitHub-hosted jobs to finish instead of cancelling them when
  the next five-minute trigger arrives;
- coalesces overlapping Cloudflare and GitHub triggers without interrupting an
  update that is already running;
- calculates Wilder RSI and estimated sector contribution;
- writes a single JSON snapshot to Cloudflare Workers KV; and
- retains the last successful snapshot when a data source fails or returns data
  older than the snapshot already published.

A second workflow is dispatched once after each market close and publishes five years of
daily history for the sector ETFs, benchmarks, and the curated history-only
watchlist. It writes one additional KV key named `history-latest`.

The updater contains no Cloudflare token, personal watchlist, browser settings,
database, or private Sector Pulse interface. Cloudflare credentials are supplied
only through encrypted GitHub Actions secrets.

## Repository settings

Create these GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_KV_NAMESPACE_ID`

The Cloudflare token needs only `Workers KV Storage: Write` for the selected
account. The workflow writes one KV key named `snapshot-latest`.

After the first manual run succeeds, create the repository Actions variable
`UPDATER_ENABLED` with the value `true`. Scheduled runs remain safely skipped
until that variable is present.

## Reliable scheduler

Add a fine-grained GitHub personal access token to the Worker as an encrypted
secret named `GITHUB_ACTIONS_TOKEN`. Restrict the token to this repository and
grant only `Actions: Read and write`. Then add one Cloudflare Cron Trigger:

```text
*/5 * * * 1-5
```

Cloudflare evaluates the cron expression in UTC. The Worker converts each event
to America/New_York time, dispatches the market workflow every five minutes from
9:30 a.m. through 4:00 p.m. on weekdays, and dispatches daily history at
4:15 p.m. Other trigger events return without contacting GitHub.

## Run locally

```bash
python -m pip install -r requirements.txt
python sector_pulse_updater.py --output snapshot.json
python -m unittest discover -s tests -v
```

Market data may be delayed, revised, or unavailable. This project is for
research and educational use, not trade execution.
