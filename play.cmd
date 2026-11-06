@echo off
chcp 65001 >nul
node "%~dp0player.js" %*
rem pause on error so the window does not vanish on a first run (normal quit via q exits 0)
if errorlevel 1 pause
