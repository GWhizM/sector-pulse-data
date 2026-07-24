# Sector Pulse data updater

Public, credential-free updater for the Sector Pulse research dashboard.

The scheduled GitHub workflow:

- runs every five minutes during regular U.S. market hours;
- downloads public market data through `yfinance`;
- calculates Wilder RSI and estimated sector contribution;
- writes a single JSON snapshot to Cloudflare Workers KV; and
- retains the last successful snapshot when a data source fails.

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

## Run locally

```bash
python -m pip install -r requirements.txt
python sector_pulse_updater.py --output snapshot.json
python -m unittest discover -s tests -v
```

Market data may be delayed, revised, or unavailable. This project is for
research and educational use, not trade execution.
