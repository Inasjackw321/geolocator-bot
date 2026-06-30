@echo off
REM Double-click this on Windows to open Geolink.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found.
  echo Install it from https://nodejs.org and then open this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First launch: installing dependencies (this can take a minute)...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting Geolink...
call npm start
