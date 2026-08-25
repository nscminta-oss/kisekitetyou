import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

// .env（.env.example を参照）に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を
// 設定してください。Supabaseダッシュボードの Project Settings → API から
// コピーできます（anon/public キーのみ。service_role キーは絶対にフロントに
// 置かないこと）。
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.error(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が設定されていません。' +
    'プロジェクトルートに .env を作成し、.env.example を参考に値を入れてください。'
  )
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey)
