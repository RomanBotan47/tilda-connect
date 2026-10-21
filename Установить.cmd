@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Установите Node.js 22 или новее с https://nodejs.org/ и запустите файл снова.
) else (
  node setup.mjs --connect
)
pause
