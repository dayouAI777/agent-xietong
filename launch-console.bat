@echo off
setlocal
rem 用脚本自身所在目录，换机器/换路径都不用改
set APP=%~dp0agent-console
cd /d "%APP%"

rem already running? just open the dashboard
netstat -ano | findstr /C:"127.0.0.1:7788" | findstr /C:"LISTENING" >nul
if %errorlevel%==0 goto open

echo Starting agent-console kernel + web dashboard...
start "agent-console" /min node bin\agentctl.js demo --port 7788
timeout /t 4 /nobreak >nul

:open
start "" http://127.0.0.1:7788
endlocal
