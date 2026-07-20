@echo off
:: SAP-CPI-Healer Scheduled Task Wrapper
:: This script is intended to be called by Windows Task Scheduler.
:: It explicitly sets the working directory and invokes the unattended cycle.

cd /d "C:\Users\Surya.Prakash\Documents\SAP-CPI-AI"
"C:\Program Files\nodejs\node.exe" orchestrator\run.js --unattended

:: Propagate the exit code (0 for success, 1 for red/urgent) back to Task Scheduler
exit /b %ERRORLEVEL%
