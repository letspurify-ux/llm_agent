@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-frontend

tasklist /FI "WINDOWTITLE eq %TITLE%*" 2>NUL | find /I "cmd.exe" >NUL
if not errorlevel 1 (
  echo [frontend] already running - stop it first with stop.bat.
  exit /b 0
)

if not exist node_modules (
  echo [frontend] node_modules not found - running npm install.
  call npm install
  if errorlevel 1 exit /b 1
)

if not exist logs mkdir logs

REM The process is identified by its window title (%TITLE%) - stop.bat finds and kills it by
REM the same title. While cmd is running a command it appends " - <command>" to the title, so
REM the title checks (above and in stop.bat) use a prefix match ("%TITLE%*") - an exact match
REM would miss the window the whole time vite is running.
REM Run vite directly instead of npm run dev - through the npm wrapper, taskkill could end up
REM killing only npm while the actual vite process keeps running.
REM Append to the log (>>) instead of overwriting - overwriting on restart erases the crash
REM cause of the previous run.
echo ===== %date% %time% start =====>> logs\frontend.log
start "%TITLE%" /min cmd /c "node node_modules\vite\bin\vite.js >> logs\frontend.log 2>&1"

echo [frontend] started - see logs\frontend.log for the URL
echo [frontend] run stop.bat to stop it.
