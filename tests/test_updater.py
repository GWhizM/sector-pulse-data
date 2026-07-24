from datetime import datetime, timezone
import unittest

import pandas as pd

from sector_pulse_updater import classify_rsi, completed_bar_endpoint, finite, wilder_rsi


class UpdaterTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
