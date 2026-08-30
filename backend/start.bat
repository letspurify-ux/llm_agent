@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-backend

tasklist /FI "WINDOWTITLE eq %TITLE%" 2>NUL | find /I "cmd.exe" >NUL
if not errorlevel 1 (
  echo [backend] 이미 실행 중입니다 - stop.bat으로 먼저 종료하세요.
  exit /b 0
)

if not exist node_modules (
  echo [backend] node_modules가 없어 npm install을 실행합니다.
  call npm install
  if errorlevel 1 exit /b 1
)

if not exist logs mkdir logs

REM 창 제목(%TITLE%)으로 이 프로세스를 식별한다 - stop.bat이 같은 제목으로 찾아 종료한다.
REM /min: 작업 표시줄에만 최소화된 콘솔로 남는다 (완전히 숨기면 PID 없이는 종료 대상을 찾을 수 없다).
start "%TITLE%" /min cmd /c "node scripts\ensure-env.js && node src\server.js > logs\backend.log 2>&1"

echo [backend] 시작했습니다 - 로그: logs\backend.log
echo [backend] 종료하려면 stop.bat을 실행하세요.
