#!/usr/bin/env python3
"""
Fetch Joplin's bike-facility lines (sidewalk + road) from the city ArcGIS server
and bake them into data/bike_facilities.geojson.

Pulled by scripts/update_crashes.sh on the cron box so the dashboard's
Risk & Equity tab doesn't have to hit joplingis.org on every page load.

REQUIREMENTS
────────────
  pip install requests
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import requests

LAYERS = {
    "sidewalk": (
        "https://www.joplingis.org/server/rest/services/Bike_Lanes/"
        "Bike_Lanes_mxd_2024/MapServer/0/query"
    ),
    "road": (
        "https://www.joplingis.org/server/rest/services/Bike_Lanes/"
        "Bike_Lanes_mxd_2024/MapServer/1/query"
    ),
}
HEADERS = {"User-Agent": "BikeWalkJoplin/1.0 (jason.arends@gmail.com)"}
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "bike_facilities.geojson"


def fetch_layer(url: str, label: str) -> list[dict]:
    r = requests.get(
        url,
        headers=HEADERS,
        params={
            "where": "1=1",
            "outFields": "*",
            "outSR": "4326",
            "f": "geojson",
        },
        timeout=60,
    )
    r.raise_for_status()
    feats = r.json().get("features", []) or []
    for f in feats:
        f.setdefault("properties", {})["_layer"] = label
    return feats


def main() -> int:
    all_features: list[dict] = []
    for label, url in LAYERS.items():
        print(f"fetching {label}…")
        feats = fetch_layer(url, label)
        print(f"  {len(feats)} features")
        all_features.extend(feats)

    out = {
        "type": "FeatureCollection",
        "metadata": {
            "fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "sources": LAYERS,
            "count": len(all_features),
        },
        "features": all_features,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(out))
    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"\nWrote {len(all_features)} features to {OUTPUT_PATH}  ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
