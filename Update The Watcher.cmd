@echo off
rem Pull the latest version of The Watcher and reinstall dependencies.
rem Close "Start The Watcher" first: npm ci cannot replace files a running app holds.
cd /d "%~dp0"
set BRANCH=claude/upbeat-volta-volh6b
echo Updating The Watcher from GitHub (%BRANCH%)...
git fetch origin %BRANCH% || goto :fail
git checkout %BRANCH% || goto :fail
git pull --ff-only origin %BRANCH% || goto :fail
echo Installing dependencies...
call npm.cmd ci || goto :fail
echo.
echo Updated. Double-click "Start The Watcher.cmd" to run it (the first start rebuilds, about 15 s).
pause
exit /b 0

:fail
echo.
echo Update failed - see the message above. If git mentions local changes, run: git status
pause
exit /b 1
