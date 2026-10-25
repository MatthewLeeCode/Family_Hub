@echo off
rem Try Family Hub with a small sample library. Needs Python 3.10 or newer
rem from https://www.python.org (tick "Add Python to PATH" when installing).
setlocal
cd /d "%~dp0.."

where py >nul 2>nul
if %errorlevel%==0 (set PY=py -3) else (set PY=python)

if not exist .venv (
  %PY% -m venv .venv
  if errorlevel 1 goto :fail
)
call .venv\Scripts\activate.bat
pip install --quiet -r app\requirements.txt
if errorlevel 1 goto :fail
cd app
python -m bookhub --demo --demo-dir ..\demo %*
goto :eof

:fail
echo.
echo Could not start. Check that Python is installed and on your PATH.
pause
