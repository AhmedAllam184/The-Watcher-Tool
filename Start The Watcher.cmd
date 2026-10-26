@echo off
cd /d "%~dp0"
echo The Watcher - keep this window open while using the app.
call npm.cmd start
pause
