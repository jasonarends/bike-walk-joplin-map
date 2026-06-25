#!/usr/bin/env bash
#
# Cron-driven refresh of data/crashes.geojson.
#
# Usage (manual):
#   scripts/update_crashes.sh                 # default fetch_crashes.py args
#   scripts/update_crashes.sh --since 2018-01-01
#
# Usage (cron):
#   15 4 * * 1,4  cd ~/repos/bike-walk-joplin-map && scripts/update_crashes.sh >> ~/bwj-update.log 2>&1
#
# What it does:
#   1. git pull --ff-only  (so we never push on top of someone else's changes)
#   2. run scripts/fetch_crashes.py with any args you pass through
#   3. if data/crashes.geojson actually changed, commit + push
#   4. ping the Supabase REST API to reset the 7-day inactivity timer
#
# Exit codes:
#   0 success (with or without a data change)
#   non-zero if the fetch, git, or supabase steps fail

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────
# Publishable Supabase creds — already public in app.js, safe to embed here.
SUPABASE_URL="${SUPABASE_URL:-https://fyqgkqmabbzgufdzrzzy.supabase.co}"
SUPABASE_KEY="${SUPABASE_KEY:-sb_publishable_bG7sx_kuaCwefhByYTB80Q_rsNE5gbX}"

# ── Setup ─────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "=== bwj update starting in $REPO_ROOT ==="

# ── 1. Sync ───────────────────────────────────────────────────────────────
log "git pull --ff-only"
git pull --ff-only

# ── 2. Fetch ──────────────────────────────────────────────────────────────
log "running fetch_crashes.py $*"
python3 scripts/fetch_crashes.py "$@"

# ── 3. Commit + push if data changed ──────────────────────────────────────
if git diff --quiet -- data/crashes.geojson; then
  log "no changes to data/crashes.geojson"
else
  log "data/crashes.geojson changed — committing"
  git add data/crashes.geojson
  git commit -m "data: refresh crashes.geojson ($(date -u +%Y-%m-%d))"
  git push
  log "pushed"
fi

# ── 4. Supabase keepalive ─────────────────────────────────────────────────
log "pinging Supabase to reset inactivity timer"
http_status=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  "$SUPABASE_URL/rest/v1/reports?select=id&limit=1")

if [[ "$http_status" =~ ^2 ]]; then
  log "supabase ping ok ($http_status)"
else
  log "WARN: supabase ping returned $http_status"
fi

log "=== done ==="
