@echo off
setlocal
echo ========================================================
echo   Icon Pack Forge (app-icon-generator)
echo   Kitsune Technologies LLC
echo ========================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js was not found on your system.
    echo Please install Node.js (v18+) from https://nodejs.org/
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies (sharp, express, archiver)...
    call npm install --omit=dev
)

echo Starting Icon Pack Forge at http://localhost:8792 ...
start http://localhost:8792
node server.js
pause
