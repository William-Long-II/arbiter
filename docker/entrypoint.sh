#!/usr/bin/env bash
# Auto-Reviewer container entrypoint.
#
# Runs as root on start so it can fix ownership on /app/data — a fresh bind
# mount is often root-owned by Docker, which locks the non-root `bun` user
# out of creating the sqlite file (SQLITE_CANTOPEN). Once data is writable
# by UID 1000, gosu drops to the bun user and exec's the real command.
#
# Host-side remedies that ALSO fix this (so operators who prefer not to run
# anything as root at boot can choose either):
#   chown -R 1000:1000 ./data   # match the container's bun user
#   OR
#   start with a volume that's already writable by UID 1000
set -euo pipefail

DATA_DIR=/app/data
TARGET_USER=bun
TARGET_UID=1000
TARGET_GID=1000

mkdir -p "$DATA_DIR"

# Report state for the startup log so operators can tell what happened.
current_owner="$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null || echo 'unknown')"
if [ "$current_owner" != "${TARGET_UID}:${TARGET_GID}" ]; then
  echo "entrypoint: $DATA_DIR owned by $current_owner; chowning to ${TARGET_USER} (${TARGET_UID}:${TARGET_GID})" >&2
  if ! chown -R "${TARGET_UID}:${TARGET_GID}" "$DATA_DIR" 2>/dev/null; then
    echo "entrypoint: WARN chown failed (read-only mount?). Proceeding; sqlite open will fail with SQLITE_CANTOPEN if the dir isn't writable by UID ${TARGET_UID}." >&2
  fi
else
  echo "entrypoint: $DATA_DIR already owned by ${TARGET_USER}; no chown needed" >&2
fi

# Drop to the non-root user and exec the real CMD.
exec gosu "$TARGET_USER" "$@"
