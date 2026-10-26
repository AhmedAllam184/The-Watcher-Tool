@echo off
cd /d "%~dp0"
rem Dev mode: slower to start, but includes the POWER UP panel that saves API keys
rem into .env. For the fast production build use Start The Watcher.cmd instead.
echo The Watcher (dev mode) - keep this window open while using the app.
start "" "http://127.0.0.1:4173"
call npm.cmd run dev -- --host 127.0.0.1 --port 4173 --strictPort
pause
