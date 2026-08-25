@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM 学生向けAIスケジューラー — 統合起動スクリプト（Windows版）
REM 使い方：
REM   このファイルをダブルクリック

echo.
echo 🚀 学生向けAIスケジューラー を起動します...
echo.

REM バックエンドの準備
echo ▶ バックエンド（FastAPI）を準備中...
cd backend
pip install -r requirements.txt >nul 2>&1
cd ..

REM フロントエンドの準備
echo ▶ フロントエンド（React）を準備中...
cd frontend
npm install >nul 2>&1
cd ..

echo.
echo ✅ 準備完了
echo.
echo ⚠️  2つのコマンドプロンプトウィンドウが開きます
echo     - 左：バックエンド（FastAPI）
echo     - 右：フロントエンド（React）
echo.
echo 💡 アプリを開くには：http://127.0.0.1:5173
echo.
echo 🔧 起動中...
echo.

REM バックエンドをバックグラウンドで起動
start cmd /k "cd backend && start.bat"

REM 1秒待機
timeout /t 1 /nobreak >nul

REM フロントエンドをバックグラウンドで起動
start cmd /k "cd frontend && npm run dev"

echo.
echo ✅ 両方起動しました
echo.
pause
