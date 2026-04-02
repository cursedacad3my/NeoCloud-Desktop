@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "DOCKER_EXE=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
set "DOCKER_DESKTOP_EXE=C:\Program Files\Docker\Docker\Docker Desktop.exe"

if not exist "%DOCKER_EXE%" (
  echo [ERROR] Docker is not installed: %DOCKER_EXE%
  exit /b 1
)

if exist "%DOCKER_DESKTOP_EXE%" (
  start "" "%DOCKER_DESKTOP_EXE%"
)

for /L %%i in (1,1,90) do (
  "%DOCKER_EXE%" info >nul 2>&1 && goto :docker_ready
  ping -n 3 127.0.0.1 >nul
)

echo [ERROR] Docker engine is not ready.
exit /b 1

:docker_ready
"%DOCKER_EXE%" compose -f "%SCRIPT_DIR%docker-compose-prod.yml" --env-file "%SCRIPT_DIR%.env" up -d
exit /b %errorlevel%
