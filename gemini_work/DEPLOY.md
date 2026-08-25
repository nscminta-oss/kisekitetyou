# 🚀 デプロイ手順書 — Vercel × Render × Supabase

学生向けAIスケジューラー（チームうさぎ）の本番デプロイ構成と設定まとめ。

```
┌─────────────────┐        ┌──────────────────┐
│  Vercel         │  API   │  Render          │
│  frontend/      │ ─────▶ │  backend/        │
│  React + Vite   │        │  FastAPI         │
└────────┬────────┘        └────────┬─────────┘
         │                          │
         │   Supabase Auth / DB     │
         └──────────┬───────────────┘
                    ▼
          ┌──────────────────────┐
          │  Supabase            │
          │  Auth + Postgres+RLS │
          │  qlwtxjzrtcpjyajonnnk│
          └──────────────────────┘
```

---

## ⚠️ 最初に確認すべきこと

**現状の `frontend/src/App.tsx` は Supabase に直接アクセスしており、バックエンド（`VITE_API_BASE`）を一度も呼んでいない。**

- この手順でデプロイ自体は問題なく完了する
- ただし Render 上の負荷計算 API は「動いているが使われていない」状態になる
- 実際に API を経由させるなら、`App.tsx` の `supabase.from('tasks')` 系を `fetch(API_BASE + '/api/tasks')` に差し替える作業が別途必要

→ **チームで方針を決めてから着手すること**（デモ優先なら現状のままでも動く）

---

## 📋 デプロイ順序

| # | 作業 | 理由 |
|---|------|------|
| 0 | 事前準備（コード修正） | CORS を環境変数化しておく |
| 1 | Render にバックエンドをデプロイ | 先に API の URL を確定させる |
| 2 | Vercel にフロントをデプロイ | 手順1の URL を環境変数に入れる |
| 3 | Render の CORS 設定を更新 | 手順2の URL を許可する |
| 4 | Supabase の Auth URL 設定 | ログイン・メール確認を通す |
| 5 | 動作確認 | — |

---

## 0️⃣ 事前準備

### CORS を環境変数化する

`backend/main.py` の `ALLOWED_ORIGINS` はハードコードされているため、そのままだと Vercel の URL が変わるたびに再デプロイが必要になる。以下に差し替える。

```python
# ALLOWED_ORIGINS = [ ... ] を丸ごと置き換え
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000",
    ).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"https://.*\.vercel\.app",  # プレビュー環境も許可
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### `.env` を push しない

`.gitignore` には入っているが、zip から展開して `git add .` すると混入する場合がある。

```bash
git status --ignored | grep ".env"
# → .env が「Ignored files」側にあれば OK
```

### lockfile をどちらかに統一する

`frontend/` に `package-lock.json` と `pnpm-lock.yaml` が**両方存在する**。Vercel がどちらを使うか不定になるため、片方を削除する。

```bash
# npm 運用の場合
rm frontend/pnpm-lock.yaml
```

---

## 1️⃣ Render（バックエンド）

**New → Web Service → リポジトリを選択**

| 項目 | 値 |
|------|-----|
| Root Directory | `backend` |
| Language | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/health` |
| Instance Type | Free |

### 環境変数

```
SUPABASE_URL       = https://qlwtxjzrtcpjyajonnnk.supabase.co
SUPABASE_ANON_KEY  = sb_publishable_yrzEh2j5yOQFjfv2D7D1QQ_PDYx1nvk
ALLOWED_ORIGINS    = http://localhost:5173          ← 手順3で Vercel URL を追記
PYTHON_VERSION     = 3.12.7
```

### 注意点

- **`PYTHON_VERSION` の指定はほぼ必須。** Render のデフォルトが 3.13 系だと `supabase 2.31.0` の依存解決でビルドが失敗することがある
- `Procfile` は Render では読まれない（Start Command が優先）。残っていても害はない
- **無料プランは15分アクセスがないとスリープする。** 復帰に50秒前後かかるため、プレゼン直前に `/health` を叩いて起こしておくこと

### 確認

`https://<service>.onrender.com/docs` で Swagger UI が開けば成功。

---

## 2️⃣ Vercel（フロントエンド）

**New Project → リポジトリを選択**

| 項目 | 値 |
|------|-----|
| Framework Preset | Vite |
| Root Directory | `frontend` |
| Build Command | `npm run build`（デフォルト） |
| Output Directory | `dist` |
| Install Command | `npm install` |

### 環境変数（Production / Preview / Development すべてにチェック）

```
VITE_SUPABASE_URL       = https://qlwtxjzrtcpjyajonnnk.supabase.co
VITE_SUPABASE_ANON_KEY  = sb_publishable_yrzEh2j5yOQFjfv2D7D1QQ_PDYx1nvk
VITE_API_BASE           = https://<service>.onrender.com
```

