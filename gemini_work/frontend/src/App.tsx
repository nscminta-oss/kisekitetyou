import { useState, useRef, useEffect, useCallback } from 'react'
import { supabase } from './lib/supabase'
import { api, USE_BACKEND, ApiError, type ApiTask } from './lib/api'
import type { Database } from './lib/database.types'

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen = 'login' | 'register' | 'onboarding' | 'assessing' | 'ai-result' | 'home' | 'calendar' | 'ai-summary' | 'settings' | 'profile'
type ViewMode = 'week' | 'month' | 'list'
type Theme = 'dark' | 'light' | 'system'
type FontSize = 'sm' | 'md' | 'lg'
type AiSpice = 'mild' | 'normal' | 'spicy'

interface User { id: string; name: string; email: string; limitScore: number; nickname: string; message: string; capacityMinutes: number }
interface Category { id: string; label: string; color: string; bg: string }
interface CalendarEvent { id: string; title: string; date: string; startTime: string; endTime: string; categoryId: string; description?: string; priority?: 'low' | 'medium' | 'high'; completed?: boolean; actualMinutes?: number }
interface AIResult { score: number; nickname: string; message: string; capacityMinutes: number }
// ─── バックエンド契約と対応する型 ────────────────────────────────────────────
// 下記の型は、開発方針ドキュメント §5, §6 で決められたAPIリクエスト/レスポンス
// 形式とフィールド名を1文字も変えずに揃えてある。結合時はモック関数の中身を
// fetch() に差し替えるだけで良いように、呼び出し側のプロパティ名はここに
// 依存させておくこと（画面側で verdict や message のような独自名を作らない）。
// 【重要】estimatedMinutes（予定＝タスクの計画時間）と actualMinutes（実績＝
// 実際にかかった時間）は別概念。負荷計算(workload)は「予定」ベース、
// 今日の総括(daily-summary)は「実績」ベースで計算する。
type WorkloadLevel = '適正' | 'かなりキツい' | 'キャパオーバー'
interface WorkloadTaskInput { title: string; estimatedMinutes: number }
interface WorkloadRequest { userId: string; tasks: WorkloadTaskInput[]; capacityMinutes: number }
interface WorkloadResult { totalMinutes: number; capacityMinutes: number; workloadPercentage: number; workloadLevel: WorkloadLevel }
interface AIDailyResult { title: string; reason: string; overloadPct: number; nextAction: string }
interface Settings {
  theme: Theme; fontSize: FontSize; startMonday: boolean; timeFormat: '12h' | '24h'
  defaultView: ViewMode; showWeekends: boolean; showWeekNumbers: boolean
  aiEnabled: boolean; aiSpice: AiSpice
}

// ─── Categories ───────────────────────────────────────────────────────────────

const CATEGORIES: Category[] = [
  { id: 'class',    label: '授業',    color: '#5b8ef7', bg: 'rgba(91,142,247,0.18)' },
  { id: 'homework', label: '課題',    color: '#f79a4f', bg: 'rgba(247,154,79,0.18)' },
  { id: 'part-time',label: 'バイト',  color: '#4fc89e', bg: 'rgba(79,200,158,0.18)' },
  { id: 'play',     label: '遊び',    color: '#b04ff7', bg: 'rgba(176,79,247,0.18)' },
  { id: 'event',    label: 'イベント',color: '#f74f8e', bg: 'rgba(247,79,142,0.18)' },
  { id: 'other',    label: 'その他',  color: '#8e90ae', bg: 'rgba(142,144,174,0.18)' },
]
function getCat(id: string) { return CATEGORIES.find(c => c.id === id) ?? CATEGORIES[5] }

// 0〜100の限界スコア（UI用の演出値）を、バックエンドが実際に保存する
// max_workload_minutes 相当の「1日に使える分数」に変換する仮ロジック。
// 本物のオンボーディングAPIができたら、この関数ごと置き換える想定。
function scoreToCapacityMinutes(score: number): number {
  return Math.round(150 + (score / 100) * 450) // 150分(2.5h) 〜 600分(10h)
}

// ─── Mock data ────────────────────────────────────────────────────────────────

const DEMO_USER: User = {
  id: 'demo-user', name: '下平', email: 'demo@example.com',
  limitScore: 87, nickname: '鉄人28号',
  message: 'その生活をあと3日続けたら、人間ではなくなります。',
  capacityMinutes: scoreToCapacityMinutes(87),
}

function getMonday(): Date {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const m = new Date(now)
  m.setDate(now.getDate() + diff)
  m.setHours(0, 0, 0, 0)
  return m
}
function weekDate(offset: number): string {
  const m = getMonday()
  m.setDate(m.getDate() + offset)
  return m.toISOString().slice(0, 10)
}

function buildInitialEvents(): CalendarEvent[] {
  return [
    { id: '1',  title: '情報工学',          date: weekDate(0), startTime: '10:00', endTime: '12:00', categoryId: 'class' },
    { id: '2',  title: '確率統計論',        date: weekDate(0), startTime: '13:00', endTime: '14:30', categoryId: 'class' },
    { id: '3',  title: 'バイト',            date: weekDate(0), startTime: '18:00', endTime: '22:00', categoryId: 'part-time' },
    { id: '4',  title: '線形代数',          date: weekDate(1), startTime: '10:00', endTime: '12:00', categoryId: 'class' },
    { id: '5',  title: 'プログラミング',    date: weekDate(1), startTime: '14:00', endTime: '16:00', categoryId: 'class' },
    { id: '6',  title: '友達と飲み会',      date: weekDate(1), startTime: '19:00', endTime: '23:00', categoryId: 'play' },
    { id: '7',  title: '実験',              date: weekDate(2), startTime: '09:00', endTime: '12:00', categoryId: 'class' },
    { id: '8',  title: '英語',              date: weekDate(2), startTime: '13:00', endTime: '14:30', categoryId: 'class' },
    { id: '9',  title: 'コンピュータ科学',  date: weekDate(3), startTime: '10:00', endTime: '12:00', categoryId: 'class' },
    { id: '10', title: 'バイト',            date: weekDate(3), startTime: '17:00', endTime: '21:00', categoryId: 'part-time' },
    { id: '11', title: '解析',              date: weekDate(4), startTime: '10:00', endTime: '12:00', categoryId: 'class' },
    { id: '12', title: 'ハッカソン準備',    date: weekDate(4), startTime: '14:00', endTime: '16:00', categoryId: 'event' },
    { id: '13', title: '飲み会',            date: weekDate(4), startTime: '19:00', endTime: '22:00', categoryId: 'play' },
    { id: '14', title: '買い物',            date: weekDate(5), startTime: '12:00', endTime: '15:00', categoryId: 'play' },
    { id: '15', title: '友達と遊ぶ',        date: weekDate(5), startTime: '18:00', endTime: '23:00', categoryId: 'play' },
  ]
}

// ─── Services ──────────────────────────────────────────────────────────────
// 結合メモ：db.zip の migrations/ には profiles テーブル（Auth連携込み）だけが
// 適用済み。tasks / daily_summaries は future-migrations/ 配下でまだ本番DBに
// 反映されていないため、予定データと今日の総括履歴は引き続きlocalStorageの
// モックのまま。これらのマイグレーションが適用されたら scheduleService /
// summaryService を supabase.from('tasks') / supabase.from('daily_summaries')
// に置き換える。

// profiles テーブルには nickname/message/limitScore の列が無い
// （AI診断の演出用フィールドなのでDB設計上そもそも持たない）。
// max_workload_minutes だけをDBの正とし、演出用の値はそこから機械的に導く。
function deriveScoreFromCapacity(capacityMinutes: number): number {
  return Math.max(0, Math.min(100, Math.round(((capacityMinutes - 150) / 450) * 100)))
}
function deriveTraits(score: number): { nickname: string; message: string } {
  if (score >= 75) return { nickname: '鉄人28号', message: 'その生活をあと3日続けたら、人間ではなくなります。' }
  if (score >= 55) return { nickname: '意外と普通の人間', message: '無理はできる。でも無理した次の日はちゃんと死ぬタイプです。' }
  return { nickname: 'ガラスのメンタル', message: '予定を2つ入れただけでHPバーが黄色になっています。' }
}
function profileRowToUser(id: string, email: string, row: { name: string; max_workload_minutes: number }): User {
  const limitScore = deriveScoreFromCapacity(row.max_workload_minutes)
  const { nickname, message } = deriveTraits(limitScore)
  return { id, name: row.name || email.split('@')[0] || 'ユーザー', email, limitScore, nickname, message, capacityMinutes: row.max_workload_minutes }
}

const GUEST_STORAGE_KEY = 'planner-guest-user'

const authService = {
  // POST /api/auth/register 相当。Supabase Authでアカウントを作る。
  // プロジェクトでメール確認が有効な場合、成功してもセッションはまだ
  // 発行されない（ユーザーがメール内リンクを踏むまで）。
  register: async (name: string, email: string, password: string): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.signUp({ email, password, options: { data: { name } } })
    return { error: error?.message ?? null }
  },
  // POST /api/auth/login 相当。
  login: async (email: string, password: string): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  },
  logout: async () => {
    localStorage.removeItem(GUEST_STORAGE_KEY)
    await supabase.auth.signOut()
  },
  // GET /api/auth/me 相当：Supabase Authの現在ユーザー情報 + profilesテーブルを合成する。
  // VITE_USE_BACKEND=true のときは profiles を直接読まず、FastAPI の
  // GET /api/user/profile 経由で取得する（RLS はバックエンドでも効いている）。
  //
  // 【重要】404（プロフィール行がまだ無い）のときだけ null を返す。
  // それ以外の失敗（Renderのコールドスタート、ネットワークエラー、5xxなど）は
  // 例外を投げる。以前はここを一律 null に握りつぶしていたため、登録直後に
  // Renderがまだ起動しきっていないだけで silent に失敗し、オンボーディング
  // 完了時の profiles 更新がスキップされたままログイン画面に戻される、という
  // バグの原因になっていた（呼び出し側で「本当に404なのか」「単に今取得に
  // 失敗しただけなのか」を区別できないと直しようがない）。
  me: async (): Promise<User | null> => {
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser?.email) return null

    if (USE_BACKEND) {
      try {
        const p = await api.getProfile()
        return profileRowToUser(authUser.id, authUser.email, {
          name: p.name,
          max_workload_minutes: p.maxWorkloadMinutes,
        })
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    }

    const { data: profile, error } = await supabase
      .from('profiles').select('name, max_workload_minutes').eq('id', authUser.id).single()
    if (error) {
      // PGRST116 = 0行（RLSで弾かれた場合も同じコードになる）
      if (error.code === 'PGRST116') return null
      throw error
    }
    if (!profile) return null
    return profileRowToUser(authUser.id, authUser.email, profile)
  },
  // 登録直後に限り使う。profiles行はDBトリガーで即時作成されるはずだが、
  // Renderの無料枠がスリープから復帰中だと最初の1〜2回は失敗しうるため、
  // 短い間隔で数回だけ再試行する。それでも失敗したら例外を外に投げる
  // （呼び出し側で「登録は成功したが確認できなかった」と明示的に伝えるため）。
  meWithRetry: async (attempts = 4, delayMs = 700): Promise<User | null> => {
    let lastError: unknown = null
    for (let i = 0; i < attempts; i++) {
      try {
        return await authService.me()
      } catch (e) {
        lastError = e
        if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs))
      }
    }
    throw lastError
  },
  // オンボーディング完了時に呼ぶ。tasks/daily_summariesは未デプロイなので、
  // ここではprofilesの2カラムだけ更新する。
  updateProfile: async (patch: { name?: string; max_workload_minutes?: number; onboarding_completed?: boolean }) => {
    if (USE_BACKEND) {
      // API 側は camelCase なので境界で変換する
      await api.updateProfile({
        name: patch.name,
        maxWorkloadMinutes: patch.max_workload_minutes,
        onboardingCompleted: patch.onboarding_completed,
      })
      return
    }
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) return
    await supabase.from('profiles').update(patch).eq('id', authUser.id)
  },
  // ゲストお試しはSupabase側にアカウントを作らず、ブラウザ内だけで完結させる
  // （匿名認証はDB側で有効化されていないため）。再読み込みしても続けられる
  // よう、専用のlocalStorageキーにだけ退避する（本物のセッションではない）。
  loginGuest: (): User => {
    const limitScore = 70
    const user: User = {
      id: 'guest_' + Date.now(), name: 'ゲストユーザー', email: 'guest@example.com',
      limitScore, nickname: 'マイペース型', message: '無理のないペースで確実にこなすスタイルです。',
      capacityMinutes: scoreToCapacityMinutes(limitScore),
    }
    localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(user))
    return user
  },
  getGuestSession: (): User | null => {
    try { return JSON.parse(localStorage.getItem(GUEST_STORAGE_KEY) ?? 'null') } catch { return null }
  },
}

