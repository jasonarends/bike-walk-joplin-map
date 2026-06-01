#!/usr/bin/env python3
"""
Geocode Joplin pedestrian & bicycle crash locations from MSHP STARS export.

INPUT
─────
One or more .xls files exported from https://www.mshp.dps.missouri.gov/TR15Map/Search
(Note: these files are actually HTML tables with an .xls extension — pandas read_html handles them.)

Run this script from the directory that contains the .xls files, or pass --data-dir.

OUTPUT
──────
scripts/crashes.geojson — committed to the repo, loaded by app.js as an overlay layer.

USAGE
─────
  cd /path/to/xls/files
  python3 /path/to/bike_walk_joplin/scripts/geocode_crashes.py

  # Or specify data dir:
  python3 scripts/geocode_crashes.py --data-dir ~/joplin_crash_exports

  # Dry-run: print intersections that would be geocoded without hitting Nominatim:
  python3 scripts/geocode_crashes.py --dry-run

REQUIREMENTS
────────────
  pip install pandas requests
"""

import argparse
import json
import os
import re
import time
from pathlib import Path

import pandas as pd
import requests

# ── Constants ─────────────────────────────────────────────────────────────────

NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
NOMINATIM_HEADERS = {'User-Agent': 'BikeWalkJoplin/1.0 (jason.arends@gmail.com)'}
RATE_LIMIT_SEC   = 1.1   # Nominatim ToS: max 1 req/sec

# Missouri highway code → human-readable name for better geocoding
# Source: MSHP STARS field descriptions + MoDOT numbering
ROUTE_MAP = {
    'MO 66':  'Route 66',
    'MO 43':  'Missouri Route 43',
    'MO 86':  'Missouri Route 86',
    'MO 171': 'Missouri Route 171',
    'MO 249': 'Missouri Route 249',
    'LP 49':  'Loop 49',       # Rangeline Road loop
    'RT FF':  'Route FF',      # 32nd St / Connecticut Ave area
    'RT TT':  'Route TT',
    'IS 44':  'Interstate 44',
    'BU 71':  'Business 71',   # DeMott Ave / Airport area
    'US 166': 'US Route 166',
    'US 249': 'US Route 249',
}

# Prefix codes to strip from city-street names
CST_PREFIXES = re.compile(r'^(CST|CRD|ALY|PVT|PP|RP|WS|SOR|WOR|NOR)\s+', re.I)

OUTPUT_PATH = Path(__file__).parent.parent / 'scripts' / 'crashes.geojson'
# Actually put it where app.js can serve it:
OUTPUT_PATH = Path(__file__).parent.parent / 'data' / 'crashes.geojson'


def clean_street(name: str) -> str:
    """Convert MSHP highway codes to human-readable street names."""
    name = name.strip()
    if name in ROUTE_MAP:
        return ROUTE_MAP[name]
    # Strip city-street prefix codes
    name = CST_PREFIXES.sub('', name)
    return name.title()


def make_query(on_street: str, at_street: str) -> str:
    on = clean_street(on_street)
    at = clean_street(at_street)
    return f'{on} and {at}, Joplin, MO'


def geocode(query: str) -> tuple[float, float] | None:
    """Return (lat, lon) or None."""
    try:
        r = requests.get(NOMINATIM_URL, params={
            'q': query,
            'format': 'json',
            'limit': 1,
            'countrycodes': 'us',
            'viewbox': '-94.70,36.90,-94.35,37.25',
            'bounded': 1,
        }, headers=NOMINATIM_HEADERS, timeout=10)
        results = r.json()
        if results:
            return float(results[0]['lat']), float(results[0]['lon'])
    except Exception as e:
        print(f'    geocode error: {e}')
    return None


