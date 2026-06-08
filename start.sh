#!/bin/bash
# GodTodoList 启动脚本 (macOS / Linux)
cd "$(dirname "$0")"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 未检测到 Node.js，请先安装: https://nodejs.org"
    echo "   下载 LTS 版本并安装后重试"
    read -p "按回车键退出..."
    exit 1
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "📦 首次运行，正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ 依赖安装失败，请检查网络连接"
        read -p "按回车键退出..."
        exit 1
    fi
    echo "✅ 依赖安装完成"
fi

echo ""
echo "🚀 GodTodoList 启动中..."
echo "   浏览器将自动打开 http://localhost:3000"
echo "   按 Ctrl+C 停止服务"
echo ""

node server/index.js
