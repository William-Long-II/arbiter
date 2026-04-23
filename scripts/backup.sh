#!/usr/bin/env bash
# Back up the auto-reviewer's durable state into a single tarball.
#
# Captures:
#   state.sqlite    — online-safe snapshot via SQLite VACUUM INTO when the
#                     container is running; plain copy otherwise
#   config.yaml     — present only if the operator uses YAML bootstrap
#   manifest.txt    — timestamp, image tag, git sha
#
# Deliberately does NOT capture .env or ~/.claude — those are secrets the
# operator manages independently.
#
# Usage: scripts/backup.sh [output-dir]   (default: ./backups)
set -euo pipefail

# MSYS (Git Bash on Windows) rewrites Linux-style absolute paths before they
# reach docker.exe — "/app/scripts/backup-db.ts" becomes
# "C:/Program Files/Git/app/scripts/backup-db.ts", which doesn't exist
# inside the container. Disable that conversion for the scripts that pass
# in-container paths through. No-op on Linux/Mac.
export MSYS_NO_PATHCONV=1

OUT_DIR="${1:-backups}"
mkdir -p "$OUT_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="$(mktemp -d)"
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

# Is the container running? Use docker inspect because it's portable across
# `docker compose ps` flag variations.
is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' auto-reviewer 2>/dev/null || echo false)" = "true" ]
}

if is_running; then
  echo "backup: container running — online snapshot via VACUUM INTO"
  INFLIGHT_NAME="backup-inflight-${TIMESTAMP}.sqlite"
  # Write into the bind-mounted /app/data so we can see it from the host,
  # then move it into the staging tarball.
  docker compose exec -T auto-reviewer \
    bun run /app/scripts/backup-db.ts "/app/data/${INFLIGHT_NAME}"
  mv "data/${INFLIGHT_NAME}" "$STAGING/state.sqlite"
else
  echo "backup: container stopped — copying file directly"
  if [ ! -f data/state.sqlite ]; then
    echo "no data/state.sqlite present; nothing to back up" >&2
    exit 1
  fi
  cp data/state.sqlite "$STAGING/state.sqlite"
fi

if [ -f config.yaml ]; then
  cp config.yaml "$STAGING/config.yaml"
fi

{
  echo "timestamp=$TIMESTAMP"
  echo "image=$(docker compose images auto-reviewer --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | tail -n1)"
  echo "git=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "host=$(hostname)"
} > "$STAGING/manifest.txt"

ARCHIVE="$OUT_DIR/auto-reviewer-${TIMESTAMP}.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGING" .

# Portable size reporting (ls -l width varies across BSD/GNU).
SIZE="$(wc -c < "$ARCHIVE" | tr -d ' ')"
echo "backup: wrote $ARCHIVE (${SIZE} bytes)"