def load_crash_data(data_dir: Path) -> pd.DataFrame:
    xls_files = list(data_dir.glob('*.xls'))
    if not xls_files:
        raise FileNotFoundError(f'No .xls files found in {data_dir}')
    print(f'Found {len(xls_files)} .xls file(s)')

    dfs = []
    for f in xls_files:
        try:
            tables = pd.read_html(str(f))
            df = tables[0]
            df['_source'] = f.name
            dfs.append(df)
        except Exception as e:
            print(f'  WARNING: could not read {f.name}: {e}')

    combined = pd.concat(dfs, ignore_index=True)
    combined.drop_duplicates(subset='Rpt No', keep='first', inplace=True)

    # Filter Joplin only, pedestrian & bicycle crashes
    joplin = combined[combined['City'].str.upper() == 'JOPLIN']
    ped_bike = joplin[joplin['Type'].isin(['Pedestrian', 'Pedalcycle'])]

    print(f'Total records: {len(combined)}  →  Joplin ped/bike: {len(ped_bike)}')
    return ped_bike.copy()


def main():
    parser = argparse.ArgumentParser(description='Geocode Joplin ped/bike crash intersections')
    parser.add_argument('--data-dir', default='.', metavar='DIR',
                        help='Directory containing MSHP .xls export files (default: current dir)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Print intersections without geocoding')
    args = parser.parse_args()

    data_dir = Path(args.data_dir).expanduser().resolve()
    df = load_crash_data(data_dir)

    # Count crashes per intersection
    df['_intersection'] = df['On Street'] + ' @ ' + df['At Street']
    intersection_counts = df.groupby(['On Street', 'At Street']).agg(
        total=('Rpt No', 'count'),
        pedestrian=('Type', lambda x: (x == 'Pedestrian').sum()),
        bicycle=('Type', lambda x: (x == 'Pedalcycle').sum()),
        fatal=('Severity', lambda x: (x == 'Fatal').sum()),
        injury=('Severity', lambda x: (x == 'Personl Injury').sum()),
        years=('Date', lambda x: f"{pd.to_datetime(x).dt.year.min()}–{pd.to_datetime(x).dt.year.max()}"),
    ).reset_index()

    intersection_counts.sort_values('total', ascending=False, inplace=True)
    print(f'\n{len(intersection_counts)} unique intersections to geocode')
    print('\nTop 10 intersections:')
    for _, row in intersection_counts.head(10).iterrows():
        q = make_query(row['On Street'], row['At Street'])
        print(f"  {row['total']:3d} crashes — {q}  (ped:{row['pedestrian']} bike:{row['bicycle']} fatal:{row['fatal']})")

    if args.dry_run:
        print('\n[dry-run] Exiting without geocoding.')
        return

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    features = []
    failed  = []
    total   = len(intersection_counts)

    print(f'\nGeocoding {total} intersections via Nominatim (≈{total * RATE_LIMIT_SEC / 60:.0f} min)…\n')

    for i, (_, row) in enumerate(intersection_counts.iterrows(), 1):
        query = make_query(row['On Street'], row['At Street'])
        result = geocode(query)

        if result:
            lat, lon = result
            features.append({
                'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
                'properties': {
                    'on_street':  row['On Street'],
                    'at_street':  row['At Street'],
                    'label':      query.replace(', Joplin, MO', ''),
                    'total':      int(row['total']),
                    'pedestrian': int(row['pedestrian']),
                    'bicycle':    int(row['bicycle']),
                    'fatal':      int(row['fatal']),
                    'injury':     int(row['injury']),
                    'years':      row['years'],
                }
            })
            print(f'  [{i}/{total}] ✓ {query}  ({lat:.4f}, {lon:.4f})')
        else:
            failed.append(query)
            print(f'  [{i}/{total}] ✗ {query}')

        time.sleep(RATE_LIMIT_SEC)

    geojson = {'type': 'FeatureCollection', 'features': features}
    OUTPUT_PATH.write_text(json.dumps(geojson, indent=2))

    print(f'\n{"─"*50}')
    print(f'  Geocoded : {len(features)}/{total}')
    print(f'  Failed   : {len(failed)}')
    print(f'  Output   : {OUTPUT_PATH.resolve()}')

    if failed:
        print('\nFailed intersections (check/fix manually):')
        for q in failed:
            print(f'  {q}')

    print('\nNext: git add data/crashes.geojson && git commit && git push')
    print('The crash layer in app.js will activate automatically once the file is present.')


if __name__ == '__main__':
    main()