### 注意点

- `VITE_` 付きの値は**ビルド時にバンドルへ埋め込まれ、ブラウザから見える**。anon key は公開前提のキーなので問題なし
- **`service_role` キーは絶対にここへ入れない**
- 環境変数を後から変更した場合、**再デプロイしないと反映されない**（Deployments → Redeploy）
- `vercel.json` の SPA rewrite は設定済みなので変更不要

---

## 3️⃣ Render に Vercel の URL を許可させる

Vercel のドメインが確定したら、Render の環境変数を更新する。

```
ALLOWED_ORIGINS = https://<あなたのドメイン>.vercel.app,http://localhost:5173
```

保存すると Render が自動で再デプロイされる。

---

## 4️⃣ Supabase

**Dashboard → Authentication → URL Configuration**

| 項目 | 値 |
|------|-----|
| Site URL | `https://<あなたのドメイン>.vercel.app` |
| Redirect URLs | `https://<あなたのドメイン>.vercel.app/**`<br>`https://*.vercel.app/**`（プレビュー用）<br>`http://localhost:5173/**` |

### メール確認について

`App.tsx` は `supabase.auth.signUp()` を使っているため、**メール確認が有効かつ上記が未設定だと新規登録が完了しない。**

- ハッカソンのデモ用途 → Authentication → Providers → Email → **Confirm email を OFF** が安全
- 本番公開する場合 → ON に戻す

### DB

山口さん作成のマイグレーション（`profiles` / `tasks`、RLS・トリガー・インデックス込み）は適用済み。追加設定は不要。

---

## 5️⃣ 動作確認チェックリスト

### バックエンド

```bash
curl https://<service>.onrender.com/health
# → {"status":"ok","service":"workload-scheduler-api","version":"1.1.0"}

curl "https://<service>.onrender.com/debug/sample-calc?total=120&capacity=240"
# → workloadPercentage: 50, workloadLevel: "適正"
```

- [ ] `/docs` で Swagger UI が表示される
- [ ] `/health` が 200 を返す

### フロントエンド

- [ ] Vercel の URL で画面が表示される
- [ ] DevTools の Console に `VITE_SUPABASE_URL が設定されていません` が出ていない
- [ ] 新規登録 → ログインが通る
- [ ] タスクの追加・削除が動く
- [ ] 負荷率が表示される
- [ ] ユーザーA / ユーザーB でログインし、互いのデータが見えないこと（RLS 確認）

---

## 🔧 トラブルシューティング

| 症状 | 原因と対処 |
|------|-----------|
| Render のビルドが依存解決で失敗 | `PYTHON_VERSION=3.12.7` を環境変数に設定 |
| 最初のアクセスだけ極端に遅い | 無料プランのスリープ。`/health` で事前に起こす |
| CORS エラー | Render の `ALLOWED_ORIGINS` に Vercel の実ドメインが入っているか確認 |
| API が 401 | Supabase Auth のトークンがフロントから送られていない／期限切れ。再ログイン |
| API が 404（他人のデータ） | **正常動作。** RLS により他人のデータは「存在しない」扱いになる |
| 環境変数を変えたのに反映されない | Vercel は再デプロイが必要（ビルド時埋め込みのため） |
| 新規登録でメールが届かない／完了しない | Supabase の Redirect URLs 未設定、または Confirm email を OFF にする |
| Vercel のビルドが不安定 | lockfile が2つある。どちらかを削除して統一 |

---

## 📎 環境変数まとめ

### Render（backend）

| キー | 値 |
|------|-----|
| `SUPABASE_URL` | `https://qlwtxjzrtcpjyajonnnk.supabase.co` |
| `SUPABASE_ANON_KEY` | `sb_publishable_yrzEh2j5yOQFjfv2D7D1QQ_PDYx1nvk` |
| `ALLOWED_ORIGINS` | Vercel URL をカンマ区切りで |
| `PYTHON_VERSION` | `3.12.7` |

### Vercel（frontend）

| キー | 値 |
|------|-----|
| `VITE_SUPABASE_URL` | `https://qlwtxjzrtcpjyajonnnk.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_yrzEh2j5yOQFjfv2D7D1QQ_PDYx1nvk` |
| `VITE_API_BASE` | Render の URL |

---

## 👥 チーム確認事項

- [ ] 下平さん：`App.tsx` をバックエンド経由に差し替えるか、Supabase 直アクセスのままにするか方針決定
- [ ] 山口さん：Supabase の Auth URL Configuration 設定（本番ドメイン確定後）
- [ ] 今井さん：称号API（`daily_summaries`）は Phase 2 のままで OK か
- [ ] オゴウ：`main.py` の CORS 環境変数化 → Render デプロイ

🐰
