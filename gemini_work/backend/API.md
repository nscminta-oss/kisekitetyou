# バックエンド API 仕様（フロント担当向け）

担当：小河
最終更新：2026-08-24

ベース URL

| 環境 | URL |
|---|---|
| ローカル | `http://127.0.0.1:8000` |
| 本番 | （デプロイ後に共有します） |

対話的な確認は `http://127.0.0.1:8000/docs` でできます（Swagger UI）。

---

## 認証

すべての `/api/*` は **Supabase のアクセストークンが必須**です。

```
Authorization: Bearer <access_token>
```

トークンの取り方（React 側）:

```js
const { data: { session } } = await supabase.auth.getSession()
const token = session.access_token
```

呼び出しの共通ラッパー例:

```js
const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8000'

async function api(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('ログインしていません')

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      ...options.headers,
    },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}
```

エラー時は `{ "detail": "..." }` が返ります。

| ステータス | 意味 |
|---|---|
| 401 | トークンがない・期限切れ・不正 → 再ログインへ誘導 |
| 403 | 他人のデータに触ろうとした（RLS が拒否） |
| 404 | 対象が存在しない |
| 422 | 入力値が不正（0分、タイトル空など） |

---

## 1. プロフィール

### `GET /api/user/profile`

```js
const profile = await api('/api/user/profile')
```

```json
{
  "id": "uuid",
  "name": "オゴウ",
  "maxWorkloadMinutes": 240,
  "onboardingCompleted": false,
  "createdAt": "...",
  "updatedAt": "..."
}
```

### `PUT /api/user/profile`

事前アンケートの結果（限界時間）を保存するのはここです。

```js
await api('/api/user/profile', {
  method: 'PUT',
  body: JSON.stringify({
    maxWorkloadMinutes: 300,
    onboardingCompleted: true,
  }),
})
```

送れるのは `name` / `maxWorkloadMinutes` / `onboardingCompleted` の3つ。全部任意で、送ったものだけ更新されます。`maxWorkloadMinutes` は 1 以上。

---

## 2. タスク

### `GET /api/tasks?date=YYYY-MM-DD`

`date` を省略すると今日の分。

```js
const { tasks, count, date } = await api('/api/tasks')
const other = await api('/api/tasks?date=2026-08-25')
```

```json
{
  "date": "2026-08-24",
  "count": 2,
  "tasks": [
    {
      "id": "uuid",
      "userId": "uuid",
      "title": "レポート作成",
      "category": "課題",
      "date": "2026-08-24",
      "startTime": "10:00:00",
      "plannedMinutes": 90,
      "actualMinutes": null,
      "isCompleted": false,
      "completedAt": null,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

### `POST /api/tasks`

```js
const task = await api('/api/tasks', {
  method: 'POST',
  body: JSON.stringify({
    title: 'レポート作成',
    plannedMinutes: 90,
    category: '課題',      // 任意
    date: '2026-08-24',    // 任意（省略で今日）
    startTime: '10:00',    // 任意
  }),
})
```

成功すると 201 と、作られたタスク1件が返ります。`plannedMinutes` は 1 以上、`title` は 1〜200文字。

### `PUT /api/tasks/{id}`

完了チェックや実績時間の記録に使います。

```js
// 完了にする
await api(`/api/tasks/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ isCompleted: true, actualMinutes: 105 }),
})

// 未完了に戻す
await api(`/api/tasks/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ isCompleted: false }),
})
```

`completedAt` は DB のトリガーが自動でつけ外しするので、フロントから送る必要はありません。

### `DELETE /api/tasks/{id}`

```js
await api(`/api/tasks/${id}`, { method: 'DELETE' })
// → { "deleted": true, "id": "..." }
```

---

## 3. 負荷計算（このアプリの肝）

### `GET /api/workload?date=YYYY-MM-DD`

読むだけならこちらが楽です。`POST /api/workload/calculate` も同じ結果を返します（どちらでも可）。

```js
const workload = await api('/api/workload')
```

```json
{
  "date": "2026-08-24",
  "totalMinutes": 120,
  "capacityMinutes": 240,
  "workloadPercentage": 50,
  "workloadLevel": "適正",
  "comment": "いい感じのバランス。このペースでいこう",
  "remainingMinutes": 120,
  "taskCount": 3,
  "completedCount": 1
}
```

計算式:

```
workloadPercentage = sum(planned_minutes) / max_workload_minutes × 100
```

レベル判定:

| % | workloadLevel |
|---|---|
| 100 超 | キャパオーバー |
| 80 超 〜 100 | かなりキツい |
| 40 〜 80 | 適正 |
| 40 未満 | 余裕あり |

`comment` はそのまま画面に出せる短文です。プログレスバーの色分けは `workloadLevel` で分岐すると楽だと思います。

タスクを追加・削除・編集したあとに呼び直せば、最新の % が返ります。

---

## 相談したいこと

- `workloadPercentage` がちょうど 100 のとき、いまは「かなりキツい」にしています（「100を超えたらキャパオーバー」という元の仕様に合わせた形）。100 ちょうどをキャパオーバー扱いにしたいなら、すぐ変えられます。
- `comment` の文面はこちらで仮に決めています。画面の雰囲気に合わせて変えたいところがあれば言ってください。
- 本番のバックエンド URL が決まったら、フロントの環境変数（`VITE_API_BASE` など）に入れてもらう形を想定しています。

---

## 追記：GET /api/tasks の期間取得（v1.2）

カレンダー表示のため、単日だけでなく期間でも取得できるようにしました。
既存の `date` 指定・指定なしの挙動は変更していません。

| クエリ | 挙動 |
|--------|------|
| `?date=2026-08-24` | その日のタスク |
| `?from=2026-08-01&to=2026-08-31` | 期間内のタスク（`scheduled_date` 昇順） |
| （指定なし） | 今日のタスク |

`from` / `to` は片方だけの指定も可能です。

レスポンス（期間指定時）：

```json
{
  "from": "2026-08-01",
  "to": "2026-08-31",
  "count": 12,
  "tasks": [ ... ]
}
```
