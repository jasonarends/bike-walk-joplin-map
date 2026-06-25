#!/usr/bin/env python3
"""
Fetch Joplin K-12 school locations from NCES and bake them into
data/joplin_schools.geojson.

NCES's public ArcGIS endpoint is reliable but slow on cold cache, so we pull it
once on the cron and let the dashboard read the static file.

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

ENDPOINT = (
    "https://nces.ed.gov/opengis/rest/services/K12_School_Locations/"
    "EDGE_GEOCODE_PUBLICSCH_2324/MapServer/0/query"
)
HEADERS = {"User-Agent": "BikeWalkJoplin/1.0 (jason.arends@gmail.com)"}
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "joplin_schools.geojson"


def main() -> int:
    r = requests.get(
        ENDPOINT,
        headers=HEADERS,
        params={
            "where": "CITY = 'JOPLIN' AND STATE = 'MO'",
            "outFields": "*",
            "outSR": "4326",
            "f": "geojson",
        },
        timeout=60,
    )
    r.raise_for_status()
    data = r.json()
    feats = data.get("features", []) or []

    out = {
        "type": "FeatureCollection",
        "metadata": {
            "fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "source": ENDPOINT,
            "count": len(feats),
        },
        "features": feats,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(out))
    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"Wrote {len(feats)} schools to {OUTPUT_PATH}  ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