function isGuestId(id: string) { return id.startsWith('guest_') }

// ─── ゲスト用ローカル保存（Supabaseに実セッションを持たないため）─────────────
function loadLocalEvents(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem('planner-guest-events')
    if (raw) return JSON.parse(raw)
  } catch {}
  const init = buildInitialEvents()
  localStorage.setItem('planner-guest-events', JSON.stringify(init))
  return init
}
function saveLocalEvents(evs: CalendarEvent[]) { localStorage.setItem('planner-guest-events', JSON.stringify(evs)) }

// tasks テーブルの行 ⇔ CalendarEvent の変換。
// 【注意】tasksテーブルには description / priority のカラムが無いため、
// この2つは現状フロント側だけの一時的な状態（リロードすると消える）。
// 永続化したい場合はDB側に `description text` / `priority text` カラムの
// 追加が必要（担当の方に相談してください）。
type TaskRow = Database['public']['Tables']['tasks']['Row']

function pad2(n: number) { return String(Math.round(n)).padStart(2, '0') }
function minutesToHHMM(mins: number) { return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}` }

function taskRowToEvent(row: TaskRow): CalendarEvent {
  const startTime = row.start_time ? row.start_time.slice(0, 5) : '09:00'
  const startMinutes = parseTime(startTime) * 60
  const endTime = minutesToHHMM(startMinutes + row.planned_minutes)
  const cat = CATEGORIES.find(c => c.label === row.category)
  return {
    id: row.id,
    title: row.title,
    date: row.scheduled_date,
    startTime, endTime,
    categoryId: cat?.id ?? 'other',
    completed: row.is_completed,
    actualMinutes: row.actual_minutes ?? undefined,
  }
}
function eventToTaskPayload(ev: CalendarEvent) {
  return {
    title: ev.title,
    category: getCat(ev.categoryId).label,
    scheduled_date: ev.date,
    start_time: ev.startTime,
    planned_minutes: Math.max(1, Math.round((parseTime(ev.endTime) - parseTime(ev.startTime)) * 60)),
    actual_minutes: ev.actualMinutes ?? null,
    is_completed: !!ev.completed,
  }
}

// ─── バックエンド API 版の変換（camelCase）────────────────────────────────
// バックエンド経由の場合、snake_case ↔ camelCase の変換は FastAPI 側で
// 済んでいるので、フロントは camelCase をそのまま扱う。
function apiTaskToEvent(t: ApiTask): CalendarEvent {
  const startTime = t.startTime ? t.startTime.slice(0, 5) : '09:00'
  const endTime = minutesToHHMM(parseTime(startTime) * 60 + t.plannedMinutes)
  const cat = CATEGORIES.find(c => c.label === t.category)
  return {
    id: t.id,
    title: t.title,
    date: t.date,
    startTime, endTime,
    categoryId: cat?.id ?? 'other',
    completed: t.isCompleted,
    actualMinutes: t.actualMinutes ?? undefined,
  }
}
function eventToApiPayload(ev: CalendarEvent) {
  return {
    title: ev.title,
    category: getCat(ev.categoryId).label,
    date: ev.date,
    startTime: ev.startTime,
    plannedMinutes: Math.max(1, Math.round((parseTime(ev.endTime) - parseTime(ev.startTime)) * 60)),
  }
}
// カレンダーは前後の月も表示するため、単日ではなく期間で取得する
function calendarRange(): { from: string; to: string } {
  const shift = (days: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return d.toISOString().slice(0, 10)
  }
  return { from: shift(-180), to: shift(180) }
}

const scheduleService = {
  list: async (userId: string): Promise<CalendarEvent[]> => {
    if (isGuestId(userId)) return loadLocalEvents()
    if (USE_BACKEND) {
      try {
        const res = await api.listTasks(calendarRange())
        return res.tasks.map(apiTaskToEvent)
      } catch (e) {
        console.error('[api] タスク一覧の取得に失敗:', e)
        return []
      }
    }
    const { data, error } = await supabase.from('tasks').select('*').eq('user_id', userId).order('scheduled_date', { ascending: true })
    if (error || !data) return []
    return data.map(taskRowToEvent)
  },
  create: async (userId: string, ev: CalendarEvent): Promise<CalendarEvent> => {
    if (isGuestId(userId)) {
      const withId: CalendarEvent = { ...ev, id: ev.id || Date.now().toString() }
      saveLocalEvents([...loadLocalEvents(), withId])
      return withId
    }
    if (USE_BACKEND) {
      return apiTaskToEvent(await api.createTask(eventToApiPayload(ev)))
    }
    const { data, error } = await supabase.from('tasks')
      .insert({ user_id: userId, ...eventToTaskPayload(ev) }).select().single()
    if (error || !data) throw error ?? new Error('タスクの作成に失敗しました')
    return taskRowToEvent(data)
  },
  update: async (userId: string, ev: CalendarEvent): Promise<CalendarEvent> => {
    if (isGuestId(userId)) {
      const list = loadLocalEvents().map(e => e.id === ev.id ? ev : e)
      saveLocalEvents(list)
      return ev
    }
    if (USE_BACKEND) {
      return apiTaskToEvent(await api.updateTask(ev.id, {
        ...eventToApiPayload(ev),
        isCompleted: !!ev.completed,
        ...(ev.actualMinutes != null ? { actualMinutes: ev.actualMinutes } : {}),
      }))
    }
    const { data, error } = await supabase.from('tasks')
      .update(eventToTaskPayload(ev)).eq('id', ev.id).select().single()
    if (error || !data) throw error ?? new Error('タスクの更新に失敗しました')
    return taskRowToEvent(data)
  },
  remove: async (userId: string, id: string): Promise<void> => {
    if (isGuestId(userId)) { saveLocalEvents(loadLocalEvents().filter(e => e.id !== id)); return }
    if (USE_BACKEND) { await api.deleteTask(id); return }
    await supabase.from('tasks').delete().eq('id', id)
  },
}

// GET /api/daily-summary/history 相当。
const summaryService = {
  getHistory: async (userId: string): Promise<{ date: string; title: string; reason: string }[]> => {
    if (isGuestId(userId)) {
      try { return JSON.parse(localStorage.getItem(`planner-guest-summary-history-${userId}`) ?? '[]') } catch { return [] }
    }
    if (USE_BACKEND) {
      try {
        const res = await api.getDailySummaryHistory()
        return res.history.map(h => ({ date: h.date, title: h.title, reason: h.reason }))
      } catch (e) {
        console.error('[api] 称号履歴の取得に失敗:', e)
        return []
      }
    }
    const { data, error } = await supabase.from('daily_summaries')
      .select('summary_date, title, reason').eq('user_id', userId)
      .order('summary_date', { ascending: false }).limit(30)
    if (error || !data) return []
    return data.map(r => ({ date: r.summary_date, title: r.title, reason: r.reason }))
  },
  // バックエンド版は「称号の生成」と「履歴への保存」がAPI呼び出し1回で完結する
  // （main.py の POST /api/daily-summary/generate が生成と保存を両方やる）。
  // そのためこちらは Supabase 直アクセスの場合にのみ使う。
  saveToHistory: async (userId: string, entry: { date: string; title: string; reason: string }, totalFocusTimeMinutes: number) => {
    if (isGuestId(userId)) {
      const key = `planner-guest-summary-history-${userId}`
      let list: { date: string; title: string; reason: string }[] = []
      try { list = JSON.parse(localStorage.getItem(key) ?? '[]') } catch {}
      list = list.filter(h => h.date !== entry.date)
      list.unshift(entry)
      localStorage.setItem(key, JSON.stringify(list.slice(0, 30)))
      return
    }
    // summary_date は (user_id, summary_date) がユニーク制約なので、同じ日に
    // 再生成したときは上書き（upsert）される。
    await supabase.from('daily_summaries').upsert(
      { user_id: userId, summary_date: entry.date, title: entry.title, reason: entry.reason, total_focus_time_minutes: totalFocusTimeMinutes },
      { onConflict: 'user_id,summary_date' },
    )
  },
}

// POST /api/workload/calculate 相当。2人目のFastAPIコードと入出力の形を
// 完全に一致させてある：{ userId, tasks: [{title, estimatedMinutes}], capacityMinutes }
// を受け取り、バックエンド側と同じ計算式で { totalMinutes, capacityMinutes,
// workloadPercentage, workloadLevel } を返す。結合時はこの関数の中身を
// そのまま fetch('/api/workload/calculate', { body: JSON.stringify(req) }) に
// 差し替えるだけでよい。
function calcWorkload(req: WorkloadRequest): WorkloadResult {
  const totalMinutes = req.tasks.reduce((s, t) => s + t.estimatedMinutes, 0)
  const workloadPercentage = req.capacityMinutes > 0 ? Math.round((totalMinutes / req.capacityMinutes) * 100) : 0
  const workloadLevel: WorkloadLevel =
    workloadPercentage > 100 ? 'キャパオーバー' : workloadPercentage > 80 ? 'かなりキツい' : '適正'
  return { totalMinutes, capacityMinutes: req.capacityMinutes, workloadPercentage, workloadLevel }
}
function workloadLevelColor(level: WorkloadLevel) {
  return level === 'キャパオーバー' ? '#ef4444' : level === 'かなりキツい' ? '#f97316' : '#22c55e'
}

interface OnboardingAnswers {
  freeTimeMinutes: number
  sleepMinimumMinutes: number
  fixedCommitmentMinutes: number
  sustainableWorkMinutes: number
  maxEffortMinutes: number
}

// main.py の compute_sustainable_capacity と同じ計算式（USE_BACKEND=false の
// ローカルフォールバック用）。計算式を変えるときは両方直すこと。
function computeSustainableCapacityLocal(a: OnboardingAnswers): number {
  const blended = a.sustainableWorkMinutes * 0.7 + a.maxEffortMinutes * 0.3
  const physicalCeiling = Math.max(0, 24 * 60 - a.sleepMinimumMinutes - a.fixedCommitmentMinutes)
  const ceiling = a.freeTimeMinutes > 0 ? Math.min(physicalCeiling, a.freeTimeMinutes) : physicalCeiling
  const capacity = ceiling > 0 ? Math.min(blended, ceiling) : blended
  return Math.round(Math.max(60, Math.min(600, capacity)))
}

const aiService = {
  // POST /api/onboarding/calculate-capacity 相当。
  // USE_BACKEND=true のときは実際にRender側で計算・profiles保存まで行う。
  // false のときは同じ計算式をローカルで実行するだけ（保存はしない）。
  assessLimit: async (answers: OnboardingAnswers): Promise<AIResult> => {
    let capacityMinutes: number
    if (USE_BACKEND) {
      const res = await api.calculateCapacity(answers)
      capacityMinutes = res.capacityMinutes
    } else {
      await new Promise(r => setTimeout(r, 1200))
      capacityMinutes = computeSustainableCapacityLocal(answers)
    }
    const score = deriveScoreFromCapacity(capacityMinutes)
    const { nickname, message } = deriveTraits(score)
    return { score, nickname, message, capacityMinutes }
  },

  // POST /api/daily-summary/generate 相当。
  // USE_BACKEND=true のときは実際に main.py 経由でGeminiが称号を生成する。
  // 【方針転換】以前はバックエンド呼び出しが失敗したら黙ってローカルの
  // ダミー文言にフォールバックしていたが、今回の仕様で「Geminiが失敗したら
  // 偽の成功を返さず、失敗したとわかるようにする」方針に変更されたため、
  // USE_BACKEND=true のときは失敗をそのまま投げる（呼び出し元でエラー表示）。
  // ローカルダミーロジックは USE_BACKEND=false（バックエンド無しのPhase 1
  // デモモード）のときだけ使う。
  getDailyFeedback: async (
    userId: string,
    date: string,
    allTasks: { title: string; category: string; plannedMinutes: number; actualMinutes: number; completed: boolean }[],
    capacityMinutes: number,
    spice: AiSpice,
  ): Promise<AIDailyResult> => {
    const completedTasks = allTasks.filter(t => t.completed)
    const plannedMinutes = allTasks.reduce((s, t) => s + t.plannedMinutes, 0)
    const totalFocusTimeMinutes = completedTasks.reduce((s, t) => s + t.actualMinutes, 0)

    if (!isGuestId(userId) && USE_BACKEND) {
      const res = await api.generateDailySummary({
        date,
        capacityMinutes,
        plannedMinutes,
        actualMinutes: totalFocusTimeMinutes,
        completedTasks: completedTasks.map(t => ({
          title: t.title, category: t.category, plannedMinutes: t.plannedMinutes, actualMinutes: t.actualMinutes,
        })),
      })
      // main.py 側が daily_summaries への保存まで済ませているので、
      // ここで改めて summaryService.saveToHistory を呼ぶ必要はない。
      // overloadPct はバックエンドが計算した実績ベースの%をそのまま使う
      // （予定/実績どちらも計算はバックエンド側の役割、というルールを徹底する）。
      return { title: res.title, reason: res.reason, overloadPct: res.actualPercentage, nextAction: res.nextAction }
    }

    // ── ここから先は USE_BACKEND=false のときだけ通る Phase 1 ローカルロジック ──
    const workloadPercentage = capacityMinutes > 0 ? Math.round((totalFocusTimeMinutes / capacityMinutes) * 100) : 0
    await new Promise(r => setTimeout(r, 2200))
    const boost = spice === 'spicy' ? '（鬼設定）' : ''
    const n = completedTasks.length
    let result: AIDailyResult
    if (n === 0 || workloadPercentage < 15)
      result = { title: '今日ほぼ寝てたやん。', overloadPct: workloadPercentage, reason: `充電完了ですか？それとも単に怠けましたか？${boost}`, nextAction: '明日は地球防衛するレベルで動け。' }
    else if (workloadPercentage < 40)
      result = { title: 'まあ、普通ですかね。', overloadPct: workloadPercentage, reason: `人並みには動きました。でも「普通」で満足するな。${boost}`, nextAction: '明日はもう1件予定を入れてみろ。' }
    else if (workloadPercentage < 70)
      result = { title: '結構動いてますね。', overloadPct: workloadPercentage, reason: `${n}件こなして偉い。でも顔色が少し悪い気がします。${boost}`, nextAction: '今夜は12時前に寝ること。命令です。' }
    else if (workloadPercentage < 100)
      result = { title: '今日は動きすぎや！', overloadPct: workloadPercentage, reason: `よく稼働してるの人間ですか？${boost}`, nextAction: '明日はベッドから1歩も出るな。' }
    else
      result = { title: '予定表がもはや学生のものではありません。', overloadPct: workloadPercentage, reason: `この稼働は機械でも壊れます。あなた今絶対ボロボロです。${boost}`, nextAction: '明日の予定を3つキャンセルしてください。これは命令です。' }
    await summaryService.saveToHistory(userId, { date, title: result.title, reason: result.reason }, totalFocusTimeMinutes)
    return result
  },
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr() { return new Date().toISOString().slice(0, 10) }
function toDateStr(d: Date) { return d.toISOString().slice(0, 10) }
function parseTime(t: string) { const [h, m] = t.split(':').map(Number); return h + m / 60 }

function fmtTime(t: string, fmt: '12h' | '24h') {
  if (fmt === '24h') return t
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
}

// 旧 calcLoad は user.capacityMinutes を無視した固定しきい値だった（本人の
// 限界に対する負荷率という本アプリの核心ロジックとズレていたバグ）。
// calcWorkload（想定バックエンドAPIと同じ計算式・同じリクエスト形）を使うように統一する。
function getTodayLoad(userId: string, events: CalendarEvent[], date: string, capacityMinutes: number) {
  const evs = events.filter(e => e.date === date)
  const tasks: WorkloadTaskInput[] = evs.map(e => ({
    title: e.title,
    estimatedMinutes: Math.round((parseTime(e.endTime) - parseTime(e.startTime)) * 60),
  }))
  const workload = calcWorkload({ userId, tasks, capacityMinutes })
  return { hours: workload.totalMinutes / 60, workload }
}

function priorityColor(p?: 'low' | 'medium' | 'high') {
  return p === 'high' ? '#ef4444' : p === 'medium' ? '#f59e0b' : '#10b981'
}
function limitColor(score: number) {
  if (score >= 86) return '#ef4444'
  if (score >= 70) return '#f97316'
  if (score >= 40) return '#eab308'
  return '#22c55e'
}

function getWeekDates(anchor: Date, startMonday: boolean): Date[] {
  const d = new Date(anchor)
  const day = d.getDay()
  const offset = startMonday ? (day === 0 ? -6 : 1 - day) : -day
  d.setDate(d.getDate() + offset)
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return x })
}

function getMonthDates(year: number, month: number, startMonday: boolean): Date[] {
  const first = new Date(year, month, 1)
  const sd = first.getDay()
  const offset = startMonday ? (sd === 0 ? 6 : sd - 1) : sd
  const start = new Date(first)
  start.setDate(1 - offset)
  const total = offset + new Date(year, month + 1, 0).getDate()
  const weeks = Math.ceil(total / 7)
  return Array.from({ length: weeks * 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d })
}

const DAYS_JP  = ['日','月','火','水','木','金','土']
const DAYS_EN3 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const MONTHS_JP = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月']

// ─── Settings hook ────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = {
  theme: 'dark', fontSize: 'md', startMonday: true, timeFormat: '24h',
  defaultView: 'week', showWeekends: true, showWeekNumbers: false,
  aiEnabled: true, aiSpice: 'normal',
}
function loadSettings(): Settings {
  try { const r = localStorage.getItem('planner-settings'); if (r) return { ...DEFAULT_SETTINGS, ...JSON.parse(r) } } catch {}
  return DEFAULT_SETTINGS
}

function useSettings() {
  const [settings, setState] = useState<Settings>(loadSettings)
  useEffect(() => {
    localStorage.setItem('planner-settings', JSON.stringify(settings))
    let theme = settings.theme
    if (theme === 'system') theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.setAttribute('data-fontsize', settings.fontSize)
  }, [settings])
  const update = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) =>
    setState(p => ({ ...p, [k]: v })), [])
  return { settings, update }
}

// 既存のCSS(.sidebar / .bottom-nav)と同じ768pxのブレークポイントで判定する。
// スマホ幅では、PC向けの密なレイアウト（週7列グリッドなど）を
// 見やすい専用UIに切り替えるために使う。
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

// ─── UI Primitives ────────────────────────────────────────────────────────────

function LimitMeter({ score, size = 150 }: { score: number; size?: number }) {
  const r = (size - 18) / 2
  const circ = 2 * Math.PI * r
  const progress = (score / 100) * circ
  const color = limitColor(score)
  const cx = size / 2, cy = size / 2
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', transform: 'rotate(-90deg)' }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border-mid)" strokeWidth="10" />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="10"
          strokeDasharray={`${progress} ${circ}`} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 6px ${color}88)`, transition: 'stroke-dasharray 1.2s ease' }} />
      </svg>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: `${size * 0.2}px`, fontWeight: 500, color, lineHeight: 1 }}>{score}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: `${size * 0.09}px`, color: 'var(--text-dim)', marginTop: 2 }}>/ 100</div>
      </div>
    </div>
  )
}

