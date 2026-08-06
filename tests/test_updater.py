from datetime import datetime, timezone
import unittest
from unittest.mock import patch

import pandas as pd

from sector_pulse_history import HISTORY_SYMBOLS, build_bulk_payload, build_history
from sector_pulse_updater import (
    classify_rsi,
    completed_bar_endpoint,
    download_market_data,
    finite,
    previous_completed_close,
    wilder_rsi,
)


class UpdaterTests(unittest.TestCase):
    @patch("sector_pulse_updater.time.sleep")
    @patch("sector_pulse_updater.yf.download")
    def test_download_retries_transient_failure_without_threads(self, download, sleep):
        frame = pd.DataFrame(
            {"Close": [100.0, 101.0]},
            index=pd.date_range("2026-08-05", periods=2, freq="D"),
        )
        download.side_effect = [RuntimeError("database is locked"), frame]

        result = download_market_data(
            ["SPY"], period="5d", interval="5m"
        )

        self.assertIs(result, frame)
        self.assertEqual(download.call_count, 2)
        self.assertFalse(download.call_args.kwargs["threads"])
        sleep.assert_called_once_with(1)

    def test_rsi_uses_wilder_simple_average_seed(self):
        values = pd.Series(
            [
                44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10,
                45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
                46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21,
            ]
        )
        result = wilder_rsi(values, 14)
        self.assertAlmostEqual(float(result.iloc[14]), 70.46413502109705)
        self.assertAlmostEqual(float(result.iloc[15]), 66.24961855355505)

    def test_wilder_rsi_rises_for_rising_series(self):
        values = pd.Series(range(1, 80), dtype=float)
        self.assertEqual(float(wilder_rsi(values, 14).dropna().iloc[-1]), 100.0)

    def test_classification_boundaries(self):
        self.assertEqual(classify_rsi(30), "oversold")
        self.assertEqual(classify_rsi(50), "neutral")
        self.assertEqual(classify_rsi(70), "overbought")

    def test_finite_rejects_nan(self):
        self.assertIsNone(finite(float("nan")))

    def test_completed_bar_does_not_claim_future_endpoint(self):
        stamp = pd.Timestamp("2026-07-24T14:30:00Z")
        before_close = datetime(2026, 7, 24, 14, 33, tzinfo=timezone.utc)
        after_close = datetime(2026, 7, 24, 14, 36, tzinfo=timezone.utc)
        self.assertEqual(completed_bar_endpoint(stamp, before_close), stamp)
        self.assertEqual(completed_bar_endpoint(stamp, after_close), stamp + pd.Timedelta(minutes=5))

    def test_previous_close_when_daily_data_does_not_include_live_day(self):
        daily = pd.Series(
            [100.0, 101.0],
            index=pd.to_datetime(["2026-07-23", "2026-07-24"]),
        )
        live = pd.Series(
            [101.5],
            index=pd.to_datetime(["2026-07-27T10:00:00-04:00"]),
        )
        self.assertEqual(previous_completed_close(daily, live), 101.0)

    def test_previous_close_prefers_prior_intraday_close_when_daily_day_is_missing(self):
        daily = pd.Series(
            [63.67, 65.92],
            index=pd.to_datetime(["2026-07-23", "2026-07-27"]),
        )
        live = pd.Series(
            [64.89, 65.92],
            index=pd.to_datetime([
                "2026-07-24T16:00:00-04:00",
                "2026-07-27T11:05:00-04:00",
            ]),
        )
        self.assertEqual(previous_completed_close(daily, live), 64.89)

    def test_previous_close_ignores_partial_daily_bar(self):
        daily = pd.Series(
            [100.0, 101.0, 101.4],
            index=pd.to_datetime(["2026-07-23", "2026-07-24", "2026-07-27"]),
        )
        live = pd.Series(
            [101.5],
            index=pd.to_datetime(["2026-07-27T10:00:00-04:00"]),
        )
        self.assertEqual(previous_completed_close(daily, live), 101.0)

    def test_history_bundle_keeps_requested_display_symbol(self):
        dates = pd.date_range("2026-07-20", periods=3, freq="B")
        columns = pd.MultiIndex.from_product([["Close", "Adj Close"], list(HISTORY_SYMBOLS)])
        frame = pd.DataFrame(index=dates, columns=columns, dtype=float)
        for offset, ticker in enumerate(HISTORY_SYMBOLS):
            frame[("Close", ticker)] = [100 + offset, 101 + offset, 102 + offset]
            frame[("Adj Close", ticker)] = [100 + offset, 101 + offset, 102 + offset]
        history = build_history(frame, datetime(2026, 7, 24, tzinfo=timezone.utc))
        self.assertEqual(history["symbols"]["BRK-B"]["displayTicker"], "BRK/B")
        self.assertEqual(len(history["symbols"]), len(HISTORY_SYMBOLS))
        self.assertEqual(len(history["symbols"]["KIE"]["points"]), 3)
        payload = build_bulk_payload(history)
        self.assertGreaterEqual(len(payload), len(HISTORY_SYMBOLS) + 3)
        self.assertIn("history:BRK-B", {item["key"] for item in payload})
        self.assertIn("history:custom-periods:2026", {item["key"] for item in payload})


if __name__ == "__main__":
    unittest.main()
