@echo off
REM Stops the whole local stack on Windows - the steps are in stop_all.ps1 (same order as stop_all.sh).
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop_all.ps1" %*
