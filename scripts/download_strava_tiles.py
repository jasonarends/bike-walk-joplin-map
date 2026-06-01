#!/usr/bin/env python3
"""
Download Strava global heatmap tiles for the Joplin, MO area.
Saves them as static files — no token refresh ever needed again.

HOW TO GET YOUR FULL COOKIE STRING (Strava format as of 2026)
─────────────────────────────────────────────────────────────
Auth is sent via cookies. You need the entire Cookie header value.

1. Log into strava.com in Firefox or Chrome
2. Go to: https://www.strava.com/maps/global-heatmap
3. Open DevTools → Network tab → filter for "content-"
4. Pan the map to trigger tile loads, click any PNG request
5. In the request headers, find the "Cookie:" line
6. Copy the ENTIRE value (it's one long string with semicolons between values)
   It will contain: _strava4_session=...; CloudFront-Key-Pair-Id=...; CloudFront-Policy=...; CloudFront-Signature=...

USAGE
─────
    python3 scripts/download_strava_tiles.py \\
        --cookies "_strava4_session=abc123; CloudFront-Key-Pair-Id=K3VK9...; CloudFront-Policy=eyJ...; CloudFront-Signature=FAl9..."

    # Preview tile counts without downloading:
    python3 scripts/download_strava_tiles.py ... --dry-run

OPTIONS
───────
    --zoom-max   16      Default: 16  (12=city overview, 16=street level)
    --activity   Ride    Ride | Run | All | Water | Winter  (Strava sport_ prefix added automatically)
    --color      hot     hot | grayscale | blue | bluered | purple | gray
    --bbox               Custom bounding box "south,west,north,east"

NOTES
─────
- Tokens typically last 4–12 weeks. Re-run to refresh — already-cached
  tiles are skipped automatically so re-runs are fast.
- missing=empty is set so Strava returns a transparent PNG for tiles
  with no activity instead of 404, which means no broken tile icons.
- Rate is throttled to ~5 req/sec to be polite to Strava's CDN.
"""

import argparse
import math
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ── Joplin metro bounding box ──────────────────────────────────────────────
DEFAULT_BBOX = {'south': 36.95, 'north': 37.20, 'west': -94.65, 'east': -94.42}

HOSTS = ['content-a']   # b/c may not resolve outside strava.com's own network

TILE_URL = (
    'https://{host}.strava.com/identified/globalheat'
    '/sport_{activity}/{color}/{z}/{x}/{y}@2x.png'
    '?v=19&missing=empty'
)

# ── Tile math ──────────────────────────────────────────────────────────────

def lon_to_x(lon: float, z: int) -> int:
    return int((lon + 180) / 360 * 2 ** z)

def lat_to_y(lat: float, z: int) -> int:
    r = math.radians(lat)
    return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)

def tile_ranges(bbox: dict, z: int):
    return (
        lon_to_x(bbox['west'],  z),
        lon_to_x(bbox['east'],  z),
        lat_to_y(bbox['north'], z),   # north → smaller y
        lat_to_y(bbox['south'], z),   # south → larger y
    )

# ── Download ───────────────────────────────────────────────────────────────

