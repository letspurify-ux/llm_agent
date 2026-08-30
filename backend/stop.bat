@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-backend

REM Prefix match ("%TITLE%*") - while cmd is running a command it appends " - <command>" to
REM the window title, so an exact match would miss the window the whole time the server is
REM running (same rule as start.bat).
tasklist /FI "WINDOWTITLE eq %TITLE%*" 2>NUL | find /I "cmd.exe" >NUL
if errorlevel 1 (
  echo [backend] no running process found.
  exit /b 0
)

REM /T: also kills the child node.exe processes running inside the window.
REM /F: force kill - Windows has no reliable way to deliver SIGTERM to a console process,
REM     so the graceful-shutdown path in server.js (SIGTERM handler) cannot be used here.
REM     Use stop.sh on macOS/Linux for a graceful stop.
taskkill /FI "WINDOWTITLE eq %TITLE%*" /T /F >NUL

echo [backend] stopped.
