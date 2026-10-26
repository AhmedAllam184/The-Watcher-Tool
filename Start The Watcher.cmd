@echo off
cd /d "%~dp0"
echo The Watcher - keep this window open while using the app.
start "" "http://127.0.0.1:4173"
call npm.cmd run dev -- --host 127.0.0.1 --port 4173 --strictPort
pause
