@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-frontend

REM 접두 일치("%TITLE%*")로 찾는다 - cmd는 명령을 실행하는 동안 창 제목 뒤에 " - <명령>"을
REM 덧붙이므로 완전 일치는 vite가 도는 내내 빗나간다 (start.bat과 같은 기준).
tasklist /FI "WINDOWTITLE eq %TITLE%*" 2>NUL | find /I "cmd.exe" >NUL
if errorlevel 1 (
  echo [frontend] 실행 중인 프로세스를 찾지 못했습니다.
  exit /b 0
)

taskkill /FI "WINDOWTITLE eq %TITLE%*" /T /F >NUL

echo [frontend] 종료했습니다.