function CategoryBadge({ cat, small }: { cat: Category; small?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: cat.bg, color: cat.color,
      fontFamily: 'var(--font-body)', fontSize: small ? 'var(--fs-2xs)' : 'var(--fs-xs)',
      fontWeight: 500, padding: small ? '2px 7px' : '3px 10px', borderRadius: 20,
    }}>
      <span style={{ width: small ? 5 : 6, height: small ? 5 : 6, borderRadius: '50%', background: cat.color, display: 'inline-block' }} />
      {cat.label}
    </span>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} style={{
      width: 42, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative',
      background: checked ? 'var(--accent)' : 'var(--border-mid)', flexShrink: 0,
    }}>
      <span style={{
        position: 'absolute', top: 4, left: checked ? 22 : 4, width: 16, height: 16,
        borderRadius: '50%', background: checked ? '#fff' : 'var(--text-dim)', transition: 'left 0.2s',
      }} />
    </button>
  )
}

function SegControl<T extends string>({ options, value, onChange, small }: {
  options: { value: T; label: React.ReactNode }[]; value: T; onChange: (v: T) => void; small?: boolean
}) {
  return (
    <div style={{ display: 'flex', background: 'var(--surface)', border: '1px solid var(--border-mid)', borderRadius: 10, padding: 3, gap: 2 }}>
      {options.map(o => (
        <button key={String(o.value)} onClick={() => onChange(o.value)} style={{
          flex: 1, padding: small ? '4px 7px' : '6px 10px',
          border: 'none', borderRadius: 7, cursor: 'pointer',
          background: value === o.value ? 'var(--surface-raised)' : 'transparent',
          color: value === o.value ? 'var(--text)' : 'var(--text-muted)',
          fontFamily: 'var(--font-body)', fontSize: small ? 'var(--fs-2xs)' : 'var(--fs-xs)', fontWeight: value === o.value ? 600 : 400,
          boxShadow: value === o.value ? 'var(--shadow-sm)' : 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          whiteSpace: 'nowrap',
        }}>{o.label}</button>
      ))}
    </div>
  )
}

function Btn({ label, onClick, variant = 'primary', full }: { label: React.ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; full?: boolean }) {
  const styles: React.CSSProperties = {
    width: full ? '100%' : undefined, padding: '12px 24px', borderRadius: 12, border: 'none',
    cursor: 'pointer', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 'var(--fs-base)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    ...(variant === 'primary' ? { background: 'var(--accent)', color: '#fff' }
      : variant === 'secondary' ? { background: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border-mid)' }
      : variant === 'danger' ? { background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }
      : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)' }),
  }
  return <button style={styles} onClick={onClick}
    onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
    onMouseLeave={e => e.currentTarget.style.opacity = '1'}>{label}</button>
}

function InputField({ label, type = 'text', value, onChange, placeholder }: {
  label: string; type?: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  const [focus, setFocus] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '0.1em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          background: 'var(--surface-raised)', border: `1px solid ${focus ? 'var(--accent)' : 'var(--border-mid)'}`,
          borderRadius: 10, color: 'var(--text)', fontFamily: 'var(--font-body)', fontSize: 'var(--fs-base)',
          padding: '12px 14px', outline: 'none', width: '100%', colorScheme: 'dark',
        }}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} />
    </div>
  )
}

// ─── Login Screen ─────────────────────────────────────────────────────────────

