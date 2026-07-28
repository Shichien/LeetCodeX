@echo off
setlocal
cd /d "%~dp0"
"%~dp0leetcodex.exe" run %*
set "status=%errorlevel%"
if not "%status%"=="0" (
  echo.
  echo Leetcodex failed with exit code %status%. Review the error above.
  pause
)
exit /b %status%
