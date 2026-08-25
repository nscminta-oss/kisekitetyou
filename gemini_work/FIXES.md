# 修正内容まとめ（統合版 v1.2）

`scheduler-complete.zip` に対して行った全修正の一覧。

---

## 🔴 起動できなかったエラーの修正

### 1. `RuntimeError: SUPABASE_URL と SUPABASE_ANON_KEY を .env に設定してください`

**原因：`.env` は正しく存在していた。起動したディレクトリが違っただけ。**

`load_dotenv()` は実行時のカレントディレクトリを基準に `.env` を探すため、
リポジトリ直下から `uvicorn main:app` を叩くと `backend/.env` が見つからない。

| 起動場所 | 修正前 | 修正後 |
|---|---|---|
| `scheduler-complete/backend/` | ✅ | ✅ |
| `scheduler-complete/` | ❌ RuntimeError | ✅ |

**修正（`backend/main.py`）**

```python
from pathlib import Path
load_dotenv(Path(__file__).with_name(".env"))
```

エラー文も改善。再発時に「どこを探して失敗したか」が出るようにした。

```
RuntimeError: 環境変数が設定されていません: SUPABASE_URL
  探した .env: /path/to/backend/.env
  ローカル : backend/.env を作成してください（backend/.env.example をコピー）
  Render   : ダッシュボードの Environment に登録してください
```

### 2. `docker-compose up` が必ず失敗する

`docker-compose.yml` が存在しない Dockerfile を参照していた。
さらに frontend の `VITE_API_BASE: http://backend:8000` はブラウザから解決できない値だった。

**修正：ファイルごと削除。** ローカルは `start-all.sh`、本番は Render/Vercel を使う。

### 3. `start-all.sh` / `backend/start.sh` に実行権限が無かった

zip 経由で権限が落ちていたため `./start-all.sh` が Permission denied になる。

**修正：実行権限を付与。** さらに `start-all.sh` 内の呼び出しを `bash start.sh` に変更し、
権限に依存しないようにした。

---

## 🟡 デプロイを妨げる問題の修正

### 4. CORS がハードコードだった

Vercel の URL が変わるたびにコード修正＋再デプロイが必要だった。

**修正：環境変数 `ALLOWED_ORIGINS`（カンマ区切り）で指定できるようにした。**
Vercel のプレビューデプロイ（毎回URLが変わる）も正規表現でまとめて許可。

未設定時はローカル開発用のみ許可されるので、ローカルは今まで通り動く。

### 5. lockfile が2つあった

`frontend/` に `package-lock.json` と `pnpm-lock.yaml` が同居し、
Vercel がどちらを使うか不定だった。

**修正：`pnpm-lock.yaml` を削除。**

### 6. ドキュメントが Railway を指していた

`README.md` / `backend/README.md` のデプロイ手順が Railway 前提だった。

**修正：Render の手順に差し替え。**

---

## 🟢 機能追加

### 7. フロントがバックエンドを一度も呼んでいなかった

`App.tsx` は Supabase に直接アクセスしており、`VITE_API_BASE` は未使用だった。
Render にデプロイしても API が使われない状態。

**修正：**

- `frontend/src/lib/api.ts` を新規作成（Supabase の access_token を Bearer で付与する fetch ラッパー）
- `authService.me` / `updateProfile` / `scheduleService` を API 経由に変更
- **`VITE_USE_BACKEND` で切り替え可能。** Supabase 直アクセスのコードは残してある

```bash
VITE_USE_BACKEND=true   # FastAPI 経由
VITE_USE_BACKEND=false  # Supabase 直（未設定時もこちら）
```

Render 無料プランはスリープするため、**デモ当日に落ちたら false に戻せば即復旧できる。**

### 8. `GET /api/tasks` が単日しか返せなかった

カレンダーは週・月表示があるのに、API は1日分しか返さなかった。

**修正：`from` / `to` を追加。** 既存の `date` 指定・指定なしの挙動は不変なので、
他メンバーのコードへの影響は無い。

### 9. Render 用の設定を追加

- `backend/.python-version`（3.12.7）— Render のデフォルト 3.13 系だと supabase の依存解決で落ちるため
- `render.yaml` — Blueprint 対応（任意。手動作成でも可）
- `backend/.gitignore` に `.env.*` / `!.env.example` を追加

---

## ✅ 検証結果

| 項目 | 結果 |
|------|------|
| `pytest test_local.py` | **20 passed** |
| `backend/` から起動 | ✅ |
| リポジトリ直下から起動 | ✅ |
| `GET /health` | ✅ 200 |
| `GET /docs` (Swagger) | ✅ 200 |
| `GET /api/tasks`（認証なし） | ✅ 401 |
| CORS 許可オリジン | ✅ 通過 |
| CORS 未許可オリジン | ✅ 拒否 |
| `tsc --noEmit` | ✅ エラー 0 |
| `npm run build` | ✅ 成功（gzip 131KB） |
| フロントの送信JSON ⇄ Pydanticモデル | ✅ 一致 |

---

## ⚠️ 未確認・残課題

**Supabase ダッシュボードの中身は確認できていません。** ログインが必要なため、
以下はご自身で確認してください。

- [ ] Authentication → URL Configuration に Vercel の本番URLを登録
- [ ] Email の Confirm email の ON/OFF（デモなら OFF 推奨）
- [ ] `daily_summaries` テーブル（称号履歴）は未適用のまま → AI総括の保存は Phase 2

**コード側の既知の制限**

- 予定の「詳細」「優先度」は DB にカラムが無く、リロードで消える
- `summaryService`（称号履歴）は対応する API が無いため Supabase 直アクセスのまま
