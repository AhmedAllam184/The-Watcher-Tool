#!/bin/sh
# Start The Watcher in hosted mode. Every start first picks up the newest
# pushed version, so restarting the Space is how it updates.
set -eu
cd /home/node/app
branch="${WATCHER_BRANCH:-claude/upbeat-volta-volh6b}"

if git fetch --depth 1 origin "$branch"; then
  before="$(git rev-parse HEAD:package-lock.json)"
  git reset --hard FETCH_HEAD
  after="$(git rev-parse HEAD:package-lock.json)"
  if [ "$before" != "$after" ]; then
    npm ci --no-audit --no-fund
  fi
else
  echo "Could not reach GitHub; starting the version already in the image."
fi
echo "The Watcher $(git rev-parse --short HEAD) - building with this Space's keys..."

# The browser keys are compiled into the page here, from the Space secrets,
# so they never sit in the image or the repository. The build also checks the
# sign-in settings and stops if they are missing or weak.
node node_modules/vite/bin/vite.js build
exec node node_modules/vite/bin/vite.js preview \
  --host 0.0.0.0 --port "${PORT:-7860}" --strictPort
