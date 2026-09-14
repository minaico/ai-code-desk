#!/usr/bin/env bash
#
# Start the PTY host on a Linux machine so a Web Terminal running elsewhere can
# open shells on it. This machine runs no web server and opens no port 8080 —
# only the PTY host on TCP 8777.
#
#   ./scripts/start-remote-host.sh                 foreground, prints the key
#   ./scripts/start-remote-host.sh --port 9777     a different port
#   ./scripts/start-remote-host.sh --bind 127.0.0.1   local only (the default is
#                                                     0.0.0.0, which is the
#                                                     point of a remote host)
#
# The link between machines is authenticated but not encrypted. LAN or VPN only.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PTY_HOST_PORT:-8777}"
BIND="${PTY_HOST_BIND:-0.0.0.0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m[ok]\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31m[fail]\033[0m %s\n' "$1" >&2; }
head() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

head "1/4 Node"
if ! command -v node > /dev/null 2>&1; then
  fail "node is not on PATH."
  say "Install Node 18 or newer, then run this again."
  exit 1
fi
ok "$(node --version)  ($(command -v node))"

head "2/4 Dependencies"
# node-pty is a native module: it is compiled for the machine it runs on, so a
# tree copied from another machine will not do. Say that plainly rather than
# letting every session creation fail with a stack trace.
if ! node -e 'require("node-pty")' > /tmp/wt-pty-check.$$ 2>&1; then
  fail "node-pty does not load on this machine."
  sed 's/^/    /' /tmp/wt-pty-check.$$ | head -5
  rm -f /tmp/wt-pty-check.$$
  say ""
  say "It is a native module and has to be built here:"
  say "  sudo apt install -y build-essential python3   # Debian/Ubuntu"
  say "  npm ci"
  exit 1
fi
rm -f /tmp/wt-pty-check.$$
ok "node-pty loads"

head "3/4 Shells"
FOUND=$(node -e '
  const p = require("./server/profiles");
  const list = p.availableProfiles();
  if (!list.length) process.exit(1);
  console.log(list.map((s) => s.id + " -> " + s.exe).join("\n"));
') || {
  fail "No usable shell found (looked for bash, zsh, sh)."
  exit 1
}
printf '%s\n' "$FOUND" | while IFS= read -r line; do ok "$line"; done

head "4/4 PTY host"
if command -v ss > /dev/null 2>&1 && ss -ltn "sport = :$PORT" | grep -q LISTEN; then
  # Never report success because something answers on the port. A host that is
  # already there belongs to someone else, and its sessions are somebody's
  # running work.
  fail "port $PORT is already in use."
  say "Stop the existing host deliberately, or pick another port with --port."
  exit 1
fi

say "Addresses on this machine:"
if command -v ip > /dev/null 2>&1; then
  ip -4 -o addr show scope global | awk '{print "    " $2 "  " $4}'
fi
say ""
say "Machine key — paste this into 🖧 Máy on the controlling machine:"
printf '\n    %s\n\n' "$(node scripts/host-key.js)"

if command -v ufw > /dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "ufw is active. To let the controlling machine in:"
  say "  sudo ufw allow from 192.168.192.0/24 to any port $PORT proto tcp"
  say ""
fi

say "Listening on $BIND:$PORT. Ctrl+C stops the host and every session on it."
say ""
PTY_HOST_BIND="$BIND" PTY_HOST_PORT="$PORT" exec node server/pty-host.js
