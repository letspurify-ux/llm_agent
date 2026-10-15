@echo off
REM Starts the whole local stack on Windows - the steps are in start_all.ps1 (same order as start_all.sh).
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_all.ps1" %*
