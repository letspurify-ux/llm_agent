@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-backend

tasklist /FI "WINDOWTITLE eq %TITLE%" 2>NUL | find /I "cmd.exe" >NUL
if errorlevel 1 (
  echo [backend] 실행 중인 프로세스를 찾지 못했습니다.
  exit /b 0
)

REM /T: 창 안에서 실행 중인 node.exe 자식 프로세스까지 함께 종료한다.
REM /F: 강제 종료 - Windows는 콘솔 프로세스에 SIGTERM을 신뢰성 있게 전달할 방법이 없어
REM     server.js의 정상 종료 경로(SIGTERM 핸들러)를 태우지 못한다. macOS/Linux는 stop.sh를 쓸 것.
taskkill /FI "WINDOWTITLE eq %TITLE%" /T /F >NUL

echo [backend] 종료했습니다.
