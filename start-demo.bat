@echo off
REM Remote Inpatient AI - one-click local demo for Windows.
REM Double-click this file. First run installs everything (a few minutes), then the demo opens
REM in your browser at http://localhost:3210 . Close this window to stop the demo.
title Remote Inpatient AI - demo
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Installing Node.js LTS with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo Could not install automatically. Please install Node.js LTS from https://nodejs.org
    echo then double-click start-demo.bat again.
    pause
    exit /b 1
  )
  echo.
  echo Node.js installed. Please CLOSE this window and double-click start-demo.bat again.
  pause
  exit /b 0
)

if not exist ".env" copy ".env.example" ".env" >nul

if not exist "node_modules" (
  echo Installing the demo - first run only, this takes a few minutes...
  call npm install
  if errorlevel 1 (
    echo Installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo Starting the demo... your browser will open at http://localhost:3210
start "" cmd /c "timeout /t 15 >nul & start http://localhost:3210"
call npm run dev
pause
