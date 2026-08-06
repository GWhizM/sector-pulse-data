from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from urllib.request import Request, urlopen


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def should_publish(candidate: dict, current: dict) -> tuple[bool, str]:
    candidate_data = candidate.get("contributions", candidate)
    candidate_date = candidate_data.get("marketDate")
    current_date = current.get("marketDate")
    if not candidate_date:
        return False, "candidate snapshot has no marketDate"
    if not current_date:
        return True, "no current marketDate is available"
    if candidate_date < current_date:
        return False, f"candidate marketDate {candidate_date} is older than current {current_date}"
    if candidate_date > current_date:
        return True, f"candidate marketDate {candidate_date} is newer than current {current_date}"

    candidate_as_of = parse_timestamp(candidate_data.get("asOf"))
    current_as_of = parse_timestamp(current.get("asOf"))
    if candidate_as_of and current_as_of and candidate_as_of < current_as_of:
        return False, f"candidate asOf {candidate_as_of.isoformat()} is older than current {current_as_of.isoformat()}"
    return True, "candidate is not older than the current snapshot"


def load_current(url: str) -> dict:
    separator = "&" if "?" in url else "?"
    request = Request(
        f"{url}{separator}_={int(datetime.now().timestamp() * 1000)}",
        headers={"Accept": "application/json", "Cache-Control": "no-cache"},
    )
    with urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("Current snapshot response is not a JSON object")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--current-url", required=True)
    args = parser.parse_args()

    candidate = json.loads(Path(args.candidate).read_text(encoding="utf-8"))
    try:
        current = load_current(args.current_url)
    except Exception as exc:
        print(f"Snapshot guard could not read the current snapshot; preserving it: {exc}", file=sys.stderr)
        print("publish=false")
        return 0

    publish, reason = should_publish(candidate, current)
    print(f"Snapshot guard: {reason}; publish={str(publish).lower()}", file=sys.stderr)
    print(f"publish={str(publish).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
