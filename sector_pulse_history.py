"""Build the five-year daily history bundle consumed by Sector Pulse."""

from __future__ import annotations

import argparse
import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

from sector_pulse_updater import BENCHMARKS, FALLBACK_WEIGHTS, SECTORS, finite, series_from_download


EXTRA_SYMBOLS = {
    "KIE": {"displayTicker": "KIE", "name": "SPDR S&P Insurance ETF"},
    "KCE": {"displayTicker": "KCE", "name": "SPDR S&P Capital Markets ETF"},
    "RSPH": {"displayTicker": "RSPH", "name": "Invesco S&P 500 Equal Weight Health Care ETF"},
    "RSPU": {"displayTicker": "RSPU", "name": "Invesco S&P 500 Equal Weight Utilities ETF"},
    "IGF": {"displayTicker": "IGF", "name": "iShares Global Infrastructure ETF"},
    "PHO": {"displayTicker": "PHO", "name": "Invesco Water Resources ETF"},
    "IXC": {"displayTicker": "IXC", "name": "iShares Global Energy ETF"},
    "STIP": {"displayTicker": "STIP", "name": "iShares 0-5 Year TIPS Bond ETF"},
    "RAAX": {"displayTicker": "RAAX", "name": "VanEck Inflation Allocation ETF"},
    "BRK-B": {"displayTicker": "BRK/B", "name": "Berkshire Hathaway Inc. Class B"},
}

BENCHMARK_NAMES = {
    "SPY": "S&P 500 ETF",
    "RSP": "S&P 500 Equal Weight ETF",
    "COWZ": "Pacer US Cash Cows 100 ETF",
    "QQQ": "Nasdaq-100 ETF",
    "^IXIC": "Nasdaq Composite",
}

HISTORY_SYMBOLS = {
    **{ticker: {"displayTicker": ticker, "name": name} for ticker, name in SECTORS.items()},
    **{
        ticker: {"displayTicker": ticker, "name": BENCHMARK_NAMES[ticker]}
        for ticker in BENCHMARKS
    },
    **EXTRA_SYMBOLS,
}
RANGE_DAYS = {"1m": 31, "3m": 93, "6m": 186, "1y": 366, "3y": 1096, "5y": 1827}
PERIOD_BENCHMARKS = ["SPY", "RSP", "COWZ", "QQQ"]


def build_history(frame: pd.DataFrame, generated_at: datetime | None = None) -> dict:
    generated_at = generated_at or datetime.now(timezone.utc)
    symbols: dict[str, dict] = {}
    failures: list[str] = []
    for ticker, metadata in HISTORY_SYMBOLS.items():
        closes = series_from_download(frame, ticker, "Close")
        adjusted = series_from_download(frame, ticker, "Adj Close")
        if adjusted.empty:
            adjusted = closes
        if closes.empty or adjusted.empty:
            failures.append(ticker)
            continue
        close_by_date = {
            pd.Timestamp(stamp).date().isoformat(): float(value)
            for stamp, value in closes.items()
            if math.isfinite(float(value))
        }
        points = []
        previous = None
        for stamp, value in adjusted.items():
            adjusted_close = float(value)
            if not math.isfinite(adjusted_close):
                continue
            market_date = pd.Timestamp(stamp).date().isoformat()
            close = close_by_date.get(market_date, adjusted_close)
            change = ((adjusted_close / previous) - 1) * 100 if previous else None
            points.append(
                {
                    "date": market_date,
                    "close": finite(close, 4),
                    "adjustedClose": finite(adjusted_close, 4),
                    "changePct": finite(change, 4),
                }
            )
            previous = adjusted_close
        if len(points) < 2:
            failures.append(ticker)
            continue
        symbols[ticker] = {**metadata, "points": points}
    if failures:
        raise RuntimeError(f"No usable daily history was returned for: {', '.join(failures)}")
    return {
        "schemaVersion": 1,
        "generatedAt": generated_at.isoformat(),
        "period": "5y",
        "symbols": symbols,
        "source": "Yahoo Finance via yfinance; adjusted closes used for cumulative performance",
    }


def build_history_snapshot() -> dict:
    frame = yf.download(
        tickers=list(HISTORY_SYMBOLS),
        period="5y",
        interval="1d",
        group_by="ticker",
        auto_adjust=False,
        progress=False,
        threads=True,
        timeout=45,
    )
    if frame.empty:
        raise RuntimeError("The market-data provider returned no daily history")
    return build_history(frame)


