# scheduler-backend

学生向けAIスケジューラー — 負荷計算バックエンド（担当：小河）

タスクの合計時間とユーザーの限界時間から「今日のキツさ（%）」を出して返す API。

---

## 動かし方

### Mac / Linux

```bash
./start.sh
```

### Windows

`start.bat` をダブルクリック。

### 手動で動かす場合

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

起動したらブラウザで **http://127.0.0.1:8000/docs**（Swagger UI）。止めるときは `Ctrl + C`。

---

## テスト

```bash
pip install -r requirements-dev.txt
pytest test_local.py -v
```

DB に繋がずに「サーバーが立つか」「計算式が合っているか」「認証を弾くか」を確認します。20件。

DB を実際に読み書きする部分は、フロントからログインして試すのが確実です（本物のトークンが要るため）。

---

## エンドポイント

詳しい使い方とレスポンス例は **`API.md`**（フロント担当に渡す用）。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/health` | 生存確認（認証不要） |
| GET | `/debug/sample-calc` | 計算ロジックだけ確認（認証不要） |
| GET | `/api/user/profile` | プロフィール取得 |
| PUT | `/api/user/profile` | 限界時間・名前・アンケート完了フラグを更新 |
| GET | `/api/tasks?date=` | タスク一覧（省略時は今日） |
| POST | `/api/tasks` | タスク登録 |
| PUT | `/api/tasks/{id}` | タスク更新（完了、実績時間など） |
| DELETE | `/api/tasks/{id}` | タスク削除 |
| GET | `/api/workload?date=` | 負荷率を取得 |
| POST | `/api/workload/calculate?date=` | 同上（POST版） |

負荷率 = `sum(tasks.planned_minutes) / profiles.max_workload_minutes × 100`

| % | レベル |
|---|---|
| 100 超 | キャパオーバー |
| 80 超 | かなりキツい |
| 40 以上 | 適正 |
| 40 未満 | 余裕あり |

---

## 認証の考え方

```
React ──[Supabase Auth でログイン]──> アクセストークン取得
  │
  └─[Authorization: Bearer <token>]──> FastAPI
                                         │ トークンから user_id を取り出す
                                         │ そのトークンを Supabase に渡す
                                         ↓
                                       Supabase（RLS が本人の行だけ通す）
```

ポイントは、**バックエンドが自分の権限で DB を触るのではなく、ユーザーのトークンをそのまま Supabase に渡している**こと。こうすると山口さんが設定した RLS がそのまま効くので、他人のデータには構造的に触れません。リクエストボディの `userId` は本人確認に使っていません（DB契約書の方針どおり）。

Secret key（service_role）は使っていません。Anon key だけで動きます。

---

## ファイル

```
main.py              API 本体
API.md               フロント担当向けの仕様書
test_local.py        テスト
.env                 Supabase 接続情報（Git に上げない）
requirements.txt     実行に必要なライブラリ
requirements-dev.txt テスト用
start.sh / start.bat 起動用
.gitignore
```

---

## 現状と残り

- [x] tasks テーブル適用済み（山口さん、8/24 12:11）
- [x] プロフィール取得・更新
- [x] タスク CRUD
- [x] 負荷計算
- [x] RLS を効かせた状態での DB アクセス
- [ ] フロントとの結合テスト（下平さんと）
- [ ] デプロイ（Render）
- [ ] 称号機能（Gemini API）— `daily_summaries` 適用待ち、Phase 2

デプロイ先が決まったら、`.env` の中身を環境変数として設定するだけで動きます。
