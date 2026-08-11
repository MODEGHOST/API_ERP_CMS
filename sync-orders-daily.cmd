@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
echo ===== %date% %time% start ===== >> logs\sync-orders.log
"C:\Program Files\nodejs\node.exe" sync-orders.js --daily >> logs\sync-orders.log 2>&1
echo ===== %date% %time% exit %errorlevel% ===== >> logs\sync-orders.log
exit /b %errorlevel%