def download_tiles(*, cookies,
                   zoom_min=12, zoom_max=16, activity='Ride', color='hot',
                   bbox=None, dry_run=False):

    if bbox is None:
        bbox = DEFAULT_BBOX

    out_root = Path(__file__).parent.parent / 'tiles' / 'strava'
    out_root.mkdir(parents=True, exist_ok=True)

    cookie = cookies

    # ── Plan ─────────────────────────────────────────────────────────────
    plan = []
    grand_total = 0
    for z in range(zoom_min, zoom_max + 1):
        x0, x1, y0, y1 = tile_ranges(bbox, z)
        count = (x1 - x0 + 1) * (y1 - y0 + 1)
        plan.append((z, x0, x1, y0, y1, count))
        grand_total += count

    print(f'\nStrava heatmap tile downloader')
    print(f'  Activity : sport_{activity}   Color: {color}')
    print(f'  Zoom     : {zoom_min}–{zoom_max}')
    print(f'  Bbox     : S={bbox["south"]} W={bbox["west"]} N={bbox["north"]} E={bbox["east"]}')
    print()

    for z, x0, x1, y0, y1, count in plan:
        cached = sum(
            1 for x in range(x0, x1 + 1)
            for y in range(y0, y1 + 1)
            if (out_root / str(z) / str(x) / f'{y}.png').exists()
        )
        print(f'  z{z:2d}: {x1-x0+1:3d} × {y1-y0+1:3d} = {count:5d} tiles  ({cached} cached)')

    print(f'\n  Total    : {grand_total} tiles')
    need = sum(
        1 for z, x0, x1, y0, y1, _ in plan
        for x in range(x0, x1 + 1)
        for y in range(y0, y1 + 1)
        if not (out_root / str(z) / str(x) / f'{y}.png').exists()
    )
    est_min = need / 5 / 60
    print(f'  To fetch : {need} tiles  (~{est_min:.0f} min at 5 req/sec)')
    print(f'  Output   : {out_root.resolve()}')

    if dry_run:
        print('\n[dry-run] No files downloaded.')
        return

    if need == 0:
        print('\nAll tiles already cached — nothing to do.')
        return

    print('\nStarting download… (Ctrl+C to pause, re-run to resume)\n')

    downloaded = 0
    skipped    = 0
    failed     = 0
    host_idx   = 0
    start_time = time.time()

    for z, x0, x1, y0, y1, count in plan:
        print(f'── Zoom {z} ({count} tiles) ──────────────────────────')
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                out_path = out_root / str(z) / str(x) / f'{y}.png'
                if out_path.exists():
                    skipped += 1
                    continue

                out_path.parent.mkdir(parents=True, exist_ok=True)
                host = HOSTS[host_idx % len(HOSTS)]
                host_idx += 1

                url = TILE_URL.format(
                    host=host, activity=activity, color=color,
                    z=z, x=x, y=y,
                )

                for attempt in range(3):
                    try:
                        req = urllib.request.Request(url, headers={
                            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
                            'Referer':    'https://www.strava.com/',
                            'Origin':     'https://www.strava.com',
                            'Accept':     'image/png,image/*,*/*',
                            'Cookie':     cookie,
                        })
                        with urllib.request.urlopen(req, timeout=20) as resp:
                            data = resp.read()
                        out_path.write_bytes(data)
                        downloaded += 1
                        elapsed = time.time() - start_time
                        rate = downloaded / elapsed if elapsed > 0 else 0
                        remaining = (need - downloaded - skipped) / rate / 60 if rate > 0 else 0
                        print(f'  ✓ {z}/{x}/{y}  {len(data)//1024}KB  '
                              f'({downloaded}/{need - skipped} done, ~{remaining:.0f}m left)    ', end='\r')
                        time.sleep(0.20)   # ~5 req/sec
                        break

                    except urllib.error.HTTPError as e:
                        if e.code == 403:
                            print(f'\n\n⚠️  403 Forbidden at z{z}/{x}/{y}')
                            print('   Tokens have expired. Re-grab from DevTools → Cookie header and re-run.')
                            sys.exit(1)
                        else:
                            if attempt == 2:
                                print(f'\n  ✗ z{z}/{x}/{y}: HTTP {e.code}')
                                failed += 1
                            else:
                                time.sleep(1.5 * (attempt + 1))

                    except Exception as e:
                        if attempt == 2:
                            print(f'\n  ✗ z{z}/{x}/{y}: {e}')
                            failed += 1
                        else:
                            time.sleep(1.5 * (attempt + 1))

        print()  # newline after each zoom level's \r progress

    total_mb = sum(f.stat().st_size for f in out_root.rglob('*.png')) / 1_048_576
    elapsed  = time.time() - start_time

    print(f'\n{"─"*48}')
    print(f'  Downloaded : {downloaded}')
    print(f'  Skipped    : {skipped} (already cached)')
    print(f'  Failed     : {failed}')
    print(f'  Total size : {total_mb:.1f} MB')
    print(f'  Time taken : {elapsed/60:.1f} min')
    print(f'\nTiles saved to: {out_root.resolve()}')
    print('\nNext steps:')
    print('  1. Edit .gitignore — remove the tiles/strava/ exclusion line')
    print('  2. git add tiles/ && git commit -m "add: Strava heatmap tiles (Joplin)" && git push')
    print('  The Strava layer in the map will activate automatically.')

# ── CLI ────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(
        description='Download Strava heatmap tiles for the Joplin, MO area.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument('--cookies',      required=True, metavar='STR',
                   help='Full Cookie header value from DevTools (include _strava4_session and all CloudFront values)')
    p.add_argument('--zoom-min',    type=int, default=12, metavar='N')
    p.add_argument('--zoom-max',    type=int, default=16, metavar='N')
    p.add_argument('--activity',    default='Ride',
                   choices=['All', 'Ride', 'Run', 'Water', 'Winter'])
    p.add_argument('--color',       default='hot',
                   choices=['hot', 'grayscale', 'blue', 'bluered', 'purple', 'gray'])
    p.add_argument('--bbox',        metavar='"S,W,N,E"')
    p.add_argument('--dry-run',     action='store_true')
    args = p.parse_args()

    bbox = DEFAULT_BBOX
    if args.bbox:
        s, w, n, e = [float(v.strip()) for v in args.bbox.split(',')]
        bbox = {'south': s, 'west': w, 'north': n, 'east': e}

    download_tiles(
        cookies  = args.cookies,
        zoom_min = args.zoom_min,
        zoom_max    = args.zoom_max,
        activity    = args.activity,
        color       = args.color,
        bbox        = bbox,
        dry_run     = args.dry_run,
    )

if __name__ == '__main__':
    main()
