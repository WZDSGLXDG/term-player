@echo off
setlocal
rem Rebind the "tp" command to THIS folder. Run it again after moving or renaming the folder.
rem It only rewrites %USERPROFILE%\.local\bin\tp.cmd - nothing else on the system is touched.
set "BIN=%USERPROFILE%\.local\bin"
set "PROJ=%~dp0"
if "%PROJ:~-1%"=="\" set "PROJ=%PROJ:~0,-1%"
if not exist "%PROJ%\player.js" goto noplayer
if not exist "%BIN%" mkdir "%BIN%"
>  "%BIN%\tp.cmd" echo @echo off
>> "%BIN%\tp.cmd" echo rem term-player launcher, written by install-tp.cmd - edit install-tp.cmd instead
>> "%BIN%\tp.cmd" echo chcp 65001 ^>nul
>> "%BIN%\tp.cmd" echo node "%PROJ%\player.js" %%*
echo [ok] tp  -^>  "%PROJ%\player.js"
echo Now type "tp" in any terminal. Args pass through, e.g. tp --mode shuffle
exit /b 0

:noplayer
echo [error] player.js not found next to this script: "%PROJ%\player.js"
exit /b 1
