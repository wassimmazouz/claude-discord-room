#!/usr/bin/env bash
# Starts the room, then opens each agent that's waiting at a startup prompt.
# You answer the prompts yourself. This script never presses a key for you.
#
#   ./room.sh           start the room (agents already running stay up)
#   ./room.sh restart   stop first, so config changes take effect
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

case "${1:-start}" in
  start) ;;
  restart) bun room.ts stop ;;
  *) echo "Usage: ./room.sh [restart]" >&2; exit 1 ;;
esac
bun room.ts start

screen() { tmux capture-pane -p -t "=room-$1:" 2>/dev/null || true; }
waiting() { screen "$1" | grep -q 'Enter to confirm'; }

# Gives a new session time to draw its prompt, or its normal input box.
settle() {
  for _ in $(seq 40); do
    screen "$1" | grep -qE 'Enter to confirm|shift\+tab' && return
    sleep 0.5
  done
}

agents=$(bun room.ts status | sed -n 's/: running$//p')

for name in $agents; do
  settle "$name"
  waiting "$name" || continue
  if [ ! -t 0 ] || [ -n "${TMUX:-}" ]; then
    echo "• $name is waiting. Run: tmux attach -t room-$name"
    continue
  fi
  echo "→ $name: choose \"I am using this for local development\" and press Enter."
  sleep 1
  # Returns you here once the prompt is gone. Ctrl-b d also works.
  ( while waiting "$name"; do sleep 0.5; done
    sleep 1
    waiting "$name" || tmux detach-client -s "=room-$name" ) &
  watcher=$!
  tmux attach -t "=room-$name" >/dev/null || true
  kill "$watcher" 2>/dev/null || true
done

sleep 3
stuck=0
for name in $agents; do
  if waiting "$name"; then
    echo "• $name is still at a prompt. Run ./room.sh again."
    stuck=1
  fi
done
total=$(wc -w <<<"$agents")
servers=$(pgrep -fc 'bun run .*channel/server\.ts' || true)
echo "Channel servers running: $servers of $total"
[ "$stuck" = 0 ] && [ "$servers" = "$total" ] && echo "✓ Room is up."
exit 0
