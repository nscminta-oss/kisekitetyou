"""
学生向けAIスケジューラー — 負荷計算バックエンド

担当：小河
Supabase project: student-ai-scheduler-hackathon (qlwtxjzrtcpjyajonnnk)

設計メモ:
- フロント(React)が Supabase Auth でログインし、アクセストークンを
  Authorization: Bearer <token> で送ってくる。
- バックエンドはトークンから user_id を取り出し、さらに「そのトークンを
  そのまま Supabase に渡して」DB アクセスする。こうすることで RLS が
  効いたまま本人のデータだけを触れる。
- リクエストボディの userId は本人確認に使わない（DB契約書の方針）。
- DB は snake_case、API JSON は camelCase。境界で変換する。

Gemini連携（今井さん担当パート）:
- POST /api/daily-summary/generate … 今日完了したタスクをGeminiに渡し、
  「称号」と「理由」をJSON形式で生成して daily_summaries に保存する。
- GET  /api/daily-summary/history  … 保存済みの称号履歴を返す。
- GEMINI_API_KEY が未設定、またはGemini呼び出しが失敗した場合は
  デフォルトの称号にフォールバックする（3人目の要件どおり）。
"""

import json
import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import pytz
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google import genai
from google.genai import types as genai_types
from pydantic import BaseModel, Field
from supabase import Client, create_client

# .env は「このファイルと同じ階層」から読む。
# load_dotenv() をそのまま呼ぶとカレントディレクトリ基準になるため、
# リポジトリ直下から `uvicorn backend.main:app` のように起動すると
# backend/.env が見つからず起動に失敗する。
load_dotenv(Path(__file__).with_name(".env"))

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    missing = [
        name
        for name, value in (("SUPABASE_URL", SUPABASE_URL), ("SUPABASE_ANON_KEY", SUPABASE_ANON_KEY))
        if not value
    ]
    raise RuntimeError(
        "環境変数が設定されていません: " + ", ".join(missing) + "\n"
        f"  探した .env: {Path(__file__).with_name('.env')}\n"
        "  ローカル : backend/.env を作成してください（backend/.env.example をコピー）\n"
        "  Render   : ダッシュボードの Environment に登録してください"
    )

# GEMINI_API_KEY は必須にしない（未設定でも起動はでき、称号生成だけ
# デフォルト文言にフォールバックする）。キーを忘れて起動不能になる事故を防ぐため。
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

app = FastAPI(
    title="Workload Scheduler API",
    version="1.1.0",
    description="タスクの合計時間とユーザーの限界時間から「キツさ(%)」を返す",
)

# CORS 許可オリジン
#
# 環境変数 ALLOWED_ORIGINS にカンマ区切りで指定する。
#   例: ALLOWED_ORIGINS=https://student-scheduler-ten.vercel.app,http://localhost:5173
#
# 未設定の場合はローカル開発用のオリジンだけを許可する。
# Render 側で環境変数を書き換えれば、コードを触らずに本番ドメインを追加できる。
DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000"

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    # Vercel のプレビューデプロイ（*-xxxx.vercel.app）は URL が毎回変わるため
    # 正規表現でまとめて許可する。本番だけに絞りたい場合はこの行を削除する。
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 422 バリデーションエラーを文字列で統一（FastAPI 標準は配列になることがある）
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc: RequestValidationError):
    """入力バリデーション失敗を統一した形式で返す"""
    errors = []
    for e in exc.errors():
        field = ".".join(str(x) for x in e["loc"][1:])  # "body.x" 形式を "x" に
        errors.append(f"{field}: {e['msg']}")
    
    return JSONResponse(
        status_code=422,
        content={"detail": " / ".join(errors)},  # ← 配列ではなく文字列
    )


# ============================================================
# 認証
# ============================================================

class AuthContext:
    """認証済みユーザーの user_id と、そのユーザー権限で動く Supabase クライアント"""

    def __init__(self, user_id: str, client: Client):
        self.user_id = user_id
        self.db = client


