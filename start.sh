#!/bin/sh
# Start MoodLens on macOS / Linux, then open it in the default browser.
cd "$(dirname "$0")"
(sleep 1; open http://localhost:8000 2>/dev/null || xdg-open http://localhost:8000) &
python3 serve.py 8000