function LoginScreen({ onLogin, onRegister, notice }: { onLogin: (u: User) => void; onRegister: () => void; notice?: string | null }) {
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function loginWith(e: string, p: string) {
    if (!e || !p) { setErr('メールアドレスとパスワードを入力してください'); return false }
    const { error } = await authService.login(e, p)
    if (error) { setErr(error); return false }
    try {
      const user = await authService.me()
      if (!user) { setErr('プロフィールが見つかりませんでした。運営にお問い合わせください。'); return false }
      onLogin(user)
      return true
    } catch {
      setErr('ユーザー情報の取得に失敗しました。サーバーが起動中の可能性があります。少し待ってからもう一度お試しください。')
      return false
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setLoading(true)
    await loginWith(email, pass)
    setLoading(false)
  }

  async function handleDemo() {
    setErr(''); setLoading(true)
    const { error } = await authService.login('demo@example.com', 'password')
    if (error) {
      setErr('デモアカウントが見つかりませんでした。Supabase側で demo@example.com / password のアカウントを作成してください。')
      setLoading(false)
      return
    }
    try {
      const user = await authService.me()
      setLoading(false)
      if (user) onLogin(user)
      else setErr('デモアカウントのプロフィール取得に失敗しました。profilesテーブルの作成に失敗している可能性があります。')
    } catch {
      setLoading(false)
      setErr('ユーザー情報の取得に失敗しました。サーバーが起動中の可能性があります。少し待ってからもう一度お試しください。')
    }
  }

  function handleGuest() {
    onLogin(authService.loginGuest())
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', background: 'var(--bg)' }}>
      <div className="fade-up" style={{ width: '100%', maxWidth: 400 }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--accent)', letterSpacing: '0.18em', marginBottom: 8 }}>STUDENT AI SCHEDULER</div>
          <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--fs-2xl)', fontWeight: 300, color: 'var(--text)', lineHeight: 1 }}>Planner</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginTop: 8 }}>AIがあなたの限界を見極めます</div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {notice && (
            <div style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent-mid)', borderRadius: 8, padding: '10px 14px', color: 'var(--accent)', fontSize: 'var(--fs-sm)' }}>{notice}</div>
          )}
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <InputField label="メールアドレス" type="email" value={email} onChange={setEmail} placeholder="demo@example.com" />
            <InputField label="パスワード" type="password" value={pass} onChange={setPass} placeholder="••••••••" />
            {err && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', color: '#ef4444', fontSize: 'var(--fs-sm)' }}>{err}</div>}
            <button type="submit" disabled={loading} style={{
              background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 12, padding: '13px',
              fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 'var(--fs-base)', cursor: 'pointer',
              opacity: loading ? 0.6 : 1,
            }}>{loading ? '確認中……' : 'ログイン'}</button>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)' }}>または</span>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          </div>

          <button onClick={handleDemo} style={{
            background: 'var(--ai-dim)', border: '1px solid var(--ai-mid)', color: 'var(--ai)',
            borderRadius: 12, padding: '12px', fontFamily: 'var(--font-body)', fontWeight: 600,
            fontSize: 'var(--fs-base)', cursor: 'pointer', width: '100%',
          }}>⚡ デモアカウントで試す</button>

          <button onClick={handleGuest} style={{
            background: 'transparent', border: '1px solid var(--border-mid)', color: 'var(--text-muted)',
            borderRadius: 12, padding: '12px', fontFamily: 'var(--font-body)', fontWeight: 600,
            fontSize: 'var(--fs-base)', cursor: 'pointer', width: '100%',
          }}>ゲストとして体験する</button>
        </div>

        <div style={{ textAlign: 'center', marginTop: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={onRegister} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 'var(--fs-sm)', cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
            アカウントをお持ちでない方はこちら
          </button>
          <button style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 'var(--fs-sm)', cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
            パスワードを忘れた場合
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Register Screen ──────────────────────────────────────────────────────────

function RegisterScreen({ onRegister, onBack }: { onRegister: (name: string, email: string, password: string) => Promise<string | null>; onBack: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [passConf, setPassConf] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !email.trim()) { setErr('お名前とメールアドレスを入力してください'); return }
    if (pass !== passConf) { setErr('パスワードが一致しません'); return }
    if (pass.length < 6) { setErr('パスワードは6文字以上必要です'); return }
    setErr(''); setLoading(true)
    const error = await onRegister(name.trim(), email.trim(), pass)
    setLoading(false)
    if (error) setErr(error)
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
      <div className="fade-up" style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ marginBottom: 32 }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-sm)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>← 戻る</button>
          <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--fs-xl)', fontWeight: 300, color: 'var(--text)' }}>新規登録</div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginTop: 4 }}>登録後、AIがあなたの限界を査定します</div>
        </div>
        <div className="card">
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <InputField label="お名前 / ニックネーム" value={name} onChange={setName} placeholder="山田 太郎" />
            <InputField label="メールアドレス" type="email" value={email} onChange={setEmail} />
            <InputField label="パスワード" type="password" value={pass} onChange={setPass} />
            <InputField label="パスワード確認" type="password" value={passConf} onChange={setPassConf} />
            {err && <div style={{ color: '#ef4444', fontSize: 'var(--fs-sm)', background: 'rgba(239,68,68,0.1)', padding: '10px 14px', borderRadius: 8 }}>{err}</div>}
            <Btn label={loading ? '登録中……' : 'アカウントを作成'} full />
          </form>
        </div>
      </div>
    </div>
  )
}

// ─── Onboarding Screen ────────────────────────────────────────────────────────

const ONBOARDING_QUESTIONS: {
  key: keyof OnboardingAnswers
  q: string
  hint?: string
  opts: { label: string; minutes: number }[]
}[] = [
  {
    key: 'freeTimeMinutes',
    q: '授業・バイト・通学などを除いて、1日に自由に使える時間はどれくらい？',
    opts: [
      { label: '30分くらい', minutes: 30 },
      { label: '1時間くらい', minutes: 60 },
      { label: '2時間くらい', minutes: 120 },
      { label: '3時間くらい', minutes: 180 },
      { label: '4時間以上', minutes: 240 },
    ],
  },
  {
    key: 'sleepMinimumMinutes',
    q: '最低限これだけは確保したい睡眠時間は？',
    opts: [
      { label: '5時間', minutes: 300 },
      { label: '6時間', minutes: 360 },
      { label: '7時間', minutes: 420 },
      { label: '8時間', minutes: 480 },
      { label: '9時間以上', minutes: 540 },
    ],
  },
  {
    key: 'fixedCommitmentMinutes',
    q: '授業・バイト・通学など、動かせない固定の予定に1日で使う時間は？',
    opts: [
      { label: '2時間以下', minutes: 120 },
      { label: '4時間くらい', minutes: 240 },
      { label: '6時間くらい', minutes: 360 },
      { label: '8時間くらい', minutes: 480 },
      { label: '10時間以上', minutes: 600 },
    ],
  },
  {
    key: 'sustainableWorkMinutes',
    q: '普段、無理なく続けられる勉強・作業時間はどれくらい？',
    hint: '「毎日これくらいならしんどくない」という時間',
    opts: [
      { label: '30分くらい', minutes: 30 },
      { label: '1時間くらい', minutes: 60 },
      { label: '2時間くらい', minutes: 120 },
      { label: '3時間くらい', minutes: 180 },
      { label: '4時間以上', minutes: 240 },
    ],
  },
  {
    key: 'maxEffortMinutes',
    q: 'かなり頑張った日、「これ以上はさすがに厳しい」という作業時間は？',
    hint: '普段の量ではなく"最大値"の感覚で選んでください',
    opts: [
      { label: '2時間くらい', minutes: 120 },
      { label: '3時間くらい', minutes: 180 },
      { label: '4時間くらい', minutes: 240 },
      { label: '6時間くらい', minutes: 360 },
      { label: '8時間以上', minutes: 480 },
    ],
  },
]

function OnboardingScreen({ onComplete, onSkip }: { onComplete: (answers: OnboardingAnswers) => void; onSkip: () => void }) {
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Partial<OnboardingAnswers>>({})
  const q = ONBOARDING_QUESTIONS[step]
  const total = ONBOARDING_QUESTIONS.length

  function choose(minutes: number) {
    const next = { ...answers, [q.key]: minutes }
    if (step + 1 >= total) onComplete(next as OnboardingAnswers)
    else { setAnswers(next); setStep(s => s + 1) }
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', padding: '32px 20px', maxWidth: 480, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 48 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--accent)', letterSpacing: '0.15em', marginBottom: 12 }}>
          STEP {step + 1} / {total}
        </div>
        {/* Progress bar */}
        <div style={{ height: 3, background: 'var(--border-mid)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${((step + 1) / total) * 100}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width 0.4s ease' }} />
        </div>
      </div>

      {/* Question */}
      <div className="fade-up" key={step} style={{ flex: 1 }}>
        <div style={{ marginBottom: 12 }}>
          <span style={{ background: 'var(--ai-dim)', color: 'var(--ai)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', padding: '3px 10px', borderRadius: 20, letterSpacing: '0.08em' }}>
            AI 限界測定
          </span>
        </div>
        <h2 style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-xl)', color: 'var(--text)', marginBottom: q.hint ? 8 : 36, lineHeight: 1.3 }}>{q.q}</h2>
        {q.hint && <p style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 28 }}>{q.hint}</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {q.opts.map((opt, i) => (
            <button key={i} onClick={() => choose(opt.minutes)} style={{
              background: 'var(--surface-raised)', border: '1.5px solid var(--border-mid)',
              borderRadius: 14, padding: '16px 20px', textAlign: 'left',
              fontFamily: 'var(--font-body)', fontSize: 'var(--fs-md)', color: 'var(--text)',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-dim)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-mid)'; e.currentTarget.style.background = 'var(--surface-raised)' }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', marginRight: 12 }}>{String.fromCharCode(65 + i)}</span>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <button onClick={onSkip} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 'var(--fs-sm)', cursor: 'pointer', marginTop: 32 }}>
        スキップして始める
      </button>
    </div>
  )
}

// ─── Assessing Screen ─────────────────────────────────────────────────────────

const AI_LOADING_MSGS = [
  'あなたの回答を解析中……',
  '限界値を計算中……',
  '人類比較データベースと照合中……',
  'Geminiに査定してもらっています……',
  '結果を準備中……',
]

function AssessingScreen() {
  const [msgIdx, setMsgIdx] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setMsgIdx(i => (i + 1) % AI_LOADING_MSGS.length), 650)
    return () => clearInterval(id)
  }, [])
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 32, padding: 24 }}>
      <div style={{ width: 72, height: 72, borderRadius: '50%', border: '3px solid var(--border-mid)', borderTopColor: 'var(--ai)', animation: 'spin 1s linear infinite' }} />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ai)', letterSpacing: '0.1em', marginBottom: 12 }}>AI ASSESSING</div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-lg)', color: 'var(--text)', animation: 'pulse 1.2s ease infinite' }}>
          {AI_LOADING_MSGS[msgIdx]}
        </div>
      </div>
    </div>
  )
}

// ─── AI Result Screen ─────────────────────────────────────────────────────────

function AIResultScreen({ result, onStart }: { result: AIResult; onStart: () => void }) {
  const color = limitColor(result.score)
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 20px' }}>
      <div className="scale-in" style={{ width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ai)', letterSpacing: '0.15em', textAlign: 'center', marginBottom: 8 }}>LIMIT ASSESSMENT</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', textAlign: 'center', letterSpacing: '0.08em' }}>あなたの限界スコア</div>
        </div>

        <div className="ai-glow" style={{ padding: 24, borderRadius: '50%', background: 'var(--surface-raised)' }}>
          <LimitMeter score={result.score} size={180} />
        </div>

        <div style={{ textAlign: 'center', width: '100%' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 8 }}>二つ名</div>
          <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--fs-xl)', color, fontWeight: 500, marginBottom: 20 }}>
            「{result.nickname}」
          </div>

          <div style={{ background: 'var(--surface-raised)', border: `1px solid ${color}44`, borderLeft: `3px solid ${color}`, borderRadius: 12, padding: '18px 20px', textAlign: 'left' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', marginBottom: 8, letterSpacing: '0.08em' }}>AI より</div>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-md)', color: 'var(--text)', lineHeight: 1.65 }}>「{result.message}」</p>
          </div>
        </div>

        <Btn label="この結果で始める →" onClick={onStart} full />
      </div>
    </div>
  )
}

// ─── Event Modal ──────────────────────────────────────────────────────────────

interface EventModalProps {
  event?: CalendarEvent; defaultDate?: string; timeFormat: '12h' | '24h'
  onClose: () => void; onSave: (e: CalendarEvent) => void; onDelete?: (id: string) => void
}

