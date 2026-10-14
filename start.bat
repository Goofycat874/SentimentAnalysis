@echo off
cd /d "%~dp0"
echo Starting MoodLens at http://localhost:8000
start "" http://localhost:8000
python serve.py 8000
