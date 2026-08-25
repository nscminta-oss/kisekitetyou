#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "▶ ライブラリを確認中..."
pip install -r requirements.txt --quiet
echo "▶ サーバーを起動します → http://127.0.0.1:8000/docs"
uvicorn main:app --reload
