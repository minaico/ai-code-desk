@echo off
REM Double-click this after a reboot or a power cut.
REM -ExecutionPolicy Bypass so it works on a machine that never had the policy
REM relaxed - the alternative is a red error and no app.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0resume.ps1" %*
echo.
pause
