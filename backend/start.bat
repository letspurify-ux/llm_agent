@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-backend

tasklist /FI "WINDOWTITLE eq %TITLE%*" 2>NUL | find /I "cmd.exe" >NUL
if not errorlevel 1 (
  echo [backend] already running - stop it first with stop.bat.
  exit /b 0
)

if not exist node_modules (
  echo [backend] node_modules not found - running npm install.
  call npm install
  if errorlevel 1 exit /b 1
)

if not exist logs mkdir logs

REM The process is identified by its window title (%TITLE%) - stop.bat finds and kills it by
REM the same title. While cmd is running a command it appends " - <command>" to the title, so
REM the title checks (above and in stop.bat) use a prefix match ("%TITLE%*") - an exact match
REM would miss the window the whole time the server is running.
REM /min: keeps a minimized console on the taskbar (fully hiding it would leave no way to find
REM the process to kill without its PID).
REM Append to the log (>>) instead of overwriting - overwriting on restart erases the crash
REM cause of the previous run.
REM ensure-env output also goes to the log - if it fails, the minimized window closes silently
REM and the cause would otherwise be recorded nowhere.
echo ===== %date% %time% start =====>> logs\backend.log
start "%TITLE%" /min cmd /c "node scripts\ensure-env.js >> logs\backend.log 2>&1 && node src\server.js >> logs\backend.log 2>&1"

echo [backend] started - log: logs\backend.log
echo [backend] run stop.bat to stop it.