function EventModal({ event, defaultDate, timeFormat, onClose, onSave, onDelete }: EventModalProps) {
  const isEdit = !!event
  const [title, setTitle]           = useState(event?.title ?? '')
  const [date, setDate]             = useState(event?.date ?? defaultDate ?? todayStr())
  const [startTime, setStartTime]   = useState(event?.startTime ?? '10:00')
  const [endTime, setEndTime]       = useState(event?.endTime ?? '11:00')
  const [catId, setCatId]           = useState(event?.categoryId ?? 'class')
  const [desc, setDesc]             = useState(event?.description ?? '')
  const [priority, setPriority]     = useState<'low' | 'medium' | 'high'>(event?.priority ?? 'medium')
  const plannedMinutes = Math.round((parseTime(endTime) - parseTime(startTime)) * 60)
  const [actualMinutes, setActualMinutes] = useState(event?.actualMinutes ?? plannedMinutes)
  const [focus, setFocus]           = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    onSave({ id: event?.id ?? Date.now().toString(), title: title.trim(), date, startTime, endTime, categoryId: catId, description: desc.trim() || undefined, priority, completed: event?.completed, actualMinutes })
    onClose()
  }

  const iStyle = (f: string): React.CSSProperties => ({
    background: 'var(--surface)', border: `1px solid ${focus === f ? 'var(--accent)' : 'var(--border-mid)'}`,
    borderRadius: 10, color: 'var(--text)', fontFamily: 'var(--font-body)', fontSize: 'var(--fs-base)',
    padding: '10px 14px', outline: 'none', width: '100%', colorScheme: 'dark',
  })

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', padding: '16px' }}
      onClick={onClose}>
      <div className="card scale-in" style={{ width: '100%', maxWidth: 480, padding: 24, borderRadius: 20 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-lg)', color: 'var(--text)' }}>{isEdit ? '予定を編集' : '予定を追加'}</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            {isEdit && onDelete && (
              <button onClick={() => { onDelete(event!.id); onClose() }} style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', width: 32, height: 32, borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>🗑</button>
            )}
            <button onClick={onClose} style={{ background: 'var(--surface)', border: '1px solid var(--border-mid)', color: 'var(--text-muted)', width: 32, height: 32, borderRadius: '50%', cursor: 'pointer', fontSize: 12 }}>✕</button>
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 6 }}>タイトル</label>
            <input ref={ref} value={title} onChange={e => setTitle(e.target.value)} placeholder="予定名" required style={iStyle('title')} onFocus={() => setFocus('title')} onBlur={() => setFocus('')} />
          </div>

          <div>
            <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 8 }}>カテゴリ</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {CATEGORIES.map(cat => (
                <button key={cat.id} type="button" onClick={() => setCatId(cat.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 20, cursor: 'pointer',
                  border: catId === cat.id ? `1.5px solid ${cat.color}` : '1.5px solid var(--border-mid)',
                  background: catId === cat.id ? cat.bg : 'transparent',
                  color: catId === cat.id ? cat.color : 'var(--text-muted)',
                  fontFamily: 'var(--font-body)', fontSize: 'var(--fs-xs)', fontWeight: catId === cat.id ? 600 : 400,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: cat.color }} />
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 8 }}>優先度</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['low', 'medium', 'high'] as const).map(p => (
                <button key={p} type="button" onClick={() => setPriority(p)} style={{
                  flex: 1, padding: '8px', borderRadius: 8, cursor: 'pointer',
                  border: priority === p ? `1.5px solid ${priorityColor(p)}` : '1.5px solid var(--border-mid)',
                  background: priority === p ? `${priorityColor(p)}22` : 'transparent',
                  color: priority === p ? priorityColor(p) : 'var(--text-muted)',
                  fontFamily: 'var(--font-body)', fontSize: 'var(--fs-xs)', fontWeight: priority === p ? 600 : 400,
                }}>
                  {p === 'low' ? '低' : p === 'medium' ? '中' : '高'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 6 }}>日付</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...iStyle('date'), colorScheme: 'dark' }} onFocus={() => setFocus('date')} onBlur={() => setFocus('')} />
          </div>

          {event?.completed && (
            <div>
              <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 6 }}>
                実績時間（分）— 今日の総括に使われます
              </label>
              <input type="number" min={0} value={actualMinutes} onChange={e => setActualMinutes(Math.max(0, Number(e.target.value)))} style={iStyle('actual')} onFocus={() => setFocus('actual')} onBlur={() => setFocus('')} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            {['開始', '終了'].map((lbl, idx) => (
              <div key={lbl} style={{ flex: 1 }}>
                <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 6 }}>{lbl}</label>
                <input type="time" value={idx === 0 ? startTime : endTime}
                  onChange={e => idx === 0 ? setStartTime(e.target.value) : setEndTime(e.target.value)}
                  style={{ ...iStyle(`time${idx}`), colorScheme: 'dark' }} onFocus={() => setFocus(`time${idx}`)} onBlur={() => setFocus('')} />
              </div>
            ))}
          </div>

          <div>
            <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 6 }}>メモ（任意）</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="詳細を入力…"
              style={{ ...iStyle('desc'), resize: 'vertical' }} onFocus={() => setFocus('desc')} onBlur={() => setFocus('')} />
          </div>

          <button type="submit" style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 12, padding: '13px', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 'var(--fs-base)', cursor: 'pointer', marginTop: 4 }}>
            {isEdit ? '更新する' : '保存する'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ─── Dashboard Screen ─────────────────────────────────────────────────────────

function DashboardScreen({ user, events, settings, onAddEvent, onEditEvent, onToggleComplete, onAISummary }: {
  user: User; events: CalendarEvent[]; settings: Settings
  onAddEvent: (date?: string) => void; onEditEvent: (e: CalendarEvent) => void
  onToggleComplete: (id: string) => void; onAISummary: () => void
}) {
  const today = todayStr()
  const todayEvs = events.filter(e => e.date === today).sort((a, b) => a.startTime.localeCompare(b.startTime))
  const load = getTodayLoad(user.id, events, today, user.capacityMinutes)
  const now = new Date()
  const dateLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${DAYS_JP[now.getDay()]}）`
  const hour = now.getHours()
  const greeting = hour < 12 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'お疲れ様です'

  return (
    <div style={{ padding: '24px 16px 32px', maxWidth: 600, margin: '0 auto' }}>
      {/* Header */}
      <div className="fade-up" style={{ marginBottom: 28 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', letterSpacing: '0.08em', marginBottom: 4 }}>{dateLabel}</div>
        <h1 style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-xl)', color: 'var(--text)', lineHeight: 1.2 }}>
          {greeting}、<span style={{ color: 'var(--accent)' }}>{user.name}</span>さん
        </h1>
      </div>

      {/* Stats row */}
      <div className="fade-up" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
        {/* Limit meter card */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '20px 16px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em' }}>LIMIT</div>
          <LimitMeter score={user.limitScore} size={100} />
          <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--fs-sm)', color: limitColor(user.limitScore), textAlign: 'center' }}>
            「{user.nickname}」
          </div>
        </div>

        {/* Today's load card */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em' }}>今日の負荷</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xl)', fontWeight: 500, color: workloadLevelColor(load.workload.workloadLevel), lineHeight: 1 }}>{load.workload.workloadLevel}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            {Math.round(load.hours * 10) / 10}h / {todayEvs.length}件（{load.workload.workloadPercentage}%）
          </div>
          <div style={{ marginTop: 'auto' }}>
            <div style={{ height: 6, background: 'var(--border-mid)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min(load.workload.workloadPercentage, 100)}%`, background: workloadLevelColor(load.workload.workloadLevel), borderRadius: 3, transition: 'width 1s ease' }} />
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)' }}>
            1日の上限 {Math.floor(user.capacityMinutes / 60)}時間{user.capacityMinutes % 60}分
          </div>
        </div>
      </div>

      {/* AI Summary CTA */}
      {settings.aiEnabled && (
        <div className="fade-up" style={{ marginBottom: 20 }}>
          <button onClick={onAISummary} style={{
            width: '100%', padding: '16px 20px', borderRadius: 14,
            background: 'var(--ai-dim)', border: '1.5px solid var(--ai-mid)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            cursor: 'pointer',
          }}>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--ai)', letterSpacing: '0.1em', marginBottom: 2 }}>AI FEEDBACK</div>
              <div style={{ fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 'var(--fs-base)', color: 'var(--text)' }}>今日の総括を見る</div>
            </div>
            <div style={{ background: 'var(--ai)', color: '#000', width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18, flexShrink: 0 }}>⚡</div>
          </button>
        </div>
      )}

      {/* Today's schedule */}
      <div className="fade-up">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-md)', color: 'var(--text)' }}>今日の予定</h2>
          <button onClick={() => onAddEvent(today)} style={{
            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8,
            padding: '6px 14px', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 'var(--fs-xs)', cursor: 'pointer',
          }}>+ 追加</button>
        </div>

        {todayEvs.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '32px 20px' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>😴</div>
            <div style={{ fontFamily: 'var(--font-body)', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>今日は予定がありません</div>
            <div style={{ fontFamily: 'var(--font-body)', color: 'var(--text-dim)', fontSize: 'var(--fs-xs)', marginTop: 4 }}>AIに「ほぼ寝てたやん」と言われる日です</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {todayEvs.map(ev => {
              const cat = getCat(ev.categoryId)
              return (
                <div key={ev.id} onClick={() => onEditEvent(ev)}
                  style={{ display: 'flex', gap: 14, alignItems: 'center', background: 'var(--surface-raised)', border: '1px solid var(--border)', borderLeft: `3px solid ${cat.color}`, borderRadius: '0 12px 12px 0', padding: '12px 16px', cursor: 'pointer', transition: 'all 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--surface-raised)'}
                >
                  <input type="checkbox" checked={!!ev.completed} onClick={e => e.stopPropagation()} onChange={() => onToggleComplete(ev.id)}
                    style={{ width: 18, height: 18, flexShrink: 0, cursor: 'pointer', accentColor: 'var(--accent)' }} />
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', minWidth: 80 }}>
                    {fmtTime(ev.startTime, settings.timeFormat)}
                  </div>
                  <div style={{ flex: 1, fontFamily: 'var(--font-body)', fontWeight: 500, fontSize: 'var(--fs-base)', color: ev.completed ? 'var(--text-dim)' : 'var(--text)', textDecoration: ev.completed ? 'line-through' : 'none' }}>{ev.title}</div>
                  {ev.priority && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: priorityColor(ev.priority), border: `1px solid ${priorityColor(ev.priority)}55`, borderRadius: 4, padding: '1px 6px' }}>
                      {ev.priority.toUpperCase()}
                    </span>
                  )}
                  <CategoryBadge cat={cat} small />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Calendar: Week View ──────────────────────────────────────────────────────

function WeekView({ anchor, events, settings, selectedDate, onSelectDate, onAddEvent, onEditEvent }: {
  anchor: Date; events: CalendarEvent[]; settings: Settings; selectedDate: string
  onSelectDate: (d: string) => void; onAddEvent: (d: string) => void; onEditEvent: (e: CalendarEvent) => void
}) {
  const { startMonday, showWeekends, timeFormat } = settings
  const allDays = getWeekDates(anchor, startMonday)
  const allShownDays = showWeekends ? allDays : allDays.filter(d => d.getDay() !== 0 && d.getDay() !== 6)
  const isMobile = useIsMobile()
  // スマホでは7列を並べると文字も予定ブロックも潰れて読めなくなるため、
  // 「その日だけを1列で見る」アジェンダ表示に切り替える。週の概念自体は
  // 上部の日付ピル(横スクロール)で維持しているので、基本UIの骨格は同じ。
  const days = isMobile
    ? [allShownDays.find(d => toDateStr(d) === selectedDate) ?? allShownDays[0]]
    : allShownDays
  const today = todayStr()
  const CELL_H = 64, START_H = 7
  const HOURS = Array.from({ length: 15 }, (_, i) => i + START_H)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {isMobile && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 12px', overflowX: 'auto', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
          {allShownDays.map((d, i) => {
            const ds = toDateStr(d)
            const isToday = ds === today
            const isSel = ds === selectedDate
            return (
              <button key={i} onClick={() => onSelectDate(ds)} style={{
                flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                width: 42, padding: '6px 0', border: 'none', borderRadius: 10, cursor: 'pointer',
                background: isSel ? 'var(--accent-dim)' : 'transparent',
              }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: isSel ? 'var(--accent)' : 'var(--text-dim)', letterSpacing: '0.05em' }}>{DAYS_EN3[d.getDay()]}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', fontFamily: 'var(--font-body)', fontWeight: isToday || isSel ? 700 : 400, fontSize: 'var(--fs-sm)', color: isToday ? '#fff' : 'var(--text)', background: isToday ? 'var(--accent)' : 'transparent' }}>{d.getDate()}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Day headers (desktop only — mobile uses the day-pill strip above) */}
      {!isMobile && (
        <div style={{ display: 'grid', gridTemplateColumns: `44px repeat(${days.length}, 1fr)`, borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--surface)' }}>
          <div />
          {days.map((d, i) => {
            const ds = toDateStr(d)
            const isToday = ds === today
            const isSel = ds === selectedDate
            const isWeekend = d.getDay() === 0 || d.getDay() === 6
            return (
              <div key={i} onClick={() => onSelectDate(ds)}
                style={{ padding: '8px 0 10px', textAlign: 'center', cursor: 'pointer', borderLeft: '1px solid var(--border)', background: isSel ? 'var(--col-selected)' : 'transparent', borderBottom: isSel ? '2px solid var(--accent)' : '2px solid transparent', transition: 'all 0.15s' }}
                onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--surface-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = isSel ? 'var(--col-selected)' : 'transparent' }}
              >
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: isSel ? 'var(--accent)' : isWeekend ? 'var(--text-dim)' : 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 4 }}>{DAYS_EN3[d.getDay()]}</div>
                <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: '50%', fontFamily: 'var(--font-body)', fontWeight: isToday ? 700 : 400, fontSize: 'var(--fs-sm)', color: isToday ? '#fff' : isWeekend ? 'var(--text-muted)' : 'var(--text)', background: isToday ? 'var(--accent)' : 'transparent' }}>
                  {d.getDate()}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Time grid */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `44px repeat(${days.length}, 1fr)` }}>
          <div>
            {HOURS.map(h => (
              <div key={h} style={{ height: CELL_H, display: 'flex', alignItems: 'flex-start', paddingTop: 5, paddingRight: 6, justifyContent: 'flex-end' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', lineHeight: 1, whiteSpace: 'nowrap' }}>
                  {timeFormat === '24h' ? `${h}:00` : `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`}
                </span>
              </div>
            ))}
          </div>
          {days.map((d, di) => {
            const ds = toDateStr(d)
            const isToday = ds === today
            const isSel = ds === selectedDate
            const dayEvs = events.filter(e => e.date === ds)
            return (
              <div key={di} style={{ position: 'relative', borderLeft: '1px solid var(--border)', background: isSel ? 'var(--col-selected)' : 'transparent' }}>
                {HOURS.map(h => (
                  <div key={h} onClick={() => { onSelectDate(ds); onAddEvent(ds) }}
                    style={{ height: CELL_H, borderTop: '1px solid var(--border)', background: isToday && h % 2 === 0 ? 'var(--accent-dim)' : 'transparent', cursor: 'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = isToday && h % 2 === 0 ? 'var(--accent-dim)' : 'transparent'}
                  />
                ))}
                {dayEvs.map(ev => {
                  const cat = getCat(ev.categoryId)
                  const top = (parseTime(ev.startTime) - START_H) * CELL_H
                  const height = Math.max((parseTime(ev.endTime) - parseTime(ev.startTime)) * CELL_H - 2, 20)
                  return (
                    <div key={ev.id} onClick={e => { e.stopPropagation(); onEditEvent(ev) }}
                      style={{ position: 'absolute', top, left: 3, right: 3, height, background: cat.bg, borderLeft: `3px solid ${cat.color}`, borderRadius: '0 8px 8px 0', padding: '4px 6px', overflow: 'hidden', cursor: 'pointer', transition: 'filter 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.filter = 'brightness(1.25)'}
                      onMouseLeave={e => e.currentTarget.style.filter = 'none'}
                    >
                      <div style={{ fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 'var(--fs-xs)', color: cat.color, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{ev.title}</div>
                      {height > 36 && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)' }}>{fmtTime(ev.startTime, timeFormat)}–{fmtTime(ev.endTime, timeFormat)}</div>}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Calendar: Month View ─────────────────────────────────────────────────────

function MonthView({ year, month, events, settings, onAddEvent, onEditEvent }: {
  year: number; month: number; events: CalendarEvent[]; settings: Settings
  onAddEvent: (d: string) => void; onEditEvent: (e: CalendarEvent) => void
}) {
  const { startMonday, showWeekends, showWeekNumbers } = settings
  const dates = getMonthDates(year, month, startMonday)
  const today = todayStr()
  const headers = startMonday ? [...DAYS_JP.slice(1), DAYS_JP[0]] : DAYS_JP
  const visHeaders = showWeekends ? headers : headers.filter((_, i) => { const d = startMonday ? (i + 1) % 7 : i; return d !== 0 && d !== 6 })
  const visDates = showWeekends ? dates : dates.filter(d => d.getDay() !== 0 && d.getDay() !== 6)
  const cols = showWeekends ? 7 : 5
  const weeks: Date[][] = []
  for (let i = 0; i < visDates.length; i += cols) weeks.push(visDates.slice(i, i + cols))

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `${showWeekNumbers ? '28px ' : ''}repeat(${cols}, 1fr)`, borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
        {showWeekNumbers && <div />}
        {visHeaders.map((d, i) => <div key={i} style={{ padding: '10px 0', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.08em' }}>{d}</div>)}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ flex: 1, display: 'flex', borderTop: wi > 0 ? '1px solid var(--border)' : 'none', minHeight: 0 }}>
            {showWeekNumbers && (
              <div style={{ width: 28, flexShrink: 0, display: 'flex', alignItems: 'flex-start', paddingTop: 6, justifyContent: 'center', borderRight: '1px solid var(--border)' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.46rem', color: 'var(--text-dim)' }}>W{Math.ceil((new Date(week[0]).getTime() - new Date(year, 0, 1).getTime()) / 604800000)}</span>
              </div>
            )}
            {week.map((d, di) => {
              const ds = toDateStr(d)
              const isThisMonth = d.getMonth() === month
              const isToday = ds === today
              const dayEvs = events.filter(e => e.date === ds)
              return (
                <div key={di} onClick={() => onAddEvent(ds)} style={{ flex: 1, borderLeft: di > 0 ? '1px solid var(--border)' : 'none', padding: '5px 4px 3px', cursor: 'pointer', transition: 'background 0.12s', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', fontFamily: 'var(--font-body)', fontSize: 'var(--fs-xs)', fontWeight: isToday ? 700 : 400, color: isToday ? '#fff' : isThisMonth ? 'var(--text)' : 'var(--text-dim)', background: isToday ? 'var(--accent)' : 'transparent' }}>{d.getDate()}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, overflow: 'hidden' }}>
                    {dayEvs.slice(0, 3).map(ev => {
                      const cat = getCat(ev.categoryId)
                      return (
                        <div key={ev.id} onClick={e => { e.stopPropagation(); onEditEvent(ev) }}
                          style={{ background: cat.bg, borderLeft: `2px solid ${cat.color}`, borderRadius: '0 3px 3px 0', padding: '1px 4px', overflow: 'hidden' }}>
                          <span style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-2xs)', color: cat.color, fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', display: 'block' }}>{ev.title}</span>
                        </div>
                      )
                    })}
                    {dayEvs.length > 3 && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', paddingLeft: 4 }}>+{dayEvs.length - 3}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Calendar: List View ──────────────────────────────────────────────────────

function ListView({ events, settings, onEditEvent }: { events: CalendarEvent[]; settings: Settings; onEditEvent: (e: CalendarEvent) => void }) {
  const today = todayStr()
  const sorted = [...events].filter(e => e.date >= today).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
  const groups = new Map<string, CalendarEvent[]>()
  for (const ev of sorted) { if (!groups.has(ev.date)) groups.set(ev.date, []); groups.get(ev.date)!.push(ev) }

  function fmtGroupDate(ds: string) {
    const d = new Date(ds + 'T00:00:00')
    const diff = Math.round((d.getTime() - new Date(today + 'T00:00:00').getTime()) / 86400000)
    if (diff === 0) return '今日'
    if (diff === 1) return '明日'
    return `${d.getMonth() + 1}月${d.getDate()}日（${DAYS_JP[d.getDay()]}）`
  }

  if (groups.size === 0) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, padding: 32 }}>
      <div style={{ fontSize: 40 }}>📭</div>
      <div style={{ fontFamily: 'var(--font-body)', color: 'var(--text-dim)', fontSize: 'var(--fs-md)' }}>今後の予定はありません</div>
    </div>
  )

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
        {Array.from(groups.entries()).map(([ds, evs]) => (
          <div key={ds}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-md)', color: ds === today ? 'var(--accent)' : 'var(--text)' }}>{fmtGroupDate(ds)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)' }}>{evs.length}件</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {evs.map(ev => {
                const cat = getCat(ev.categoryId)
                return (
                  <div key={ev.id} onClick={() => onEditEvent(ev)}
                    style={{ display: 'flex', gap: 14, alignItems: 'flex-start', background: 'var(--surface-raised)', border: '1px solid var(--border)', borderLeft: `3px solid ${cat.color}`, borderRadius: '0 12px 12px 0', padding: '12px 16px', cursor: 'pointer', transition: 'all 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-hover)'; e.currentTarget.style.transform = 'translateX(4px)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-raised)'; e.currentTarget.style.transform = 'none' }}
                  >
                    <div style={{ width: 68, flexShrink: 0 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text)', fontWeight: 500 }}>{fmtTime(ev.startTime, settings.timeFormat)}</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', marginTop: 1 }}>{fmtTime(ev.endTime, settings.timeFormat)}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 'var(--fs-base)', color: 'var(--text)', marginBottom: ev.description ? 3 : 0 }}>{ev.title}</div>
                      {ev.description && <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{ev.description}</div>}
                    </div>
                    {ev.priority && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: priorityColor(ev.priority), border: `1px solid ${priorityColor(ev.priority)}55`, borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>
                        {ev.priority.toUpperCase()}
                      </span>
                    )}
                    <CategoryBadge cat={cat} small />
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Calendar Screen ──────────────────────────────────────────────────────────

function CalendarScreen({ events, settings, selectedDate, onSelectDate, onAddEvent, onEditEvent }: {
  events: CalendarEvent[]; settings: Settings; selectedDate: string
  onSelectDate: (d: string) => void; onAddEvent: (d?: string) => void; onEditEvent: (e: CalendarEvent) => void
}) {
  const [view, setView] = useState<ViewMode>(settings.defaultView)
  const [anchor, setAnchor] = useState(new Date())
  const isMobile = useIsMobile()
  const year = anchor.getFullYear(), month = anchor.getMonth()

  function navigate(dir: -1 | 1) {
    const d = new Date(anchor)
    if (view === 'week') d.setDate(d.getDate() + dir * 7)
    else if (view === 'month') d.setMonth(d.getMonth() + dir)
    else d.setDate(d.getDate() + dir * 14)
    setAnchor(d)
  }

  function headerLabel() {
    if (view === 'week') {
      const days = getWeekDates(anchor, settings.startMonday)
      const s = days[0], e = days[6]
      return s.getMonth() === e.getMonth() ? `${year}年 ${MONTHS_JP[month]}` : `${s.getMonth() + 1}月 – ${e.getMonth() + 1}月`
    }
    return `${year}年 ${MONTHS_JP[month]}`
  }

  const navButtons = (
    <div style={{ display: 'flex', gap: 2 }}>
      {([-1, 1] as const).map(dir => (
        <button key={dir} onClick={() => navigate(dir)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px 8px', borderRadius: 7, fontSize: 'var(--fs-base)' }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.background = 'var(--surface-hover)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}
        >{dir === -1 ? '←' : '→'}</button>
      ))}
    </div>
  )
  const todayButton = (
    <button onClick={() => setAnchor(new Date())} style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '0.08em', padding: '5px 10px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' }}>TODAY</button>
  )
  const viewSwitch = <SegControl value={view} onChange={setView} small options={[{ value: 'week', label: '週' }, { value: 'month', label: '月' }, { value: 'list', label: 'リスト' }]} />
  const addButton = <button onClick={() => onAddEvent()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '7px 14px', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 'var(--fs-xs)', cursor: 'pointer', whiteSpace: 'nowrap' }}>+ 追加</button>

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {navButtons}
            <span style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-sm)', color: 'var(--text)', flex: 1 }}>{view !== 'list' ? headerLabel() : '今後の予定'}</span>
            {todayButton}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1 }}>{viewSwitch}</div>
            {addButton}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
          {navButtons}
          <span style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-md)', color: 'var(--text)', flex: 1 }}>{view !== 'list' ? headerLabel() : '今後の予定'}</span>
          {todayButton}
          {viewSwitch}
          {addButton}
        </div>
      )}

      {/* View */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {view === 'week' && <WeekView anchor={anchor} events={events} settings={settings} selectedDate={selectedDate} onSelectDate={onSelectDate} onAddEvent={d => onAddEvent(d)} onEditEvent={onEditEvent} />}
        {view === 'month' && <MonthView year={year} month={month} events={events} settings={settings} onAddEvent={d => onAddEvent(d)} onEditEvent={onEditEvent} />}
        {view === 'list' && <ListView events={events} settings={settings} onEditEvent={onEditEvent} />}
      </div>
    </div>
  )
}

// ─── AI Summary Screen ────────────────────────────────────────────────────────

const AI_DAILY_MSGS = [
  '今日の予定を解析中……',
  'あなたの体力を計算中……',
  '明日の地獄を予測中……',
  'Geminiに説教されています……',
  '査定完了！',
]

function AISummaryScreen({ user, events, settings }: { user: User; events: CalendarEvent[]; settings: Settings }) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'result' | 'error'>('idle')
  const [msgIdx, setMsgIdx] = useState(0)
  const [result, setResult] = useState<AIDailyResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [history, setHistory] = useState<{ date: string; title: string; reason: string }[]>([])
  const today = todayStr()
  const load = getTodayLoad(user.id, events, today, user.capacityMinutes)
  const todayEvs = events.filter(e => e.date === today)
  const completedEvs = todayEvs.filter(e => e.completed)

  useEffect(() => { summaryService.getHistory(user.id).then(setHistory) }, [user.id])

  async function handleSummary() {
    setPhase('loading'); setMsgIdx(0)
    const id = setInterval(() => setMsgIdx(i => Math.min(i + 1, AI_DAILY_MSGS.length - 1)), 550)
    // /api/daily-summary/generate に渡すタスク一覧はここで組み立てる。
    // 予定(planned)は今日の全予定、実績(actual)は「完了」チェックが入っている
    // ものだけを対象にする（＝予定を入れただけでは称号の対象にならない）。
    const allTasks = todayEvs.map(ev => ({
      title: ev.title,
      category: getCat(ev.categoryId).label,
      plannedMinutes: Math.round((parseTime(ev.endTime) - parseTime(ev.startTime)) * 60),
      actualMinutes: ev.actualMinutes ?? Math.round((parseTime(ev.endTime) - parseTime(ev.startTime)) * 60),
      completed: !!ev.completed,
    }))
    try {
      const r = await aiService.getDailyFeedback(user.id, today, allTasks, user.capacityMinutes, settings.aiSpice)
      clearInterval(id)
      setResult(r); setPhase('result')
      summaryService.getHistory(user.id).then(setHistory)
    } catch (e) {
      clearInterval(id)
      // 503(APIキー未設定) / 502(Gemini呼び出し失敗・JSON崩れ) / ネットワークエラー、
      // いずれも「生成できませんでした」という正直な失敗として見せる
      // （偽の成功で誤魔化さない、という今回の方針）。
      const msg = e instanceof ApiError && e.status === 503
        ? '現在AI総括機能は利用できません（管理者にお問い合わせください）。'
        : '総括を生成できませんでした。しばらくしてからもう一度お試しください。'
      setErrorMsg(msg)
      setPhase('error')
    }
  }

  const overloadColor = (pct: number) => pct >= 80 ? '#ef4444' : pct >= 60 ? '#f97316' : pct >= 30 ? '#eab308' : '#22c55e'

  if (phase === 'error') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 40 }}>⚠️</div>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-md)', color: 'var(--text)', maxWidth: 320, lineHeight: 1.6 }}>{errorMsg}</div>
      <Btn label="もう一度試す" onClick={() => setPhase('idle')} variant="secondary" />
    </div>
  )

  if (phase === 'loading') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28, padding: 32 }}>
      <div style={{ width: 64, height: 64, borderRadius: '50%', border: '3px solid var(--border-mid)', borderTopColor: 'var(--ai)', animation: 'spin 1s linear infinite' }} />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ai)', letterSpacing: '0.1em', marginBottom: 10 }}>AI ANALYZING</div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-lg)', color: 'var(--text)', animation: 'pulse 1.2s ease infinite' }}>
          {AI_DAILY_MSGS[msgIdx]}
        </div>
      </div>
    </div>
  )

  if (phase === 'result' && result) return (
    <div style={{ overflowY: 'auto', padding: '24px 16px 32px', maxWidth: 560, margin: '0 auto', width: '100%' }}>
      <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ai)', letterSpacing: '0.1em', marginBottom: 6 }}>TODAY'S 称号</div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--fs-xl)', color: 'var(--text)', fontWeight: 300, lineHeight: 1.3 }}>「{result.title}」</h2>
        </div>

        {/* Overload meter */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em' }}>今日の負荷率</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: overloadColor(result.overloadPct), fontWeight: 500 }}>{result.overloadPct}%</span>
          </div>
          <div style={{ height: 8, background: 'var(--border-mid)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(result.overloadPct, 100)}%`, background: overloadColor(result.overloadPct), borderRadius: 4, transition: 'width 1.2s ease', boxShadow: `0 0 8px ${overloadColor(result.overloadPct)}66` }} />
          </div>
        </div>

        {/* AI reason */}
        <div className="card ai-glow" style={{ borderColor: 'var(--ai-mid)', background: 'var(--ai-dim)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--ai)', letterSpacing: '0.1em', marginBottom: 10 }}>AI からの一言</div>
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-md)', color: 'var(--text)', lineHeight: 1.7 }}>{result.reason}</p>
        </div>

        {/* Next action */}
        <div className="card" style={{ borderColor: 'var(--accent-mid)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--accent)', letterSpacing: '0.1em', marginBottom: 10 }}>NEXT ACTION</div>
          <p style={{ fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 'var(--fs-md)', color: 'var(--text)', lineHeight: 1.5 }}>「{result.nextAction}」</p>
        </div>

        <Btn label="もう一度査定する" onClick={() => setPhase('idle')} variant="secondary" full />
      </div>
    </div>
  )

  return (
    <div style={{ overflowY: 'auto', padding: '32px 16px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
      <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ai)', letterSpacing: '0.1em', marginBottom: 8 }}>AI DAILY FEEDBACK</div>
          <h2 style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-xl)', color: 'var(--text)' }}>今日の総括</h2>
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.6 }}>完了にチェックした予定をもとに、AIが今日の称号を生成します。</p>
        </div>

        {/* Today summary */}
        <div className="card">
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 12 }}>今日のステータス</div>
          <div style={{ display: 'flex', gap: 20 }}>
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xl)', fontWeight: 500, color: workloadLevelColor(load.workload.workloadLevel), lineHeight: 1 }}>{load.workload.workloadLevel}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>{Math.round(load.hours * 10) / 10}h稼働 / 完了{completedEvs.length}件</div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {todayEvs.slice(0, 4).map(ev => {
                const cat = getCat(ev.categoryId)
                return <div key={ev.id} style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-xs)', color: ev.completed ? 'var(--text-muted)' : 'var(--text-dim)', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: cat.color, flexShrink: 0 }} />
                  {ev.startTime} {ev.title}{ev.completed ? ' ✓' : ''}
                </div>
              })}
            </div>
          </div>
        </div>

        {!settings.aiEnabled ? (
          <div className="card" style={{ textAlign: 'center', padding: '24px' }}>
            <div style={{ fontFamily: 'var(--font-body)', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>AIフィードバックが無効です</div>
            <div style={{ fontFamily: 'var(--font-body)', color: 'var(--text-dim)', fontSize: 'var(--fs-xs)', marginTop: 4 }}>設定から有効にしてください</div>
          </div>
        ) : (
          <button onClick={handleSummary} style={{
            width: '100%', padding: '18px', borderRadius: 14,
            background: 'var(--ai)', border: 'none', color: '#000',
            fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-md)', cursor: 'pointer',
            boxShadow: '0 0 24px var(--ai-mid)', transition: 'opacity 0.15s',
          }}
            onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
            onMouseLeave={e => e.currentTarget.style.opacity = '1'}
          >⚡ 今日の総括を生成する</button>
        )}

        {/* 称号履歴（GET /api/daily-summary/history 相当） */}
        {history.length > 0 && (
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: 10 }}>過去の称号</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {history.slice(0, 5).map(h => (
                <div key={h.date} className="card" style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>「{h.title}」</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)' }}>{h.date}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Settings Screen ──────────────────────────────────────────────────────────

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '0.12em', color: 'var(--text-dim)', marginBottom: 12, textTransform: 'uppercase' }}>{title}</div>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: 0, overflow: 'hidden' }}>{children}</div>
    </div>
  )
}

function SettingsRow({ label, sub, right }: { label: string; sub?: string; right: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
      <div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-base)', color: 'var(--text)' }}>{label}</div>
        {sub && <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ flexShrink: 0, marginLeft: 12 }}>{right}</div>
    </div>
  )
}

function SettingsScreen({ settings, update, user, onLogout, onProfile }: {
  settings: Settings; update: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  user: User; onLogout: () => void; onProfile: () => void
}) {
  return (
    <div style={{ overflowY: 'auto', padding: '24px 16px 32px', maxWidth: 560, margin: '0 auto', width: '100%' }}>
      <h2 style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-xl)', color: 'var(--text)', marginBottom: 28 }}>設定</h2>

      <SettingsSection title="表示">
        <SettingsRow label="テーマ" right={
          <SegControl small value={settings.theme} onChange={v => update('theme', v)} options={[{ value: 'light' as Theme, label: '☀ ライト' }, { value: 'dark' as Theme, label: '🌙 ダーク' }, { value: 'system' as Theme, label: '自動' }]} />
        } />
        <SettingsRow label="文字サイズ" right={
          <SegControl small value={settings.fontSize} onChange={v => update('fontSize', v)} options={[{ value: 'sm' as FontSize, label: '小' }, { value: 'md' as FontSize, label: '中' }, { value: 'lg' as FontSize, label: '大' }]} />
        } />
      </SettingsSection>

      <SettingsSection title="カレンダー">
        <SettingsRow label="週の開始を月曜日にする" right={<Toggle checked={settings.startMonday} onChange={v => update('startMonday', v)} />} />
        <SettingsRow label="週末を表示する" right={<Toggle checked={settings.showWeekends} onChange={v => update('showWeekends', v)} />} />
        <SettingsRow label="週番号を表示する" right={<Toggle checked={settings.showWeekNumbers} onChange={v => update('showWeekNumbers', v)} />} />
        <SettingsRow label="時刻の表示形式" right={<SegControl small value={settings.timeFormat} onChange={v => update('timeFormat', v)} options={[{ value: '24h' as const, label: '24時間' }, { value: '12h' as const, label: '12時間' }]} />} />
        <div style={{ padding: '14px 16px' }}>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-base)', color: 'var(--text)', marginBottom: 8 }}>起動時のビュー</div>
          <SegControl small value={settings.defaultView} onChange={v => update('defaultView', v)} options={[{ value: 'week' as ViewMode, label: '週' }, { value: 'month' as ViewMode, label: '月' }, { value: 'list' as ViewMode, label: 'リスト' }]} />
        </div>
      </SettingsSection>

      <SettingsSection title="AI設定">
        <SettingsRow label="AIフィードバックを有効にする" sub="ダッシュボードとAI総括機能" right={<Toggle checked={settings.aiEnabled} onChange={v => update('aiEnabled', v)} />} />
        <SettingsRow label="AIの辛口度" sub="鬼にすると容赦なくなります" right={
          <SegControl small value={settings.aiSpice} onChange={v => update('aiSpice', v)} options={[{ value: 'mild' as AiSpice, label: 'マイルド' }, { value: 'normal' as AiSpice, label: '普通' }, { value: 'spicy' as AiSpice, label: '🔥 鬼' }]} />
        } />
      </SettingsSection>

      <SettingsSection title="アカウント">
        <SettingsRow label="メールアドレス" sub={user.email} right={<></>} />
        <SettingsRow label="プロフィール" right={<button onClick={onProfile} style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-muted)', fontFamily: 'var(--font-body)', fontSize: 'var(--fs-xs)', padding: '5px 12px', borderRadius: 8, cursor: 'pointer' }}>表示 →</button>} />
        <div style={{ padding: '14px 16px' }}>
          <Btn label="ログアウト" onClick={onLogout} variant="danger" full />
        </div>
      </SettingsSection>
    </div>
  )
}

