@echo off
rem Voice assistant. Double-click, or run from a terminal with options:
rem   start.cmd                  Wispr Flow: hold Ctrl+Win, ask, let go, press Enter
rem   start.cmd -Ears windows    Windows speech recognition, hands-free
rem   start.cmd -Typed           type questions, hear the answers
rem   start.cmd -Typed -NoSpeak  text only
cd /d "%~dp0"
if not exist ".env" (
  echo No .env file found. Copy .env.example to .env and add your OpenRouter key.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0voice\assistant.ps1" %*
if errorlevel 1 pause
