"""Build the small public market snapshot consumed by Sector Pulse."""

from __future__ import annotations

import argparse
import json
import math
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf


SECTORS = {
    "XLC": "Communication Services",
    "XLY": "Consumer Discretionary",
    "XLP": "Consumer Staples",
    "XLE": "Energy",
    "XLF": "Financials",
    "XLV": "Health Care",
    "XLI": "Industrials",
    "XLB": "Materials",
    "XLRE": "Real Estate",
    "XLK": "Technology",
    "XLU": "Utilities",
}
BENCHMARKS = ["SPY", "RSP", "COWZ", "QQQ", "^IXIC"]
FALLBACK_WEIGHTS = {
    "XLC": 0.090,
    "XLY": 0.101,
    "XLP": 0.055,
    "XLE": 0.029,
    "XLF": 0.140,
    "XLV": 0.094,
    "XLI": 0.086,
    "XLB": 0.019,
    "XLRE": 0.019,
    "XLK": 0.322,
    "XLU": 0.045,
}


def finite(value: float | int | None, digits: int = 2) -> float | None:
    if value is None or not math.isfinite(float(value)):
        return None
    return round(float(value), digits)


def series_from_download(frame: pd.DataFrame, ticker: str, field: str) -> pd.Series:
    """Read either yfinance MultiIndex orientation."""
    if frame.empty:
        return pd.Series(dtype=float)
    if isinstance(frame.columns, pd.MultiIndex):
        for key in ((ticker, field), (field, ticker)):
            if key in frame.columns:
                return pd.to_numeric(frame[key], errors="coerce").dropna()
    if field in frame.columns:
        return pd.to_numeric(frame[field], errors="coerce").dropna()
    return pd.Series(dtype=float)