async def auth(authorization: Optional[str] = Header(None)) -> AuthContext:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing authorization header")

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization must be 'Bearer <token>'")

    token = parts[1].strip()

    # 【調査で見つかった重大バグ】以前はここで jwt.decode(..., verify_signature=False)
    # を使っており、署名を一切検証していなかった（"署名検証はPostgREST側がやる"という
    # コメントがあったが、PostgRESTは行レベルのRLS認可をするだけで、そもそも
    # このAPIサーバー自身がuser_idを信頼して良いかどうかの検証にはならない）。
    # sub クレームさえ含んでいれば誰でも偽造トークンで他人になりすませる状態だった。
    # → Supabase自身に問い合わせて検証する方式に変更（JWT_SECRETの管理も不要になる）。
    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    try:
        user_res = client.auth.get_user(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    if not user_res or not user_res.user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # 検証済みトークンをクライアントに載せる → 以降のDBアクセスはRLSが効く
    client.postgrest.auth(token)

    return AuthContext(user_res.user.id, client)


# ============================================================
# モデル（API 側は camelCase）
# ============================================================

class CreateTaskRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    plannedMinutes: int = Field(gt=0)
    category: Optional[str] = None
    date: Optional[str] = None       # YYYY-MM-DD、省略時は今日
    startTime: Optional[str] = None  # HH:MM


class UpdateTaskRequest(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    plannedMinutes: Optional[int] = Field(None, gt=0)
    actualMinutes: Optional[int] = Field(None, ge=0)
    isCompleted: Optional[bool] = None
    category: Optional[str] = None
    date: Optional[str] = None
    startTime: Optional[str] = None


class UpdateProfileRequest(BaseModel):
    name: Optional[str] = None
    maxWorkloadMinutes: Optional[int] = Field(None, gt=0)
    onboardingCompleted: Optional[bool] = None


class WorkloadResponse(BaseModel):
    date: str
    totalMinutes: int
    capacityMinutes: int
    workloadPercentage: int
    workloadLevel: str
    comment: str
    remainingMinutes: int
    taskCount: int
    completedCount: int


class CompletedTaskInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    category: Optional[str] = None
    plannedMinutes: int = Field(ge=0)
    actualMinutes: int = Field(ge=0)


class DailySummaryRequest(BaseModel):
    date: Optional[str] = None  # YYYY-MM-DD、省略時は今日
    capacityMinutes: int = Field(gt=0)         # ユーザーの限界時間
    plannedMinutes: int = Field(ge=0)          # 今日の予定時間の合計
    actualMinutes: int = Field(ge=0)           # 今日の実績時間の合計
    completedTasks: list[CompletedTaskInput] = Field(default_factory=list)


class DailySummaryResponse(BaseModel):
    date: str
    title: str
    reason: str
    nextAction: str
    plannedPercentage: int
    actualPercentage: int
    totalFocusTimeMinutes: int


class DailySummaryHistoryItem(BaseModel):
    date: str
    title: str
    reason: str
    nextAction: Optional[str] = None


class OnboardingAnswers(BaseModel):
    """5問の回答（すべて分単位）。オンボーディング画面の質問と1対1対応。"""
    freeTimeMinutes: int = Field(ge=0, le=1440, description="固定予定を除いて1日に自由に使える時間")
    sleepMinimumMinutes: int = Field(ge=0, le=1440, description="最低限確保したい睡眠時間")
    fixedCommitmentMinutes: int = Field(ge=0, le=1440, description="授業・バイト・通学など固定予定に使う時間")
    sustainableWorkMinutes: int = Field(ge=0, le=1440, description="普段無理なく続けられる勉強・作業時間")
    maxEffortMinutes: int = Field(ge=0, le=1440, description="かなり頑張った日の「これ以上は厳しい」作業時間")


class OnboardingResult(BaseModel):
    capacityMinutes: int
    onboardingCompleted: bool


# ============================================================
# 変換・ロジック
# ============================================================

def task_to_api(row: dict) -> dict:
    """tasks の行を API 用 camelCase に変換"""
    return {
        "id": row.get("id"),
        "userId": row.get("user_id"),
        "title": row.get("title"),
        "category": row.get("category"),
        "date": row.get("scheduled_date"),
        "startTime": row.get("start_time"),
        "plannedMinutes": row.get("planned_minutes"),
        "actualMinutes": row.get("actual_minutes"),
        "isCompleted": row.get("is_completed"),
        "completedAt": row.get("completed_at"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def profile_to_api(row: dict) -> dict:
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "maxWorkloadMinutes": row.get("max_workload_minutes"),
        "onboardingCompleted": row.get("onboarding_completed"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def judge_level(percentage: int) -> tuple[str, str]:
    """キツさ(%) → レベルとひとこと"""
    if percentage > 100:
        return "キャパオーバー", "予定を詰め込みすぎ。今日じゃなくていいものは明日に回そう"
    if percentage > 80:
        return "かなりキツい", "余白がほぼゼロ。1つ減らせるとかなり楽になる"
    if percentage >= 40:
        return "適正", "いい感じのバランス。このペースでいこう"
    return "余裕あり", "まだ余力あり。やりたかったことを1つ足せる"


# ── オンボーディング：継続可能な1日の限界時間を計算 ─────────────────────────

def compute_sustainable_capacity(
    free_time_minutes: int,
    sleep_minimum_minutes: int,
    fixed_commitment_minutes: int,
    sustainable_work_minutes: int,
    max_effort_minutes: int,
) -> int:
    """5問の回答から「継続可能な1日の限界時間」を計算する。

    単純合計にしない理由：
    - 「頑張った日の最大値」をそのまま毎日の上限にすると、その値が
      日常的に要求される数字になってしまい、翌日以降の負荷判定が
      常に「キャパオーバー」に張り付いてしまう（=このアプリの根幹である
      「無理のないスケジュール管理」を裏切る）。
    - そのため「普段無理なく続けられる時間」を主軸(70%)にしつつ、
      「頑張れる日の余地」を3割だけ混ぜて、日々の変動を許容する。
    """
    blended = sustainable_work_minutes * 0.7 + max_effort_minutes * 0.3

    # 物理的な上限：24時間から睡眠と固定予定を引いた残り時間は超えられない
    physical_ceiling = max(0, 24 * 60 - sleep_minimum_minutes - fixed_commitment_minutes)
    # 自己申告の自由時間も上限として使う（両方のうち小さい方を採用）
    ceiling = min(physical_ceiling, free_time_minutes) if free_time_minutes > 0 else physical_ceiling
    capacity = min(blended, ceiling) if ceiling > 0 else blended

    # 極端な値を避ける（最低1時間・最大10時間）
    return int(max(60, min(600, round(capacity))))


def today_str() -> str:
    """今日の日付を Asia/Tokyo タイムゾーンで返す"""
    jst = pytz.timezone("Asia/Tokyo")
    return datetime.now(jst).date().isoformat()


# ── Gemini（称号生成）────────────────────────────────────────────────────

class GeminiUnavailableError(Exception):
    """GEMINI_API_KEY が未設定。呼び出し側で 503 に変換する。"""


class GeminiGenerationError(Exception):
    """Gemini呼び出し失敗、またはレスポンスのJSONが不正。呼び出し側で 502 に変換する。"""


_gemini_client: Optional["genai.Client"] = None


def _get_gemini_client() -> Optional["genai.Client"]:
    """クライアントは初回呼び出し時に1度だけ作る。キー未設定なら None を返す。"""
    global _gemini_client
    if not GEMINI_API_KEY:
        return None
    if _gemini_client is None:
        # timeout はミリ秒。Render 無料プランでリクエストがぶら下がり続けるのを防ぐ。
        _gemini_client = genai.Client(
            api_key=GEMINI_API_KEY,
            http_options=genai_types.HttpOptions(timeout=30_000),
        )
    return _gemini_client


# 生成に使う JSON スキーマ（title / reason / nextAction の3つだけ）
_SUMMARY_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"},
        "reason": {"type": "STRING"},
        "nextAction": {"type": "STRING"},
    },
    "required": ["title", "reason", "nextAction"],
}


def _build_summary_config() -> "genai_types.GenerateContentConfig":
    """gemini-2.5-flash 向けの生成設定。

    【重要】gemini-2.5 系はデフォルトで「思考(thinking)」が有効で、
    出力トークンを思考に先に使ってしまう。structured output と組み合わせると
    本文が空 or 途中で切れた状態（finish_reason=MAX_TOKENS）で返ってきて、
    json.loads が落ちる ＝ 502 になる。これが「Geminiの生成に失敗する」主因。
    thinking_budget=0 で思考を切り、max_output_tokens も明示して防ぐ。

    2.0 以前のモデルは ThinkingConfig を受け付けないので、
    モデル名で分岐して付け外しする。
    """
    kwargs = dict(
        response_mime_type="application/json",
        response_schema=_SUMMARY_SCHEMA,
        temperature=0.7,          # 0.9 は構造化出力が崩れやすいので下げる
        max_output_tokens=512,    # title/reason/nextAction には十分な量
    )
    if "2.5" in GEMINI_MODEL or "3." in GEMINI_MODEL:
        kwargs["thinking_config"] = genai_types.ThinkingConfig(thinking_budget=0)
    return genai_types.GenerateContentConfig(**kwargs)


def _extract_summary_text(response) -> str:
    """response.text を安全に取り出す。

    google-genai の response.text は、安全フィルタでブロックされたときや
    MAX_TOKENS で打ち切られたときに None を返すことがある。
    そのまま json.loads(None) すると TypeError になって
    「何が起きたか分からない502」になるので、ここで理由を特定して投げる。
    """
    text = getattr(response, "text", None)
    if text:
        return text

    # なぜ空だったのかを finish_reason から特定する
    reason = "unknown"
    try:
        candidates = getattr(response, "candidates", None) or []
        if candidates:
            fr = getattr(candidates[0], "finish_reason", None)
            if fr is not None:
                reason = getattr(fr, "name", str(fr))
        else:
            pf = getattr(response, "prompt_feedback", None)
            br = getattr(pf, "block_reason", None) if pf else None
            if br is not None:
                reason = f"blocked:{getattr(br, 'name', str(br))}"
    except Exception:
        pass

    raise GeminiGenerationError(f"Gemini returned empty text (finish_reason={reason})")


def generate_daily_summary_via_gemini(
    completed_tasks: list[CompletedTaskInput],
    planned_minutes: int,
    actual_minutes: int,
    capacity_minutes: int,
    planned_percentage: int,
    actual_percentage: int,
) -> dict:
    """完了タスクと予定/実績データからGeminiで「称号・理由・次への一言」を生成する。

    ここでは失敗を握りつぶさない（フォールバック文言に逃げない）。
    キー未設定／呼び出し失敗／JSON崩れは、それぞれ専用の例外を投げて
    呼び出し元（エンドポイント）で 503 / 502 に変換させる。
    「静かに嘘の成功を返す」より「失敗したとわかる」方を優先する方針。

    ただし Gemini 側の一時的な 429/503 は珍しくないので、1回だけ再試行する。
    """
    client = _get_gemini_client()
    if client is None:
        raise GeminiUnavailableError("GEMINI_API_KEY is not set")

    tasks_text = "\n".join(
        f"- {t.title}（{t.category or '未分類'}／予定{t.plannedMinutes}分・実績{t.actualMinutes}分）"
        for t in completed_tasks
    ) or "（完了したタスクなし）"

    prompt = (
        "あなたは学生向けスケジューラーアプリのAIです。\n"
        "以下のデータをもとに、ユーザーの今日1日を分析し、"
        "「称号」「理由」「次への一言」を日本語で作ってください。\n\n"
        f"ユーザーの1日の限界時間: {capacity_minutes}分\n"
        f"今日の予定合計時間: {planned_minutes}分（限界に対して{planned_percentage}%）\n"
        f"今日の実績合計時間: {actual_minutes}分（限界に対して{actual_percentage}%）\n"
        f"完了したタスク:\n{tasks_text}\n\n"
        "予定に対してどれくらい実行できたか（実績/予定の差）、"
        "限界時間に対する負荷の大きさ、タスクの達成状況を踏まえて評価してください。"
        "励ますだけでなく、データに基づいた具体的な内容にしてください。\n"
        "称号(title)は15文字以内、理由(reason)は60文字以内、"
        "次への一言(nextAction)は40文字以内。"
        "前置きや説明文は付けず、JSONだけを返してください。"
    )

    config = _build_summary_config()

    last_err: Optional[Exception] = None
    for attempt in range(2):  # 1回だけ再試行（合計2回）
        try:
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=prompt,
                config=config,
            )
        except Exception as e:
            # 429（レート制限）/ 503（過負荷）/ タイムアウトは再試行する価値がある
            last_err = e
            if attempt == 0 and _is_retryable_gemini_error(e):
                continue
            raise GeminiGenerationError(
                f"Gemini call failed: {type(e).__name__}: {str(e)[:200]}"
            ) from e

        try:
            raw = _extract_summary_text(response)
            data = json.loads(raw)
            title = str(data["title"]).strip()
            reason = str(data["reason"]).strip()
            next_action = str(data["nextAction"]).strip()
            if not title or not reason or not next_action:
                raise ValueError("empty field in Gemini response")
        except GeminiGenerationError as e:
            # 空レスポンスは一度だけ引き直す（thinking 由来の空振り対策の保険）
            last_err = e
            if attempt == 0:
                continue
            raise
        except Exception as e:
            last_err = e
            if attempt == 0:
                continue
            raise GeminiGenerationError(
                f"Malformed Gemini response: {type(e).__name__}: {str(e)[:200]}"
            ) from e

        return {"title": title[:60], "reason": reason[:200], "nextAction": next_action[:120]}

    # ここには来ない想定だが、保険
    raise GeminiGenerationError(f"Gemini failed after retries: {type(last_err).__name__}")


def _is_retryable_gemini_error(e: Exception) -> bool:
    """429 / 503 / タイムアウトなど、もう一度叩けば通る可能性があるものか判定"""
    s = f"{type(e).__name__} {e}".lower()
    return any(
        k in s
        for k in ("429", "rate", "quota", "503", "unavailable", "overload", "timeout", "deadline")
    )


def db_error(e: Exception, what: str) -> HTTPException:
    """Supabase 由来の例外を素直な HTTP エラーに変換
    
    RLS による拒否（他人のデータ）も 404 に統一して、
    「存在しない」と「アクセス権がない」を区別させない（情報漏えい防止）
    """
    msg = str(e)
    # RLS 拒否と行なしを同じ 404 で返す
    if "PGRST116" in msg or "0 rows" in msg or "42501" in msg or "row-level security" in msg.lower():
        return HTTPException(status_code=404, detail=f"{what}: 見つかりません")
    if "23514" in msg or "violates check constraint" in msg.lower():
        return HTTPException(status_code=400, detail=f"{what}: 入力値が制約に反しています")
    return HTTPException(status_code=400, detail=f"{what}: エラーが発生しました")


# ============================================================
# 動作確認用（認証なし）
# ============================================================

@app.get("/health", tags=["debug"])
async def health():
    return {"status": "ok", "service": "workload-scheduler-api", "version": "1.1.0"}


@app.get("/debug/sample-calc", tags=["debug"])
async def debug_sample_calc(total: int = 120, capacity: int = 240):
    """DB を触らずに計算ロジックだけ確認する"""
    percentage = round((total / capacity) * 100) if capacity > 0 else 0
    level, comment = judge_level(percentage)
    return {
        "totalMinutes": total,
        "capacityMinutes": capacity,
        "workloadPercentage": percentage,
        "workloadLevel": level,
        "comment": comment,
        "remainingMinutes": max(0, capacity - total),
    }


@app.get("/debug/gemini", tags=["debug"])
async def debug_gemini():
    """認証不要。Gemini が実際に喋れるかだけを確認する切り分け用エンドポイント。

    「総括が出ない」ときに、原因が
      (a) APIキー未設定 / (b) Gemini自体の失敗 / (c) 認証やDB側の問題
    のどれなのかを一発で切り分けるために使う。
    ここが ok:true なら Gemini は生きているので、原因は (c) 側。
    """
    if not GEMINI_API_KEY:
        return {
            "ok": False,
            "stage": "config",
            "model": GEMINI_MODEL,
            "detail": "GEMINI_API_KEY が未設定です（Render の Environment を確認）",
        }

    dummy = [CompletedTaskInput(title="動作確認タスク", category="その他",
                                plannedMinutes=60, actualMinutes=45)]
    try:
        result = generate_daily_summary_via_gemini(dummy, 60, 45, 240, 25, 19)
    except GeminiUnavailableError as e:
        return {"ok": False, "stage": "config", "model": GEMINI_MODEL, "detail": str(e)}
    except GeminiGenerationError as e:
        # ここに出る文字列がそのまま原因になる
        return {"ok": False, "stage": "generation", "model": GEMINI_MODEL, "detail": str(e)}
    except Exception as e:
        return {"ok": False, "stage": "unexpected", "model": GEMINI_MODEL,
                "detail": f"{type(e).__name__}: {str(e)[:200]}"}

    return {"ok": True, "stage": "done", "model": GEMINI_MODEL, "sample": result}


# ============================================================
# プロフィール
# ============================================================

@app.get("/api/user/profile", tags=["profile"])
async def get_profile(ctx: AuthContext = Depends(auth)):
    """ログイン中ユーザーのプロフィール（限界時間を含む）"""
    try:
        res = ctx.db.table("profiles").select("*").eq("id", ctx.user_id).single().execute()
    except Exception as e:
        raise db_error(e, "プロフィール取得")
    return profile_to_api(res.data)


@app.put("/api/user/profile", tags=["profile"])
async def update_profile(req: UpdateProfileRequest, ctx: AuthContext = Depends(auth)):
    """限界時間や名前、アンケート完了フラグを更新する"""
    payload = {}
    if req.name is not None:
        payload["name"] = req.name
    if req.maxWorkloadMinutes is not None:
        payload["max_workload_minutes"] = req.maxWorkloadMinutes
    if req.onboardingCompleted is not None:
        payload["onboarding_completed"] = req.onboardingCompleted

    if not payload:
        raise HTTPException(status_code=400, detail="更新する項目がありません")

    try:
        res = ctx.db.table("profiles").update(payload).eq("id", ctx.user_id).execute()
    except Exception as e:
        raise db_error(e, "プロフィール更新")

    if not res.data:
        raise HTTPException(status_code=404, detail="プロフィールが見つかりません")
    return profile_to_api(res.data[0])


# ============================================================
# タスク CRUD
# ============================================================

@app.get("/api/tasks", tags=["tasks"])
async def list_tasks(
    target_date: Optional[str] = Query(None, alias="date", description="YYYY-MM-DD。省略時は今日"),
    from_date: Optional[str] = Query(None, alias="from", description="YYYY-MM-DD。期間の開始日"),
    to_date: Optional[str] = Query(None, alias="to", description="YYYY-MM-DD。期間の終了日"),
    ctx: AuthContext = Depends(auth),
):
    """タスク一覧（開始時刻順）

    - date のみ  : その日のタスク
    - from / to  : 期間で取得（カレンダー表示用。片方だけの指定も可）
    - 指定なし    : 今日のタスク
    """
    use_range = from_date is not None or to_date is not None

    query = ctx.db.table("tasks").select("*").eq("user_id", ctx.user_id)

    if use_range:
        if from_date:
            query = query.gte("scheduled_date", from_date)
        if to_date:
            query = query.lte("scheduled_date", to_date)
        query = query.order("scheduled_date", desc=False)
    else:
        d = target_date or today_str()
        query = query.eq("scheduled_date", d)

    try:
        res = query.order("start_time", desc=False).order("created_at", desc=False).execute()
    except Exception as e:
        raise db_error(e, "タスク一覧取得")

    tasks = [task_to_api(r) for r in res.data]

    if use_range:
        return {"from": from_date, "to": to_date, "count": len(tasks), "tasks": tasks}
    return {"date": target_date or today_str(), "count": len(tasks), "tasks": tasks}


@app.post("/api/tasks", status_code=201, tags=["tasks"])
async def create_task(req: CreateTaskRequest, ctx: AuthContext = Depends(auth)):
    """タスクを1件登録する"""
    payload = {
        "user_id": ctx.user_id,
        "title": req.title,
        "planned_minutes": req.plannedMinutes,
        "category": req.category,
        "start_time": req.startTime,
        "scheduled_date": req.date or today_str(),
        "is_completed": False,
    }
    try:
        res = ctx.db.table("tasks").insert(payload).execute()
    except Exception as e:
        raise db_error(e, "タスク登録")

    if not res.data:
        raise HTTPException(status_code=400, detail="タスクを登録できませんでした")
    return task_to_api(res.data[0])


@app.put("/api/tasks/{task_id}", tags=["tasks"])
async def update_task(task_id: str, req: UpdateTaskRequest, ctx: AuthContext = Depends(auth)):
    """タスクを更新する（完了フラグ、実績時間など）"""
    payload = {}
    if req.title is not None:
        payload["title"] = req.title
    if req.plannedMinutes is not None:
        payload["planned_minutes"] = req.plannedMinutes
    if req.actualMinutes is not None:
        payload["actual_minutes"] = req.actualMinutes
    if req.isCompleted is not None:
        payload["is_completed"] = req.isCompleted
    if req.category is not None:
        payload["category"] = req.category
    if req.date is not None:
        payload["scheduled_date"] = req.date
    if req.startTime is not None:
        payload["start_time"] = req.startTime

    if not payload:
        raise HTTPException(status_code=400, detail="更新する項目がありません")

    try:
        res = (
            ctx.db.table("tasks")
            .update(payload)
            .eq("id", task_id)
            .eq("user_id", ctx.user_id)
            .execute()
        )
    except Exception as e:
        raise db_error(e, "タスク更新")

    if not res.data:
        raise HTTPException(status_code=404, detail="タスクが見つかりません")
    return task_to_api(res.data[0])


@app.delete("/api/tasks/{task_id}", tags=["tasks"])
async def delete_task(task_id: str, ctx: AuthContext = Depends(auth)):
    """タスクを削除する"""
    try:
        res = (
            ctx.db.table("tasks")
            .delete()
            .eq("id", task_id)
            .eq("user_id", ctx.user_id)
            .execute()
        )
    except Exception as e:
        raise db_error(e, "タスク削除")

    if not res.data:
        raise HTTPException(status_code=404, detail="タスクが見つかりません")
    return {"deleted": True, "id": task_id}


# ============================================================
# 負荷計算（このアプリの肝）
# ============================================================

async def _calculate(ctx: AuthContext, d: str) -> WorkloadResponse:
    try:
        profile = (
            ctx.db.table("profiles")
            .select("max_workload_minutes")
            .eq("id", ctx.user_id)
            .single()
            .execute()
        )
    except Exception as e:
        raise db_error(e, "プロフィール取得")

    capacity = profile.data["max_workload_minutes"]

    try:
        tasks = (
            ctx.db.table("tasks")
            .select("planned_minutes, is_completed")
            .eq("user_id", ctx.user_id)
            .eq("scheduled_date", d)
            .execute()
        )
    except Exception as e:
        raise db_error(e, "タスク取得")

    rows = tasks.data
    total = sum(r["planned_minutes"] for r in rows)
    completed = sum(1 for r in rows if r["is_completed"])

    # DB 側で max_workload_minutes > 0 が保証されているが、念のため
    if capacity <= 0:
        capacity = 240

    percentage = round((total / capacity) * 100)
    level, comment = judge_level(percentage)

    return WorkloadResponse(
        date=d,
        totalMinutes=total,
        capacityMinutes=capacity,
        workloadPercentage=percentage,
        workloadLevel=level,
        comment=comment,
        remainingMinutes=max(0, capacity - total),
        taskCount=len(rows),
        completedCount=completed,
    )


@app.get("/api/workload", response_model=WorkloadResponse, tags=["workload"])
async def get_workload(
    target_date: Optional[str] = Query(None, alias="date"),
    ctx: AuthContext = Depends(auth),
):
    """指定日の負荷率を返す（GET版・フロントから読むだけならこちら）"""
    return await _calculate(ctx, target_date or today_str())


@app.post("/api/workload/calculate", response_model=WorkloadResponse, tags=["workload"])
async def calculate_workload(
    target_date: Optional[str] = Query(None, alias="date"),
    ctx: AuthContext = Depends(auth),
):
    """
    指定日の負荷率を計算する。

    キツさ(%) = sum(tasks.planned_minutes) / profiles.max_workload_minutes * 100
    """
    return await _calculate(ctx, target_date or today_str())


# ============================================================
# オンボーディング：継続可能な限界時間の計算・保存
# ============================================================

@app.post("/api/onboarding/calculate-capacity", response_model=OnboardingResult, tags=["profile"])
async def calculate_capacity(req: OnboardingAnswers, ctx: AuthContext = Depends(auth)):
    """5問の回答から「継続可能な1日の限界時間」を計算し、profilesに保存する。

    フロントエンドでは計算しない（計算式を変えたときにアプリの再デプロイが
    要らないようにするため）。計算結果は即座に max_workload_minutes に反映し、
    onboarding_completed も true にする。
    """
    capacity = compute_sustainable_capacity(
        req.freeTimeMinutes,
        req.sleepMinimumMinutes,
        req.fixedCommitmentMinutes,
        req.sustainableWorkMinutes,
        req.maxEffortMinutes,
    )
    try:
        ctx.db.table("profiles").update({
            "max_workload_minutes": capacity,
            "onboarding_completed": True,
        }).eq("id", ctx.user_id).execute()
    except Exception as e:
        raise db_error(e, "限界値の保存")

    return OnboardingResult(capacityMinutes=capacity, onboardingCompleted=True)


# ============================================================
# 今日の総括（称号）— Gemini連携
# ============================================================

@app.post("/api/daily-summary/generate", response_model=DailySummaryResponse, tags=["daily-summary"])
async def generate_daily_summary(req: DailySummaryRequest, ctx: AuthContext = Depends(auth)):
    """今日の予定/実績データをGeminiに渡し、称号・理由・次への一言を生成して
    daily_summaries に保存する。

    plannedPercentage / actualPercentage の計算はここ（バックエンド）で行い、
    Geminiには「材料」として渡すだけにする（判断の丸投げをしない）。

    (user_id, summary_date) がユニーク制約なので、同じ日に再生成すると上書きされる。

    Geminiが使えない/失敗した場合は、静かにデフォルト文言へ逃げるのではなく
    503 / 502 を返す（フロント側でユーザーに「生成できませんでした」と
    伝えるため）。
    """
    d = req.date or today_str()
    planned_percentage = round((req.plannedMinutes / req.capacityMinutes) * 100)
    actual_percentage = round((req.actualMinutes / req.capacityMinutes) * 100)

    try:
        result = generate_daily_summary_via_gemini(
            req.completedTasks,
            req.plannedMinutes,
            req.actualMinutes,
            req.capacityMinutes,
            planned_percentage,
            actual_percentage,
        )
    except GeminiUnavailableError:
        raise HTTPException(status_code=503, detail="AIによる総括生成は現在利用できません（APIキー未設定）")
    except GeminiGenerationError:
        raise HTTPException(status_code=502, detail="AIによる総括生成に失敗しました。しばらくしてから再度お試しください。")

    payload = {
        "user_id": ctx.user_id,
        "summary_date": d,
        "title": result["title"],
        "reason": result["reason"],
        "message": result["nextAction"],
        "total_focus_time_minutes": req.actualMinutes,
    }
    try:
        ctx.db.table("daily_summaries").upsert(payload, on_conflict="user_id,summary_date").execute()
    except Exception:
        # 生成自体は成功しているので、保存に失敗してもユーザーには結果を返す。
        # （画面には出るが次回の履歴には残らない、という穏やかな劣化にする）
        pass

    return DailySummaryResponse(
        date=d,
        title=result["title"],
        reason=result["reason"],
        nextAction=result["nextAction"],
        plannedPercentage=planned_percentage,
        actualPercentage=actual_percentage,
        totalFocusTimeMinutes=req.actualMinutes,
    )


@app.get("/api/daily-summary/history", tags=["daily-summary"])
async def get_daily_summary_history(ctx: AuthContext = Depends(auth)):
    """称号履歴（新しい日付順、最大30件）"""
    try:
        res = (
            ctx.db.table("daily_summaries")
            .select("summary_date, title, reason, message")
            .eq("user_id", ctx.user_id)
            .order("summary_date", desc=True)
            .limit(30)
            .execute()
        )
    except Exception as e:
        raise db_error(e, "称号履歴取得")

    history = [
        DailySummaryHistoryItem(date=r["summary_date"], title=r["title"], reason=r["reason"], nextAction=r.get("message"))
        for r in res.data
    ]
    return {"history": history}
