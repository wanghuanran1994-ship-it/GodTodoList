@echo off
chcp 65001 >nul
title GodTodoList - 事项管理体系

cd /d "%~dp0"

:: 检查 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo  ❌ 未检测到 Node.js，请先安装: https://nodejs.org
    echo     下载 LTS 版本并安装后重试
    echo.
    pause
    exit /b 1
)

:: 检查依赖
if not exist "node_modules" (
    echo.
    echo  📦 首次运行，正在安装依赖...
    npm install
    if %errorlevel% neq 0 (
        echo.
        echo  ❌ 依赖安装失败，请检查网络连接
        pause
        exit /b 1
    )
    echo  ✅ 依赖安装完成
)

echo.
echo  🚀 GodTodoList 启动中...
echo     浏览器将自动打开 http://localhost:3000
echo     关闭此窗口即可停止服务
echo.

node server/index.js

pause
