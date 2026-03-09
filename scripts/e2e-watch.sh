#!/usr/bin/env bash
# Usage: yarn test:e2e:watch [grep]
# Watches src/ui/client for changes, rebuilds, and runs e2e snapshot tests.
# If a grep pattern is provided, only matching tests run; otherwise all e2e tests run.

GREP="${1:-}"
if [ -n "$GREP" ]; then
  CMD="vite build && playwright test --update-snapshots -g $GREP"
else
  CMD="vite build && playwright test --update-snapshots"
fi

exec npx chokidar "src/ui/client/**/*" -c "$CMD" --initial --kill
