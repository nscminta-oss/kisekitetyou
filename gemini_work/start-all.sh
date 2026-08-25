#!/bin/bash

# 学生向けAIスケジューラー — 統合起動スクリプト
# 使い方：
#   chmod +x start-all.sh
#   ./start-all.sh
#
# これにより、バックエンドとフロントが同時に起動します。
# バックエンド：http://127.0.0.1:8000
# フロントエンド：http://127.0.0.1:5173

set -e

echo "🚀 学生向けAIスケジューラー を起動します..."
echo ""

# バックエンドの準備
echo "▶ バックエンド（FastAPI）を準備中..."
cd backend
pip install -r requirements.txt --quiet 2>/dev/null || pip install -r requirements.txt --quiet --break-system-packages
cd ..

# フロントエンドの準備
echo "▶ フロントエンド（React）を準備中..."
cd frontend
npm install --silent >/dev/null 2>&1
cd ..

echo ""
echo "✅ 準備完了"
echo ""
echo "🔧 ターミナルウィンドウが2つ開きます..."
echo "   - 左：バックエンド（FastAPI） → http://127.0.0.1:8000"
echo "   - 右：フロントエンド（React） → http://127.0.0.1:5173"
echo ""
echo "💡 アプリを開くには：http://127.0.0.1:5173"
echo ""

# バックエンドをバックグラウンドで起動
echo "▶ バックエンドを起動中..."
cd backend
bash start.sh &
BACKEND_PID=$!
cd ..

sleep 2

# フロントエンドをバックグラウンドで起動
echo "▶ フロントエンドを起動中..."
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "✅ 両方起動しました"
echo ""
echo "終了するには Ctrl+C を2回押してください"
echo ""

# Ctrl+C を受け取ったら両方終了
trap "echo ''; echo '🛑 シャットダウン中...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT

# プロセスの終了まで待機
wait
