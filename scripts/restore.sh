#!/usr/bin/env bash
# Restore a tarball produced by scripts/backup.sh.
#
# If the container is running, stop it first so the restore can't race
# ongoing writes. Ask the operator to confirm before overwriting the
# current data/state.sqlite. Restart the container at the end if we
# stopped it.
#
# Usage: scripts/restore.sh <archive.tar.gz>
set -euo pipefail

# See backup.sh for why this is needed on Git Bash.
export MSYS_NO_PATHCONV=1

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <archive.tar.gz>" >&2
  exit 2
fi
ARCHIVE="$1"
if [ ! -f "$ARCHIVE" ]; then
  echo "not a file: $ARCHIVE" >&2
  exit 2
fi

STAGING="$(mktemp -d)"
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

echo "restore: extracting $ARCHIVE..."
tar -xzf "$ARCHIVE" -C "$STAGING"

if [ ! -f "$STAGING/state.sqlite" ]; then
  echo "archive is missing state.sqlite; refusing to restore" >&2
  exit 3
fi

echo "restore: archive manifest:"
if [ -f "$STAGING/manifest.txt" ]; then
  sed 's/^/  /' "$STAGING/manifest.txt"
else
  echo "  (no manifest)"
fi

if [ -f data/state.sqlite ]; then
  read -r -p "overwrite existing data/state.sqlite? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "aborted."; exit 0 ;;
  esac
fi

STOPPED=0
if [ "$(docker inspect -f '{{.State.Running}}' auto-reviewer 2>/dev/null || echo false)" = "true" ]; then
  echo "restore: stopping container to avoid racing writes..."
  docker compose stop auto-reviewer
  STOPPED=1
fi

mkdir -p data
cp "$STAGING/state.sqlite" data/state.sqlite
# Wipe any WAL/SHM leftover from the prior container life. The restored
# state.sqlite is the authoritative truth on next open; stale WAL files
# would confuse sqlite.
rm -f data/state.sqlite-wal data/state.sqlite-shm

if [ -f "$STAGING/config.yaml" ]; then
  cp "$STAGING/config.yaml" config.yaml
  echo "restore: config.yaml restored"
fi

if [ "$STOPPED" = "1" ]; then
  echo "restore: starting container..."
  docker compose start auto-reviewer
fi

echo "restore: done. New storage state should appear on the Dashboard within 5s."
