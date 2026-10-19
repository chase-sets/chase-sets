@echo off
setlocal
if /I not "%~1"=="-c" exit /b 64
call "__POWERSHELL_PATH__" -NoProfile -NonInteractive %*
exit /b %ERRORLEVEL%