def build_period_snapshot(history: dict, range_name: str, custom_start: str | None = None) -> dict:
    required = [*SECTORS, *PERIOD_BENCHMARKS]
    rows = {ticker: history["symbols"][ticker]["points"] for ticker in required}
    common_dates = set.intersection(*(set(item["date"] for item in rows[ticker]) for ticker in required))
    latest_date = date.fromisoformat(max(common_dates))
    cutoff = (
        date.fromisoformat(custom_start)
        if range_name == "custom" and custom_start
        else date(latest_date.year, 1, 1)
        if range_name == "ytd"
        else latest_date - timedelta(days=RANGE_DAYS[range_name])
    )
    dates = sorted(value for value in common_dates if date.fromisoformat(value) >= cutoff)
    if len(dates) < 2:
        raise RuntimeError(f"Not enough shared market dates are available for {range_name}")
    adjusted = {
        ticker: {item["date"]: item["adjustedClose"] for item in rows[ticker]}
        for ticker in required
    }
    closes = {
        ticker: {item["date"]: item["close"] for item in rows[ticker]}
        for ticker in required
    }
    growth = {ticker: adjusted[ticker][dates[-1]] / adjusted[ticker][dates[0]] for ticker in SECTORS}
    raw_start_weights = {ticker: FALLBACK_WEIGHTS[ticker] / growth[ticker] for ticker in SECTORS}
    raw_total = sum(raw_start_weights.values())
    holdings = {ticker: value / raw_total for ticker, value in raw_start_weights.items()}
    impacts = {ticker: 0.0 for ticker in SECTORS}
    for previous_date, current_date in zip(dates, dates[1:]):
        for ticker in SECTORS:
            daily_return = adjusted[ticker][current_date] / adjusted[ticker][previous_date] - 1
            impacts[ticker] += holdings[ticker] * daily_return * 100
            holdings[ticker] *= 1 + daily_return
    spy_return = (adjusted["SPY"][dates[-1]] / adjusted["SPY"][dates[0]] - 1) * 100
    residual = spy_return - sum(impacts.values())
    impact_total = sum(abs(value) for value in impacts.values())
    sectors = []
    for ticker, name in SECTORS.items():
        share = abs(impacts[ticker]) / impact_total if impact_total else FALLBACK_WEIGHTS[ticker]
        sectors.append(
            {
                "ticker": ticker,
                "name": name,
                "weightPct": finite(FALLBACK_WEIGHTS[ticker] * 100, 2),
                "changePct": finite((growth[ticker] - 1) * 100, 2),
                "contributionPct": finite(impacts[ticker] + residual * share, 3),
            }
        )
    rounding_residual = finite(spy_return, 3) - sum(item["contributionPct"] for item in sectors)
    if rounding_residual:
        anchor = max(sectors, key=lambda item: abs(item["contributionPct"]))
        anchor["contributionPct"] = finite(anchor["contributionPct"] + rounding_residual, 3)
    benchmarks = [
        {
            "ticker": ticker,
            "changePct": finite((adjusted[ticker][dates[-1]] / adjusted[ticker][dates[0]] - 1) * 100, 3),
            "price": finite(closes[ticker][dates[-1]], 2),
        }
        for ticker in PERIOD_BENCHMARKS
    ]
    return {
        "range": range_name,
        "startDate": dates[0],
        "endDate": dates[-1],
        "spyChangePct": finite(spy_return, 3),
        "sectors": sectors,
        "estimated": True,
        "benchmarks": benchmarks,
        "methodology": "Est. S&P Index Impact links daily sector ETF effects using return-drifted sector weights, then reconciles the tracking difference to S&P / SPY performance.",
        "generatedAt": history["generatedAt"],
    }


def build_custom_period_groups(history: dict) -> dict[str, dict[str, dict]]:
    required = [*SECTORS, *PERIOD_BENCHMARKS]
    common_dates = sorted(
        set.intersection(
            *(
                set(item["date"] for item in history["symbols"][ticker]["points"])
                for ticker in required
            )
        )
    )
    groups: dict[str, dict[str, dict]] = {}
    for start_date in common_dates[:-1]:
        groups.setdefault(start_date[:4], {})[start_date] = build_period_snapshot(
            history,
            "custom",
            start_date,
        )
    return groups


def build_bulk_payload(history: dict) -> list[dict[str, str]]:
    payload = [
        {
            "key": "history:meta",
            "value": json.dumps(
                {
                    "schemaVersion": history["schemaVersion"],
                    "generatedAt": history["generatedAt"],
                    "period": history["period"],
                    "source": history["source"],
                },
                separators=(",", ":"),
            ),
        }
    ]
    for ticker, series in history["symbols"].items():
        payload.append(
            {
                "key": f"history:{ticker}",
                "value": json.dumps(
                    {
                        **series,
                        "generatedAt": history["generatedAt"],
                        "source": history["source"],
                    },
                    separators=(",", ":"),
                    allow_nan=False,
                ),
            }
        )
    periods = {
        range_name: build_period_snapshot(history, range_name)
        for range_name in [*RANGE_DAYS, "ytd"]
    }
    payload.append(
        {
            "key": "history:periods",
            "value": json.dumps(periods, separators=(",", ":"), allow_nan=False),
        }
    )
    for year, snapshots in build_custom_period_groups(history).items():
        payload.append(
            {
                "key": f"history:custom-periods:{year}",
                "value": json.dumps(snapshots, separators=(",", ":"), allow_nan=False),
            }
        )
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="history.json")
    parser.add_argument("--bulk-output", default="history-bulk.json")
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    history = build_history_snapshot()
    output.write_text(json.dumps(history, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    bulk_output = Path(args.bulk_output)
    bulk_output.parent.mkdir(parents=True, exist_ok=True)
    bulk_output.write_text(json.dumps(build_bulk_payload(history), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"Wrote {output} and {bulk_output} with {len(history['symbols'])} symbols at {history['generatedAt']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
