/**
 * FastAPI バックエンド（Render）を叩くための薄いクライアント。
 *
 * 認証は Supabase Auth のまま。ログイン後に得られる access_token を
 * Authorization: Bearer <token> でバックエンドに渡す。バックエンド側は
 * そのトークンをそのまま Supabase に転送するので、RLS が効いたまま
 * 「本人のデータだけ」を読み書きできる。
 *
 * DB は snake_case、この API の JSON は camelCase。変換はバックエンドが
 * 行うので、フロントは camelCase だけを見ればよい。
 */

import { supabase } from './supabase'

// 末尾のスラッシュを落として `${API_BASE}/api/tasks` の形に揃える
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

/** バックエンド経由にするかどうか。Vercel の環境変数で切り替える。 */
export const USE_BACKEND =
  String(import.meta.env.VITE_USE_BACKEND ?? '').toLowerCase() === 'true' && API_BASE !== ''

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// ─── 型（バックエンドのレスポンスと1対1）────────────────────────────────────

export interface ApiTask {
  id: string
  userId: string
  title: string
  category: string | null
  date: string // YYYY-MM-DD
  startTime: string | null // HH:MM:SS
  plannedMinutes: number
  actualMinutes: number | null
  isCompleted: boolean
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ApiProfile {
  id: string
  name: string
  maxWorkloadMinutes: number
  onboardingCompleted: boolean
  createdAt: string
  updatedAt: string
}

export interface ApiWorkload {
  date: string
  totalMinutes: number
  capacityMinutes: number
  workloadPercentage: number
  workloadLevel: string
  comment: string
  remainingMinutes: number
  taskCount: number
  completedCount: number
}

export interface CreateTaskPayload {
  title: string
  plannedMinutes: number
  category?: string | null
  date?: string
  startTime?: string | null
}

export interface UpdateTaskPayload {
  title?: string
  plannedMinutes?: number
  actualMinutes?: number
  isCompleted?: boolean
  category?: string | null
  date?: string
  startTime?: string | null
}

export interface OnboardingAnswersPayload {
  freeTimeMinutes: number
  sleepMinimumMinutes: number
  fixedCommitmentMinutes: number
  sustainableWorkMinutes: number
  maxEffortMinutes: number
}

export interface ApiOnboardingResult {
  capacityMinutes: number
  onboardingCompleted: boolean
}

export interface UpdateProfilePayload {
  name?: string
  maxWorkloadMinutes?: number
  onboardingCompleted?: boolean
}

export interface ApiCompletedTask {
  title: string
  category?: string | null
  plannedMinutes: number
  actualMinutes: number
}

export interface GenerateDailySummaryPayload {
  date?: string
  capacityMinutes: number
  plannedMinutes: number
  actualMinutes: number
  completedTasks: ApiCompletedTask[]
}

export interface ApiDailySummary {
  date: string
  title: string
  reason: string
  nextAction: string
  plannedPercentage: number
  actualPercentage: number
  totalFocusTimeMinutes: number
}

export interface ApiDailySummaryHistoryItem {
  date: string
  title: string
  reason: string
  nextAction?: string | null
}

// ─── 内部ヘルパー ──────────────────────────────────────────────────────────

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) {
    throw new ApiError(401, 'ログインセッションがありません。もう一度ログインしてください。')
  }
  return { Authorization: `Bearer ${token}` }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE) {
    throw new ApiError(0, 'VITE_API_BASE が設定されていません（.env を確認してください）')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(await authHeader()),
    ...((init.headers as Record<string, string>) ?? {}),
  }

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  } catch {
    // Render の無料プランはスリープからの復帰に50秒ほどかかる
    throw new ApiError(
      0,
      'バックエンドに接続できません。サーバーが起動中の可能性があります（最大1分ほど）。',
    )
  }

  if (res.status === 204) return undefined as T

  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  if (!res.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail
    throw new ApiError(res.status, typeof detail === 'string' ? detail : `HTTP ${res.status}`)
  }

  return body as T
}

function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '')
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join('&')
}

// ─── エンドポイント ────────────────────────────────────────────────────────

export const api = {
  /** 認証不要。Render のスリープ復帰にも使える。 */
  health: async (): Promise<boolean> => {
    if (!API_BASE) return false
    try {
      const res = await fetch(`${API_BASE}/health`)
      return res.ok
    } catch {
      return false
    }
  },

  getProfile: () => request<ApiProfile>('/api/user/profile'),

  updateProfile: (patch: UpdateProfilePayload) =>
    request<ApiProfile>('/api/user/profile', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  /**
   * タスク一覧。
   * - `date` だけ渡す → その日のみ
   * - `from` / `to` を渡す → 期間で取得（カレンダー表示用）
   * - 何も渡さない → 今日のみ
   */
  listTasks: (params: { date?: string; from?: string; to?: string } = {}) =>
    request<{ date?: string; from?: string; to?: string; count: number; tasks: ApiTask[] }>(
      `/api/tasks${qs(params)}`,
    ),

  createTask: (payload: CreateTaskPayload) =>
    request<ApiTask>('/api/tasks', { method: 'POST', body: JSON.stringify(payload) }),

  updateTask: (id: string, payload: UpdateTaskPayload) =>
    request<ApiTask>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),

  deleteTask: (id: string) =>
    request<{ deleted: boolean; id: string }>(`/api/tasks/${id}`, { method: 'DELETE' }),

  /** 指定日の負荷率をバックエンドで計算して返す。 */
  getWorkload: (date?: string) => request<ApiWorkload>(`/api/workload${qs({ date })}`),

  /** オンボーディング5問の回答から限界時間を計算し、profilesに保存する。 */
  calculateCapacity: (payload: OnboardingAnswersPayload) =>
    request<ApiOnboardingResult>('/api/onboarding/calculate-capacity', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 今日完了したタスクをGeminiに渡し、称号と理由を生成してもらう。 */
  generateDailySummary: (payload: GenerateDailySummaryPayload) =>
    request<ApiDailySummary>('/api/daily-summary/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 称号履歴（新しい日付順、最大30件）。 */
  getDailySummaryHistory: () =>
    request<{ history: ApiDailySummaryHistoryItem[] }>('/api/daily-summary/history'),
}