def download_market_data(
    tickers: list[str],
    *,
    period: str,
    interval: str,
    attempts: int = 3,
) -> pd.DataFrame:
    """Download all requested symbols serially, retrying transient provider failures."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            frame = yf.download(
                tickers=tickers,
                period=period,
                interval=interval,
                group_by="ticker",
                auto_adjust=False,
                progress=False,
                threads=False,
                timeout=30,
            )
            missing = [
                ticker
                for ticker in tickers
                if series_from_download(frame, ticker, "Close").empty
            ]
            if frame.empty:
                raise RuntimeError("The market-data provider returned no prices")
            if missing:
                raise RuntimeError(
                    "The market-data provider omitted: " + ", ".join(missing)
                )
            return frame
        except Exception as error:
            last_error = error
            if attempt < attempts:
                time.sleep(2 ** (attempt - 1))

    raise RuntimeError(
        f"Market-data download failed after {attempts} attempts: {last_error}"
    ) from last_error


def wilder_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    values = pd.to_numeric(close, errors="coerce").dropna()
    delta = values.diff()
    gains = delta.clip(lower=0)
    losses = -delta.clip(upper=0)
    avg_gain = pd.Series(float("nan"), index=values.index, dtype=float)
    avg_loss = pd.Series(float("nan"), index=values.index, dtype=float)
    if len(values) <= period:
        return avg_gain

    avg_gain.iloc[period] = gains.iloc[1 : period + 1].mean()
    avg_loss.iloc[period] = losses.iloc[1 : period + 1].mean()
    for position in range(period + 1, len(values)):
        avg_gain.iloc[position] = (
            avg_gain.iloc[position - 1] * (period - 1) + gains.iloc[position]
        ) / period
        avg_loss.iloc[position] = (
            avg_loss.iloc[position - 1] * (period - 1) + losses.iloc[position]
        ) / period

    relative_strength = avg_gain / avg_loss.replace(0, float("nan"))
    result = 100 - (100 / (1 + relative_strength))
    result = result.mask((avg_loss == 0) & (avg_gain > 0), 100.0)
    result = result.mask((avg_loss == 0) & (avg_gain == 0), 50.0)
    return result


def classify_rsi(value: float, oversold: float = 30, overbought: float = 70) -> str:
    if value <= oversold:
        return "oversold"
    if value >= overbought:
        return "overbought"
    return "neutral"


def completed_bar_endpoint(stamp, now=None, minutes: int = 5) -> pd.Timestamp:
    stamp = pd.Timestamp(stamp)
    now_stamp = pd.Timestamp(now if now is not None else datetime.now(timezone.utc))
    if stamp.tzinfo is None and now_stamp.tzinfo is not None:
        now_stamp = now_stamp.tz_localize(None)
    elif stamp.tzinfo is not None and now_stamp.tzinfo is None:
        now_stamp = now_stamp.tz_localize(stamp.tzinfo)
    elif stamp.tzinfo is not None:
        now_stamp = now_stamp.tz_convert(stamp.tzinfo)
    endpoint = stamp + timedelta(minutes=minutes)
    return endpoint if now_stamp >= endpoint else stamp


def market_date(stamp):
    value = pd.Timestamp(stamp)
    if value.tzinfo is not None:
        value = value.tz_convert("America/New_York")
    return value.date()


def previous_completed_close(daily: pd.Series, live: pd.Series) -> float:
    """Return the latest daily close strictly before the live trading date."""
    closes = pd.to_numeric(daily, errors="coerce").dropna()
    prices = pd.to_numeric(live, errors="coerce").dropna()
    if len(closes) < 2:
        raise RuntimeError("Two daily prices are required")
    if prices.empty:
        return float(closes.iloc[-2])
    live_date = market_date(prices.index[-1])
    completed_live = prices[[market_date(stamp) < live_date for stamp in prices.index]]
    if not completed_live.empty:
        return float(completed_live.iloc[-1])
    completed = closes[[market_date(stamp) < live_date for stamp in closes.index]]
    if completed.empty:
        raise RuntimeError("A completed prior-day close is required")
    return float(completed.iloc[-1])


def build_momentum(daily: pd.DataFrame, generated_at: datetime) -> dict:
    rows = []
    for ticker, name in SECTORS.items():
        closes = series_from_download(daily, ticker, "Close")
        if len(closes) < 205:
            raise RuntimeError(f"{ticker} does not have enough daily prices")
        rsi_values = wilder_rsi(closes, 14).dropna()
        if len(rsi_values) < 6:
            raise RuntimeError(f"{ticker} does not have enough RSI history")
        latest_rsi = float(rsi_values.iloc[-1])
        rows.append(
            {
                "ticker": ticker,
                "name": name,
                "price": finite(closes.iloc[-1], 2),
                "changePct": finite((closes.iloc[-1] / closes.iloc[-2] - 1) * 100, 2),
                "rsi": finite(latest_rsi, 1),
                "rsiChange5d": finite(latest_rsi - float(rsi_values.iloc[-6]), 1),
                "status": classify_rsi(latest_rsi),
                "history": [finite(value, 1) for value in rsi_values.iloc[-25:]],
            }
        )

    vix_closes = series_from_download(daily, "^VIX", "Close")
    if len(vix_closes) < 200:
        raise RuntimeError("VIX does not have 200 daily prices")
    vix_value = float(vix_closes.iloc[-1])
    vix_ma = float(vix_closes.iloc[-200:].mean())
    counts = {
        status: sum(item["status"] == status for item in rows)
        for status in ("oversold", "neutral", "overbought")
    }
    market_date = max(pd.Timestamp(series_from_download(daily, ticker, "Close").index[-1]).date() for ticker in SECTORS)
    return {
        "generatedAt": generated_at.isoformat(),
        "marketDate": market_date.isoformat(),
        "source": "Yahoo Finance via yfinance; daily bars",
        "cached": False,
        "period": 14,
        "thresholds": {"oversold": 30, "overbought": 70},
        "sectors": rows,
        "customTickers": [],
        "counts": counts,
        "vix": {
            "value": finite(vix_value, 2),
            "ma200": finite(vix_ma, 2),
            "distancePct": finite((vix_value / vix_ma - 1) * 100, 1),
            "regime": "elevated" if vix_value > vix_ma else "lower",
        },
    }


def build_contributions(daily: pd.DataFrame, intraday: pd.DataFrame, generated_at: datetime) -> dict:
    rows = []
    as_of = None
    for ticker, name in SECTORS.items():
        closes = series_from_download(daily, ticker, "Close")
        live = series_from_download(intraday, ticker, "Close")
        if len(closes) < 2:
            raise RuntimeError(f"{ticker} does not have two daily prices")
        previous = previous_completed_close(closes, live)
        current = float(live.iloc[-1]) if not live.empty else float(closes.iloc[-1])
        change = (current / previous - 1) * 100
        if not live.empty:
            stamp = pd.Timestamp(live.index[-1])
            as_of = stamp if as_of is None or stamp > as_of else as_of
        rows.append(
            {
                "ticker": ticker,
                "name": name,
                "price": finite(current, 2),
                "weightPct": finite(FALLBACK_WEIGHTS[ticker] * 100, 2),
                "equalWeightPct": None,
                "changePct": finite(change, 2),
                "contributionPct": finite(FALLBACK_WEIGHTS[ticker] * change, 3),
            }
        )

    spy_daily = series_from_download(daily, "SPY", "Close")
    spy_live = series_from_download(intraday, "SPY", "Close")
    if len(spy_daily) < 2:
        raise RuntimeError("SPY does not have two daily prices")
    spy_previous = previous_completed_close(spy_daily, spy_live)
    spy_current = float(spy_live.iloc[-1]) if not spy_live.empty else float(spy_daily.iloc[-1])
    spy_change = (spy_current / spy_previous - 1) * 100
    residual = spy_change - sum(float(item["contributionPct"]) for item in rows)
    absolute_total = sum(abs(float(item["contributionPct"])) for item in rows)
    for item in rows:
        share = abs(float(item["contributionPct"])) / absolute_total if absolute_total else float(item["weightPct"]) / 100
        item["contributionPct"] = finite(float(item["contributionPct"]) + residual * share, 3)
    rows.sort(key=lambda item: float(item["contributionPct"]), reverse=True)

    benchmarks = []
    for ticker in BENCHMARKS:
        closes = series_from_download(daily, ticker, "Close")
        live = series_from_download(intraday, ticker, "Close")
        if len(closes) < 2:
            raise RuntimeError(f"{ticker} does not have two daily prices")
        previous = previous_completed_close(closes, live)
        current = float(live.iloc[-1]) if not live.empty else float(closes.iloc[-1])
        benchmarks.append(
            {
                "ticker": ticker,
                "price": finite(current, 2),
                "changePct": finite((current / previous - 1) * 100, 3),
            }
        )

    effective_as_of = (
        completed_bar_endpoint(as_of, generated_at).isoformat()
        if as_of is not None
        else pd.Timestamp(spy_daily.index[-1]).isoformat()
    )
    return {
        "generatedAt": generated_at.isoformat(),
        "asOf": effective_as_of,
        "marketDate": market_date(as_of if as_of is not None else spy_daily.index[-1]).isoformat(),
        "estimatedChangePct": finite(sum(float(item["contributionPct"]) for item in rows), 3),
        "spyChangePct": finite(spy_change, 3),
        "sectors": rows,
        "benchmarks": benchmarks,
        "source": "Yahoo Finance via yfinance; 5-minute prices when available; built-in fallback sector allocations",
        "methodology": (
            "Estimated contribution starts with sector weight × sector ETF price change since the prior close. "
            "The ETF-tracking difference versus SPY is distributed in proportion to absolute sector impact."
        ),
    }


def build_snapshot() -> dict:
    generated_at = datetime.now(timezone.utc)
    tickers = [*SECTORS, "^VIX", *BENCHMARKS]
    daily = download_market_data(
        tickers,
        period="1y",
        interval="1d",
    )
    intraday = download_market_data(
        [*SECTORS, *BENCHMARKS],
        period="5d",
        interval="5m",
    )
    return {
        "schemaVersion": 1,
        "generatedAt": generated_at.isoformat(),
        "momentum": build_momentum(daily, generated_at),
        "contributions": build_contributions(daily, intraday, generated_at),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="snapshot.json")
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    snapshot = build_snapshot()
    output.write_text(json.dumps(snapshot, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"Wrote {output} at {snapshot['generatedAt']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
