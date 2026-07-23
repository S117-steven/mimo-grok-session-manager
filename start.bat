@echo off
chcp 65001 >nul
title MiMo Session Manager

echo.
echo ========================================
echo   MiMo Code Session Manager
echo ========================================
echo.
echo Starting server...
echo.

cd /d "%~dp0"
start "" http://127.0.0.1:3456
node server.js

pause
