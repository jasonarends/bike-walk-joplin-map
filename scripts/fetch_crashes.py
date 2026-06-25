#!/usr/bin/env python3
"""
Fetch Jasper County crash data directly from the MSHP STARS ArcGIS REST service.

This replaces the manual XLS-download + Nominatim geocoding workflow
(see scripts/geocode_crashes.py — superseded).

SOURCE
──────
The TR15Map web app at https://www.mshp.dps.missouri.gov/TR15Map/Search calls a
public, unauthenticated ArcGIS REST endpoint:

  https://www.mshp.dps.missouri.gov/arcgis/rest/services/STARS_CRASHES/MapServer/0/query

It returns per-crash point features with ~50 attributes (ACC_DATE, ACC_TYPE,
SEVERITY, ON_STREET, AT_STREET, GPS_LAT/LONG, INJURED, KILLED, plus condition
flags). Most records carry real WGS84 coordinates — no geocoding needed.

OUTPUT
──────
data/crashes.geojson — one Feature per crash, consumed by app.js.

USAGE
─────
  python3 scripts/fetch_crashes.py                   # default: last 10 yrs, Jasper, ped + bike
  python3 scripts/fetch_crashes.py --all-types       # include every ACC_TYPE (much larger)
  python3 scripts/fetch_crashes.py --years 5         # shorter rolling window
  python3 scripts/fetch_crashes.py --since 2018-01-01  # fixed start date instead of rolling
  python3 scripts/fetch_crashes.py --city JOPLIN
  python3 scripts/fetch_crashes.py --dry-run         # count only, no file write

REQUIREMENTS
────────────
  pip install requests
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import requests

ENDPOINT = (
    "https://www.mshp.dps.missouri.gov/arcgis/rest/services/"
    "STARS_CRASHES/MapServer/0/query"
)
HEADERS = {
    "User-Agent": "BikeWalkJoplin/1.0 (jason.arends@gmail.com)",
    "Referer": "https://www.mshp.dps.missouri.gov/TR15Map/Search",
}
PAGE_SIZE = 2000  # well under the server cap of 10000; keeps responses snappy
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "crashes.geojson"

# Attributes we keep on each feature. Everything else is dropped to keep the
# GeoJSON file small.
KEEP_FIELDS = [
    "ACCIDENT",
    "ACC_DATE",
    "ACC_TIME",
    "COUNTY",
    "CITY",
    "ON_STREET",
    "AT_STREET",
    "INTER_LOC",
    "DIRECTION",
    "ACC_TYPE",
    "SEVERITY",
    "INJURED",
    "KILLED",
    "NO_VEHICLE",
    "DR_DRINK",
    "DR_DRUG",
    "SPEED",
    "CELL_PHONE",
    "TEXTING",
    "MOTORCYCLE",
    "PICKUP",
    "TRUCK",
    "SCHOOL_BUS",
    "LIGHT_COND",
    "DAY_WEEK",
]


def build_where(years: int, since: dt.date | None, city: str | None, ped_bike: bool) -> str:
    cutoff = (since or (dt.date.today() - dt.timedelta(days=365 * years))).isoformat()
    clauses = [
        "COUNTY='JASPER'",
        f"ACC_DATE >= DATE '{cutoff}'",
    ]
    if city:
        clauses.append(f"CITY='{city.upper()}'")
    if ped_bike:
        clauses.append("ACC_TYPE IN ('Pedestrian','Pedalcycle')")
    return " AND ".join(clauses)


def query_count(where: str) -> int:
    r = requests.post(
        ENDPOINT,
        headers=HEADERS,
        data={"where": where, "returnCountOnly": "true", "f": "json"},
        timeout=30,
    )
    r.raise_for_status()
    return int(r.json()["count"])


def query_page(where: str, offset: int) -> dict:
    r = requests.post(
        ENDPOINT,
        headers=HEADERS,
        data={
            "where": where,
            "outFields": ",".join(KEEP_FIELDS),
            "returnGeometry": "true",
            "outSR": "4326",
            "orderByFields": "ACC_DATE ASC",
            "resultOffset": str(offset),
            "resultRecordCount": str(PAGE_SIZE),
            "f": "geojson",
        },
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def normalize_feature(f: dict) -> dict | None:
    """Convert ms-epoch dates to ISO, drop (0,0) placeholders. Returns None to skip."""
    coords = (f.get("geometry") or {}).get("coordinates") or [0, 0]
    lon, lat = coords[0], coords[1]
    # The endpoint returns 5.68e-14 for missing coords — anything near zero is bogus.
    if abs(lon) < 1 or abs(lat) < 1:
        return None

    props = dict(f.get("properties") or {})
    epoch = props.get("ACC_DATE")
    if isinstance(epoch, (int, float)):
        props["ACC_DATE"] = (
            dt.datetime.fromtimestamp(epoch / 1000, tz=dt.timezone.utc).date().isoformat()
        )

    # Trim None/empty values
    props = {k: v for k, v in props.items() if v not in (None, "", " ")}

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": props,
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    window = p.add_mutually_exclusive_group()
    window.add_argument("--years", type=int, default=10,
                        help="Rolling lookback window in years (default: 10)")
    window.add_argument("--since", type=dt.date.fromisoformat, metavar="YYYY-MM-DD",
                        help="Fixed start date (overrides --years)")
    p.add_argument("--city", help="Restrict to one city (e.g. JOPLIN)")
    p.add_argument("--all-types", action="store_true",
                   help="Include every ACC_TYPE (default filters to Pedestrian + Pedalcycle)")
    p.add_argument("--dry-run", action="store_true",
                   help="Print count only, don't fetch or write")
    p.add_argument("--output", type=Path, default=OUTPUT_PATH,
                   help=f"Output path (default: {OUTPUT_PATH})")
    args = p.parse_args()

    where = build_where(args.years, args.since, args.city, ped_bike=not args.all_types)
    print(f"WHERE  {where}")

    total = query_count(where)
    print(f"COUNT  {total} crashes match")

    if args.dry_run or total == 0:
        return 0

    features: list[dict] = []
    dropped_no_geom = 0
    offset = 0

    while offset < total:
        page = query_page(where, offset)
        page_features = page.get("features", [])
        if not page_features:
            break

        for f in page_features:
            n = normalize_feature(f)
            if n is None:
                dropped_no_geom += 1
            else:
                features.append(n)

        offset += len(page_features)
        print(f"  fetched {offset}/{total}")

    out = {
        "type": "FeatureCollection",
        "metadata": {
            "source": ENDPOINT,
            "fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "where": where,
            "total_returned": total,
            "kept": len(features),
            "dropped_no_geometry": dropped_no_geom,
        },
        "features": features,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(out))
    size_mb = args.output.stat().st_size / 1_048_576
    print(f"\nWrote {len(features):,} features to {args.output}  ({size_mb:.1f} MB)")
    print(f"Dropped {dropped_no_geom} records with missing GPS coords.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
