@echo off
chcp 65001 >nul
title VoiceLink
if not exist node_modules (
  echo Первая установка VoiceLink...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
echo VoiceLink запускается...
start "" http://localhost:3000
call npm start
pause
