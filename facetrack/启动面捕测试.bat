@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if not errorlevel 1 (
  python -u "%~dp0launcher.py"
  if errorlevel 1 pause
  exit /b
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -u "%~dp0launcher.py"
  if errorlevel 1 pause
  exit /b
)
echo 未找到 Python 3。请安装 Python 并勾选加入 PATH，然后重新运行。
pause
