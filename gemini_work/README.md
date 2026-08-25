# 学生向けAIスケジューラー — 統合版

フロントエンド（React）+ バックエンド（FastAPI）の完全セット。

```
scheduler-complete/
├── backend/              オゴウさん担当（FastAPI・負荷計算）
├── frontend/             下平さん担当（React・UI）
└── README.md             ← このファイル
```

---

## 🚀 ローカル開発の開始方法

### 1️⃣ バックエンド起動（ターミナル1）

```bash
cd backend
pip install -r requirements.txt
./start.sh
```

起動すると `http://127.0.0.1:8000` で API サーバーが起動します。

### 2️⃣ フロントエンド起動（ターミナル2）

```bash
cd frontend

# 初回のみ：依存ライブラリをインストール
npm install

# 環境変数を設定（.env.example をコピーして .env に）
cp .env.example .env

# ローカル開発サーバーを起動
npm run dev
```

起動すると `http://127.0.0.1:5173` でアプリが起動します。ブラウザで自動的に開きます。

### 3️⃣ アプリを開く

```
http://127.0.0.1:5173
```

ログイン → Supabase Auth で認証 → スケジュール管理画面

---

## 📋 確認チェックリスト

### バックエンド側
- [ ] `http://127.0.0.1:8000/docs` で Swagger UI が表示される
- [ ] `GET /health` → 200 `{"status": "ok"}` が返る
- [ ] `GET /debug/sample-calc?total=120&capacity=240` → 50% 「適正」が返る

### フロントエンド側
- [ ] `npm run dev` でビルドエラーがない
- [ ] `http://127.0.0.1:5173` でページが表示される
- [ ] ログイン画面が出ている

### 統合テスト
- [ ] ログイン後、API に問い合わせでき、画面にタスクが表示される
- [ ] タスク登録・削除が動作する
- [ ] 負荷率が計算されて表示される

---

## 🔧 環境変数設定

### フロント（frontend/.env）

```bash
# Supabase（既に設定済み）
VITE_SUPABASE_URL=https://qlwtxjzrtcpjyajonnnk.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_yrzEh2j5yOQFjfv2D7D1QQ_PDYx1nvk

# バックエンド（重要：ここにAPIベースURLを指定）
VITE_API_BASE=http://127.0.0.1:8000
```

**本番環境：** デプロイ後、バックエンド URL を追加
```bash
VITE_API_BASE=https://scheduler-backend.onrender.com
```

### バック（backend/.env）

```bash
SUPABASE_URL=https://qlwtxjzrtcpjyajonnnk.supabase.co
SUPABASE_ANON_KEY=sb_publishable_yrzEh2j5yOQFjfv2D7D1QQ_PDYx1nvk
```

---

## 📂 ファイル構成

### backend/

| ファイル | 説明 |
|---------|------|
| `main.py` | FastAPI サーバー（プロフィール・タスク CRUD・負荷計算） |
| `requirements.txt` | ライブラリ一覧（pytz、FastAPI など） |
| `API.md` | API 仕様書（フロント開発者向け） |
| `test_local.py` | ユニットテスト（20件） |
| `.env` | Supabase 接続情報 |
| `start.sh` / `start.bat` | 起動用スクリプト |

### frontend/

| ファイル | 説明 |
|---------|------|
| `src/App.tsx` | メインコンポーネント（スケジューラー UI） |
| `src/lib/supabase.ts` | Supabase 初期化 |
| `package.json` | ライブラリ一覧 |
| `.env.example` | 環境変数テンプレート |
| `vite.config.ts` | Vite 設定 |

---

## 🔗 通信フロー

```
ブラウザ（React）
  ↓ Authorization: Bearer <token>
バックエンド（FastAPI）
  ↓ トークンを含めて
Supabase（RLS 付きDB）
  ↓
  ↑ ユーザー本人のデータのみ
```

**重要：** トークンをバックエンド → Supabase に渡すことで、RLS（行レベルセキュリティ）が自動的に本人のデータだけを返します。他人のデータには構造的にアクセスできません。

---

## 📡 API エンドポイント一覧

フロント側から呼ぶときは、環境変数 `VITE_API_BASE` を使用：

```js
const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'
const res = await fetch(`${API_BASE}/api/tasks`)
```

**詳細は** `backend/API.md` を参照。

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/health` | ヘルスチェック |
| GET | `/api/user/profile` | プロフィール取得 |
| PUT | `/api/user/profile` | プロフィール更新 |
| GET | `/api/tasks?date=` | タスク一覧 |
| POST | `/api/tasks` | タスク登録 |
| DELETE | `/api/tasks/{id}` | タスク削除 |
| GET | `/api/workload?date=` | 負荷率取得 |

---

## ⚠️ トラブルシューティング

### バックエンドが起動しない
```bash
# ライブラリを再インストール
pip install -r requirements.txt --break-system-packages

# .env が .py と同じ場所にあるか確認
ls -la backend/.env
```

### フロントでビルドエラー
```bash
# node_modules を削除して再インストール
rm -rf node_modules
npm install
```

### API が 401 エラー
トークンが送られていない。フロント側で Supabase Auth 後、以下の形式で送っているか確認：
```
Authorization: Bearer <access_token>
```

### API が 404 エラー
RLS で他人のデータが見えない、または存在しない ID。これは正常（情報漏えい防止のため 404 で統一）。

---

## 🚢 デプロイ

### バックエンド（Render）

1. Render にログイン → "New" → "Web Service" → リポジトリを選択
2. Root Directory に `backend` を指定／Start Command は `uvicorn main:app --host 0.0.0.0 --port $PORT`
3. 環境変数を設定（`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `ALLOWED_ORIGINS` / `PYTHON_VERSION=3.12.7`）
4. デプロイ完了後、URL をコピー例：`https://scheduler-backend.onrender.com`

### フロントエンド（Vercel）

1. Vercel にログイン → "Add New" → "Project"
2. `scheduler-complete/frontend` を指定
3. 環境変数を設定：
   ```
   VITE_SUPABASE_URL=...
   VITE_SUPABASE_ANON_KEY=...
   VITE_API_BASE=https://scheduler-backend.onrender.com  ← ここが重要
   ```

---

## 📚 参考ドキュメント

- `backend/API.md` — API 仕様書
- `backend/README.md` — バックエンド詳細
- `backend/review-detail.md` — 山口さんのレビュー対応内容

---

## 👥 チーム内の役割

| 担当 | 内容 | ステータス |
|------|------|----------|
| 小河（オゴウ） | バックエンド（FastAPI・負荷計算） | ✅ v2-reviewed 公開済み |
| 下平 | フロントエンド（React・UI） | ✅ Vercel デプロイ済み |
| 山口 | DB（Supabase・RLS・マイグレーション） | ✅ tasks テーブル適用済み |
| 今井 | 称号 API（Gemini 連携） | 🟡 Phase 2（daily_summaries 待ち） |

---

## 🎯 次のステップ

1. [ ] ローカルで両側とも起動して動作確認
2. [ ] ユーザーA/B で RLS テスト
3. [ ] デプロイ先を決定
4. [ ] 本番環境で統合テスト
5. [ ] 公開

**何か問題があれば、チーム Discord で報告してください！** 🐰
