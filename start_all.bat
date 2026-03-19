@echo off
setlocal
chcp 65001 >nul

set "PY=F:\qwen_asr\qwen_asr_env\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo [info] Python: %PY%
"%PY%" "%~dp0one_click_start.py"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [warn] launcher exit code: %EXIT_CODE%
  echo [hint] please check the newly opened service windows
)

echo.
echo [info] App: http://127.0.0.1:3000
pause
endlocal
