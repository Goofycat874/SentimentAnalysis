@echo off
echo Starting MoodLens at http://localhost:8000
start "" http://localhost:8000
python -m http.server 8000
