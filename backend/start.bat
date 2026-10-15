@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-backend
set BINARY=target\release\llm-agent.exe
set UI=..\frontend

tasklist /FI "WINDOWTITLE eq %TITLE%*" 2>NUL | find /I "cmd.exe" >NUL
if not errorlevel 1 (
  echo [backend] already running - stop it first with stop.bat.
  exit /b 0
)

REM The binary carries the screen (build.rs embeds ..\frontend\dist), so the screen is built
REM first: when it is missing or older than a frontend source file. Without npm the existing
REM dist (or a prebuilt binary) is used.
set NEED_UI=0
if not exist %UI%\dist\index.html set NEED_UI=1
if %NEED_UI%==0 powershell -NoProfile -Command "$built = (Get-Item '%UI%\dist\index.html').LastWriteTime; $newer = Get-ChildItem '%UI%\src','%UI%\index.html','%UI%\package.json','%UI%\vite.config.js','%UI%\mermaid-math-adapter.mjs' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $built } | Select-Object -First 1; if ($newer) { exit 1 }" || set NEED_UI=1
where npm >NUL 2>&1
if errorlevel 1 set NEED_UI=0
if %NEED_UI%==1 (
  echo [backend] building the screen - npm run build in frontend
  pushd %UI%
  if not exist node_modules call npm ci
  call npm run build
  if errorlevel 1 (
    popd
    echo [backend] building the screen failed - see the npm output above.
    exit /b 1
  )
  popd
)
if not exist %UI%\dist\index.html if not exist %BINARY% (
  echo [backend] frontend\dist not found and npm is not installed - install Node.js or copy a prebuilt binary to %BINARY%.
  exit /b 1
)

REM Build the release binary when cargo is available (cargo rebuilds only what changed);
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
