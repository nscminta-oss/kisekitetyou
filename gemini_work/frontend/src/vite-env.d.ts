/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  /** FastAPI バックエンドのベース URL（例: https://xxx.onrender.com） */
  readonly VITE_API_BASE?: string
  /** 'true' のときタスク/プロフィールをバックエンド経由にする */
  readonly VITE_USE_BACKEND?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
