@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-frontend

REM Prefix match ("%TITLE%*") - while cmd is running a command it appends " - <command>" to
REM the window title, so an exact match would miss the window the whole time vite is running
REM (same rule as start.bat).
tasklist /FI "WINDOWTITLE eq %TITLE%*" 2>NUL | find /I "cmd.exe" >NUL
if errorlevel 1 (
  echo [frontend] no running process found.
  exit /b 0
)

taskkill /FI "WINDOWTITLE eq %TITLE%*" /T /F >NUL

echo [frontend] stopped.
