@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-frontend

tasklist /FI "WINDOWTITLE eq %TITLE%*" 2>NUL | find /I "cmd.exe" >NUL
if not errorlevel 1 (
  echo [frontend] 이미 실행 중입니다 - stop.bat으로 먼저 종료하세요.
  exit /b 0
)

if not exist node_modules (
  echo [frontend] node_modules가 없어 npm install을 실행합니다.
  call npm install
  if errorlevel 1 exit /b 1
)

if not exist logs mkdir logs

REM 창 제목(%TITLE%)으로 이 프로세스를 식별한다 - stop.bat이 같은 제목으로 찾아 종료한다.
REM cmd는 명령을 실행하는 동안 창 제목 뒤에 " - <명령>"을 덧붙이므로, 제목 판별(위와 stop.bat)은
REM 완전 일치가 아니라 접두 일치("%TITLE%*")로 한다 - 완전 일치는 vite가 도는 내내 빗나간다.
REM npm run dev가 아니라 vite를 직접 실행한다 - npm 래퍼를 거치면 taskkill이 npm만 죽이고
REM 실제 vite 프로세스는 남을 수 있다.
REM 로그는 덮어쓰지 않고 이어 쓴다(>>) - 덮어쓰면 재기동 순간 직전 실행의 크래시 원인이 사라진다.
echo ===== %date% %time% 시작 =====>> logs\frontend.log
start "%TITLE%" /min cmd /c "node node_modules\vite\bin\vite.js >> logs\frontend.log 2>&1"

echo [frontend] 시작했습니다 - 접속 주소는 logs\frontend.log에서 확인
echo [frontend] 종료하려면 stop.bat을 실행하세요.
