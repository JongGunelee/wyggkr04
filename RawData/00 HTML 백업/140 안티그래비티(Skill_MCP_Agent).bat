@echo off
setlocal
cd /d "%~dp0"

title Antigravity_Launcher_v4.3
color 0A

:: Initialize
taskkill /F /IM node.exe >nul 2>&1

echo ===================================================
echo   ANTIGRAVITY SYSTEM STARTING...
echo ===================================================

:: Run Dashboard
for %%f in ("140*.html") do (
    start "" "%%~f"
)

:: Run Backend Engine
:loop
for %%f in ("140*.js") do (
    echo [*] Launching: %%~f
    node "%%~f"
)

echo.
echo [WARN] Server stopped. Restarting in 3s...
timeout /t 3 >nul
goto loop
