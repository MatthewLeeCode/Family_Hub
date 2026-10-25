@echo off
rem Unpack a Family Hub setup file (Admin, Hub, Setup file) into this folder.
rem Needs only Docker Desktop. Asks for the passphrase. An existing .env is kept as .env.before-restore.
rem Usage: put the setup file in the Family Hub folder, then run
rem   scripts\restore-setup.bat family-hub-setup-2026-10-25.zip
setlocal
cd /d "%~dp0.."
if "%~1"=="" goto usage
if not exist "%~nx1" goto usage

docker build -q -t family-hub-restore . >nul || exit /b 1
docker run --rm -it -v "%cd%:/restore" family-hub-restore python -m bookhub.setupfile restore "/restore/%~nx1" /restore
exit /b %errorlevel%

:usage
echo Put the setup file in %cd% and run: scripts\restore-setup.bat SETUP-FILE
exit /b 2
