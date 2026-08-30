@echo off
setlocal
cd /d "%~dp0"
set TITLE=llm_agent-frontend

tasklist /FI "WINDOWTITLE eq %TITLE%" 2>NUL | find /I "cmd.exe" >NUL
if errorlevel 1 (
  echo [frontend] 실행 중인 프로세스를 찾지 못했습니다.
  exit /b 0
)

taskkill /FI "WINDOWTITLE eq %TITLE%" /T /F >NUL

echo [frontend] 종료했습니다.
