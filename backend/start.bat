@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-backend
set BINARY=target\release\llm-agent.exe

tasklist /FI "WINDOWTITLE eq %TITLE%*" 2>NUL | find /I "cmd.exe" >NUL
if not errorlevel 1 (
  echo [backend] already running - stop it first with stop.bat.
  exit /b 0
)

REM Build the release binary when cargo is available (cargo rebuilds only what changed, and
REM build.rs runs npm run build in ..\frontend when the screen sources changed);
REM otherwise a prebuilt binary must be at %BINARY% (copied from a build machine). The Oracle
REM Instant Client folder is set in the admin screen's settings tab (or put it on PATH).
where cargo >NUL 2>&1
if not errorlevel 1 (
  echo [backend] building the release binary - cargo build --release
  cargo build --release
  if errorlevel 1 exit /b 1
)
if not exist %BINARY% (
  echo [backend] %BINARY% not found and cargo is not installed - install Rust or copy a prebuilt binary.
  exit /b 1
)

if not exist logs mkdir logs

REM The process is identified by its window title (%TITLE%) - stop.bat finds and kills it by
REM the same title (prefix match: cmd appends " - <command>" while a command runs).
REM Append to the log (>>) so a restart keeps the previous run's crash cause.
echo ===== %date% %time% start =====>> logs\backend.log
start "%TITLE%" /min cmd /c "%BINARY% >> logs\backend.log 2>&1"

echo [backend] started - the screen and the API share its address - log: logs\backend.log
echo [backend] run stop.bat to stop it.
