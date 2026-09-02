#!/bin/sh
set -eu
cd "$(dirname "$0")"
printf 'KeyWatcher est disponible sur http://localhost:8080/\n'
if command -v open >/dev/null 2>&1; then
  (sleep 1 && open "http://localhost:8080/") &
fi
python3 -m http.server 8080 --bind 127.0.0.1
