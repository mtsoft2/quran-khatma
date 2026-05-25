@echo off
title Quran Juz Tracker
cd /d "%~dp0"

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo Failed to install dependencies. Make sure Node.js is installed.
        pause
        exit /b 1
    )
)

echo.
echo ========================================
echo   Quran Juz Tracker
echo ========================================
echo   Local:  http://localhost:3000
echo   Admin:  http://localhost:3000/admin
echo.
echo   Press Ctrl+C to stop the server
echo ========================================
echo.

start "" http://localhost:3000
node server.js

pause
