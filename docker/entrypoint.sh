#!/bin/sh
# Virtual screen for the headed browser, then the server.
set -eu

screen="${DISPLAY#:}"
rm -f "/tmp/.X${screen}-lock" "/tmp/.X11-unix/X${screen}"
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp &

# The browser fails if the screen does not exist yet: wait for its socket (5 s at most).
i=0
while [ ! -e "/tmp/.X11-unix/X${screen}" ] && [ "$i" -lt 50 ]; do
    i=$((i + 1))
    sleep 0.1
done

exec node /app/dist/server.js