// ─── Profile Screen ───────────────────────────────────────────────────────────

function ProfileScreen({ user, onBack }: { user: User; onBack: () => void }) {
  const color = limitColor(user.limitScore)
  return (
    <div style={{ overflowY: 'auto', padding: '24px 16px 32px', maxWidth: 480, margin: '0 auto', width: '100%' }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-sm)', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 6 }}>← 設定に戻る</button>

      <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Avatar + name */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingBottom: 24, borderBottom: '1px solid var(--border)' }}>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'var(--accent-mid)', border: `2px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
            {user.name[0]}
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--fs-xl)', color: 'var(--text)' }}>{user.name}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>{user.email}</div>
          </div>
        </div>

        {/* Limit score */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '28px 20px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', letterSpacing: '0.1em' }}>LIMIT SCORE</div>
          <LimitMeter score={user.limitScore} size={160} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', marginBottom: 6 }}>二つ名</div>
            <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--fs-xl)', color, fontWeight: 500 }}>「{user.nickname}」</div>
          </div>
        </div>

        {/* AI message */}
        <div className="card" style={{ borderColor: 'var(--ai-mid)', background: 'var(--ai-dim)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--ai)', letterSpacing: '0.08em', marginBottom: 8 }}>AI プロフィール診断</div>
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--fs-sm)', color: 'var(--text)', lineHeight: 1.7 }}>「{user.message}」</p>
        </div>
      </div>
    </div>
  )
}

// ─── Navigation ───────────────────────────────────────────────────────────────

type NavItem = { id: Screen; label: string; icon: string }
const NAV_ITEMS: NavItem[] = [
  { id: 'home',        label: 'ホーム',     icon: '⌂' },
  { id: 'calendar',   label: 'カレンダー', icon: '▦' },
  { id: 'ai-summary', label: 'AI総括',     icon: '⚡' },
  { id: 'settings',   label: '設定',       icon: '⚙' },
]

function BottomNav({ screen, onNav }: { screen: Screen; onNav: (s: Screen) => void }) {
  return (
    <nav className="bottom-nav">
      {NAV_ITEMS.map(item => {
        const active = screen === item.id
        return (
          <button key={item.id} onClick={() => onNav(item.id)} style={{
            flex: 1, border: 'none', background: 'none', cursor: 'pointer', padding: '8px 4px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            color: active ? 'var(--accent)' : 'var(--text-dim)',
          }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>{item.icon}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '0.05em' }}>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

function Sidebar({ screen, onNav, user }: { screen: Screen; onNav: (s: Screen) => void; user: User }) {
  return (
    <nav className="sidebar">
      <div style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 13, color: 'var(--accent)', marginBottom: 20, letterSpacing: '-0.01em', textAlign: 'center', lineHeight: 1 }}>P</div>
      {NAV_ITEMS.map(item => {
        const active = screen === item.id
        return (
          <button key={item.id} onClick={() => onNav(item.id)}
            title={item.label}
            style={{
              width: 44, height: 44, borderRadius: 12, border: 'none', cursor: 'pointer', marginBottom: 4,
              background: active ? 'var(--accent-dim)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text-dim)',
              fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'var(--surface-raised)'; e.currentTarget.style.color = 'var(--text)' } }}
            onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-dim)' } }}
          >
            {item.icon}
          </button>
        )
      })}
      <div style={{ flex: 1 }} />
      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent-mid)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-body)', fontWeight: 700, color: 'var(--accent)', fontSize: 'var(--fs-sm)', cursor: 'pointer' }}
        onClick={() => onNav('profile' as Screen)} title={user.name}>
        {user.name[0]}
      </div>
    </nav>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const { settings, update } = useSettings()
  const [screen, setScreen] = useState<Screen>('login')
  const [user, setUser] = useState<User | null>(null)
  const [sessionChecked, setSessionChecked] = useState(false)
  const [loginNotice, setLoginNotice] = useState<string | null>(null)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [onboardingAnswers, setOnboardingAnswers] = useState<OnboardingAnswers | null>(null)
  const [aiResult, setAiResult] = useState<AIResult | null>(null)
  const [selectedDate, setSelectedDate] = useState(todayStr())

  // Modal
  const [modalMode, setModalMode] = useState<'closed' | 'create' | 'edit'>('closed')
  const [modalDate, setModalDate] = useState<string | undefined>()
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | undefined>()

  // ユーザーが決まったら tasks テーブル（ゲストはローカル）から予定を読み込む。
  useEffect(() => {
    if (!user) { setEvents([]); return }
    let active = true
    scheduleService.list(user.id).then(evs => { if (active) setEvents(evs) })
    return () => { active = false }
  }, [user?.id])

  // アプリ起動時：ゲストモードのローカル退避 → Supabaseの実セッションの順に確認
  // し、あれば GET /api/auth/me 相当でログイン状態を復元する
  // （1人目の「アプリを開き直してもログイン状態が続く」に対応）。
  // ログアウト等でセッションが切れた場合は onAuthStateChange 経由で検知する。
  useEffect(() => {
    let active = true
    async function restore() {
      const guest = authService.getGuestSession()
      if (guest) { if (active) { setUser(guest); setScreen('home') } ; if (active) setSessionChecked(true); return }
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { if (active) setSessionChecked(true); return }
      try {
        const u = await authService.me()
        if (!active) return
        if (u) { setUser(u); setScreen('home') }
      } catch (e) {
        // プロフィール取得に失敗（Renderのコールドスタート等）。セッション自体は
        // Supabase側にまだ残っているので、ここではログイン画面に戻すだけにして
        // 強制ログアウトはしない（次回のログイン操作時にまた取得を試みる）。
        console.error('[session] プロフィール復元に失敗:', e)
      }
      if (active) setSessionChecked(true)
    }
    restore()
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { setUser(null); setScreen('login') }
    })
    return () => { active = false; sub.subscription.unsubscribe() }
  }, [])

  function handleLogin(u: User) {
    setLoginNotice(null)
    setUser(u); setScreen('home')
  }

  async function handleLogout() {
    await authService.logout()
    setUser(null); setScreen('login')
  }

  async function handleRegister(name: string, email: string, password: string): Promise<string | null> {
    const { error } = await authService.register(name, email, password)
    if (error) return error
    // メール確認が有効なプロジェクトだと、登録直後はまだセッションが無い。
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      setLoginNotice('確認メールを送信しました。メール内のリンクを開いてからログインしてください。')
      setScreen('login')
      return null
    }
    try {
      // profiles行はDBトリガーで即時作成されるはずだが、Renderの無料枠が
      // スリープから復帰中だと最初の問い合わせが失敗しうるため数回リトライする。
      const u = await authService.meWithRetry()
      if (!u) {
        // 3回試しても404 = トリガー自体が動いていない可能性が高い
        return 'アカウントは作成されましたが、プロフィールの初期化に失敗しました。運営にお問い合わせください。'
      }
      setUser(u)
      setScreen('onboarding')
      return null
    } catch {
      // ここに来るのは「サーバーに繋がらない」系の失敗（Renderのコールドスタート等）。
      // アカウント自体は作成済みなので、登録失敗として扱わずログインへ誘導する。
      setLoginNotice('アカウントは作成されました。サーバーが起動中の可能性があるため、少し待ってからログインしてください。')
      setScreen('login')
      return null
    }
  }

  async function handleOnboardingComplete(answers: OnboardingAnswers) {
    setOnboardingAnswers(answers); setScreen('assessing')
    const result = await aiService.assessLimit(answers)
    setAiResult(result)
    if (user) {
      const updatedUser: User = {
        ...user,
        limitScore: result.score, nickname: result.nickname, message: result.message,
        capacityMinutes: result.capacityMinutes,
      }
      // ゲストは実際の auth.users / profiles 行を持たないのでDB書き込みは行わない。
      // USE_BACKEND=true のときは、直前の aiService.assessLimit() 内で
      // POST /api/onboarding/calculate-capacity が既にDB保存まで済ませているので、
      // ここで重ねて書き込まない（二重書き込み防止）。
      if (!user.id.startsWith('guest_') && !USE_BACKEND) {
        await authService.updateProfile({
          max_workload_minutes: result.capacityMinutes,
          onboarding_completed: true,
        })
      }
      setUser(updatedUser)
    }
    setScreen('ai-result')
  }

  async function handleSaveEvent(ev: CalendarEvent) {
    if (!user) return
    if (modalMode === 'edit') {
      const updated = await scheduleService.update(user.id, ev)
      setEvents(p => p.map(e => e.id === updated.id ? updated : e))
    } else {
      const created = await scheduleService.create(user.id, ev)
      setEvents(p => [...p, created])
    }
  }

  async function handleDeleteEvent(id: string) {
    if (!user) return
    setEvents(p => p.filter(e => e.id !== id))
    await scheduleService.remove(user.id, id)
  }

  async function handleToggleComplete(id: string) {
    if (!user) return
    const target = events.find(e => e.id === id)
    if (!target) return
    const optimistic = { ...target, completed: !target.completed }
    setEvents(p => p.map(e => e.id === id ? optimistic : e))
    const saved = await scheduleService.update(user.id, optimistic)
    setEvents(p => p.map(e => e.id === id ? saved : e))
  }

  function openCreate(date?: string) { setModalDate(date); setEditingEvent(undefined); setModalMode('create') }
  function openEdit(ev: CalendarEvent) { setEditingEvent(ev); setModalDate(undefined); setModalMode('edit') }

  // セッション復元が終わるまでは何も出さない（ちらつき防止）。
  if (!sessionChecked) return null

  // Auth-only screens
  if (screen === 'login') return <LoginScreen onLogin={handleLogin} onRegister={() => setScreen('register')} notice={loginNotice} />
  if (screen === 'register') return <RegisterScreen onRegister={handleRegister} onBack={() => setScreen('login')} />
  if (screen === 'onboarding') return <OnboardingScreen onComplete={handleOnboardingComplete} onSkip={() => {
    // スキップはお試し表示のみ。実アカウントの行(profiles)は書き換えない。
    setUser(prev => prev ? { ...prev, limitScore: DEMO_USER.limitScore, nickname: DEMO_USER.nickname, message: DEMO_USER.message, capacityMinutes: DEMO_USER.capacityMinutes } : DEMO_USER)
    setScreen('home')
  }} />
  if (screen === 'assessing') return <AssessingScreen />
  if (screen === 'ai-result' && aiResult) return <AIResultScreen result={aiResult} onStart={() => setScreen('home')} />

  if (!user) return <LoginScreen onLogin={handleLogin} onRegister={() => setScreen('register')} notice={loginNotice} />

  const mainContent = () => {
    if (screen === 'profile') return <ProfileScreen user={user} onBack={() => setScreen('settings')} />
    if (screen === 'settings') return <SettingsScreen settings={settings} update={update} user={user} onLogout={handleLogout} onProfile={() => setScreen('profile')} />
    if (screen === 'ai-summary') return <AISummaryScreen user={user} events={events} settings={settings} />
    if (screen === 'calendar') return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <CalendarScreen events={events} settings={settings} selectedDate={selectedDate} onSelectDate={setSelectedDate} onAddEvent={openCreate} onEditEvent={openEdit} />
      </div>
    )
    return <DashboardScreen user={user} events={events} settings={settings} onAddEvent={openCreate} onEditEvent={openEdit} onToggleComplete={handleToggleComplete} onAISummary={() => setScreen('ai-summary')} />
  }

  return (
    <div className="app-shell">
      <Sidebar screen={screen} onNav={setScreen} user={user} />
      <main className="main-content">{mainContent()}</main>
      <BottomNav screen={screen} onNav={setScreen} />
      {modalMode !== 'closed' && (
        <EventModal event={modalMode === 'edit' ? editingEvent : undefined} defaultDate={modalDate} timeFormat={settings.timeFormat} onClose={() => setModalMode('closed')} onSave={handleSaveEvent} onDelete={modalMode === 'edit' ? handleDeleteEvent : undefined} />
      )}
    </div>
  )
}
