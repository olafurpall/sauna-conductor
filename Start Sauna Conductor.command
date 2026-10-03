#!/bin/bash
# Sauna Conductor launcher (macOS). Double-click to start.
# Serves this folder on http://127.0.0.1:8888/ — the address registered as the
# Redirect URI in the Spotify developer app — and opens it in Chrome.
# Keep this window open during the session; close it (or press Ctrl+C) when done.

cd "$(dirname "$0")" || exit 1
PORT=8888
URL="http://127.0.0.1:$PORT/"

open_browser() {
  sleep 1
  if open -Ra "Google Chrome" >/dev/null 2>&1; then
    open -a "Google Chrome" "$URL"
  else
    open "$URL"
  fi
}

# Stop an older Sauna Conductor that may still be running (perhaps from another folder).
PIDS=$(lsof -t -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null)
for pid in $PIDS; do
  cmd=$(ps -p "$pid" -o command= 2>/dev/null)
  case "$cmd" in
    *http.server*|*serve.py*|*serve.pl*|*httpd*)
      echo "Stopping an older Sauna Conductor that was still running…"
      kill "$pid" 2>/dev/null ;;
    *)
      echo "Port $PORT is used by another program:"
      echo "  $cmd"
      echo "Close that program and double-click this launcher again."
      read -r -p "Press Return to close."
      exit 1 ;;
  esac
done
[ -n "$PIDS" ] && sleep 1

echo "Starting Sauna Conductor on $URL"
echo "Folder: $(pwd)"
echo "Leave this window open while the session runs."
echo

# 1) Python 3 (Homebrew, python.org, or Apple's Command Line Tools)
PY=""
for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 /Library/Frameworks/Python.framework/Versions/Current/bin/python3; do
  [ -x "$c" ] && PY="$c" && break
done
if [ -z "$PY" ] && xcode-select -p >/dev/null 2>&1 && [ -x /usr/bin/python3 ]; then PY=/usr/bin/python3; fi
if [ -n "$PY" ]; then
  open_browser &
  exec "$PY" tools/serve.py "$PORT"
fi

# 2) Perl (ships with macOS)
if command -v perl >/dev/null 2>&1; then
  open_browser &
  exec perl tools/serve.pl "$PORT" .
fi

# 3) Ruby
if command -v ruby >/dev/null 2>&1; then
  open_browser &
  exec ruby -run -e httpd . -p "$PORT" -b 127.0.0.1
fi

echo "Could not find Python, Perl or Ruby to run a small local web server."
echo "Install Apple's Command Line Tools by running:  xcode-select --install"
echo "then double-click this launcher again."
read -r -p "Press Return to close."
