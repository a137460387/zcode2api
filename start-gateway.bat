@echo off
rem zcode2api - ZCode (z.ai) to OpenAI / Anthropic compatible local gateway.
rem Serves http://127.0.0.1:28630 with a captcha-param farm on 28631.
rem
rem Started by launch-hidden.vbs (via the zcode2api-Gateway scheduled task), which
rem runs this in a hidden window -- so stdout goes nowhere. Send it to a log file
rem instead, or a crash at boot leaves no trace at all.
rem
rem NOTE: keep this file ASCII-only. cmd.exe reads .bat in the OEM codepage
rem (GBK here), so UTF-8 Chinese comments get mangled into stray commands like
rem "'he' is not recognized" and the script dies before ever reaching node.
rem Chinese explanations belong in README.md, not here.
setlocal
cd /d "%~dp0"

rem Marker only; this service does not change behavior on NODE_ENV.
rem All configuration comes from .env (see README).
set NODE_ENV=production

rem --- Startup log ---
rem Truncated per boot: only the current start matters for "did the farm browser
rem come up", and restarts are rare enough that growing files would be a latent
rem disk problem. To watch a manual start: type logs\gateway-startup.log
if not exist "logs" mkdir "logs"
set "STARTUP_LOG=%~dp0logs\gateway-startup.log"
echo [%DATE% %TIME%] === zcode2api starting === > "%STARTUP_LOG%"

rem This script deliberately does NOT set FARM_HEADLESS -- .env owns that.
rem Heads-up: headed mode (the default) makes the service open a VISIBLE Chrome
rem window for the farm. Closing it cuts off param production and every request
rem starts failing with "captcha param pool is empty". See README.

node src/server.js >> "%STARTUP_LOG%" 2>&1
