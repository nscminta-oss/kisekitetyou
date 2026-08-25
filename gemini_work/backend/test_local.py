"""
DB に繋がずに動くところまでを確認するテスト。

実行:
    pip install pytest
    pytest test_local.py -v

ここで確認するのは「サーバーが正しく立ち上がるか」「計算式が合っているか」
「認証していないリクエストをちゃんと弾くか」の3点。
実際の DB 読み書きは、フロントからログインして試す。
"""

import datetime

import jwt
import pytest
from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


def make_token(user_id="00000000-0000-0000-0000-000000000001", expired=False):
    """テスト用のダミートークン（署名はでたらめでよい）"""
    delta = datetime.timedelta(hours=-1 if expired else 1)
    payload = {
        "sub": user_id,
        "exp": datetime.datetime.now(datetime.timezone.utc) + delta,
    }
    return jwt.encode(payload, "dummy-secret", algorithm="HS256")


# --- サーバーが立つか ---

def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# --- 計算式が合っているか ---

@pytest.mark.parametrize(
    "total,capacity,expected_pct,expected_level",
    [
        (120, 240, 50, "適正"),
        (0, 240, 0, "余裕あり"),
        (95, 240, 40, "適正"),
        (200, 240, 83, "かなりキツい"),
        (240, 240, 100, "かなりキツい"),  # ちょうど100%は「超えてはいない」のでキャパオーバー手前
        (300, 240, 125, "キャパオーバー"),
        (60, 120, 50, "適正"),   # キャパが人によって違っても比率で判定
    ],
)
def test_calc(total, capacity, expected_pct, expected_level):
    r = client.get(f"/debug/sample-calc?total={total}&capacity={capacity}")
    assert r.status_code == 200
    body = r.json()
    assert body["workloadPercentage"] == expected_pct
    assert body["workloadLevel"] == expected_level


def test_judge_level_boundaries():
    """境界値：80と100は「超えた」ときにレベルが上がる"""
    assert main.judge_level(80)[0] == "適正"
    assert main.judge_level(81)[0] == "かなりキツい"
    assert main.judge_level(100)[0] == "かなりキツい"
    assert main.judge_level(101)[0] == "キャパオーバー"
    assert main.judge_level(39)[0] == "余裕あり"
    assert main.judge_level(40)[0] == "適正"


# --- 認証を正しく弾くか ---

PROTECTED = [
    ("get", "/api/user/profile"),
    ("get", "/api/tasks"),
    ("post", "/api/tasks"),
    ("get", "/api/workload"),
    ("post", "/api/workload/calculate"),
]


@pytest.mark.parametrize("method,path", PROTECTED)
def test_requires_auth(method, path):
    if method == "post":
        r = client.post(path, json={"title": "x", "plannedMinutes": 30})
    else:
        r = client.get(path)
    assert r.status_code == 401


def test_rejects_malformed_header():
    r = client.get("/api/tasks", headers={"Authorization": "Token abc"})
    assert r.status_code == 401
    assert "Bearer" in r.json()["detail"]


def test_rejects_expired_token():
    token = make_token(expired=True)
    r = client.get("/api/tasks", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
    assert "expired" in r.json()["detail"].lower()


def test_rejects_garbage_token():
    r = client.get("/api/tasks", headers={"Authorization": "Bearer not-a-jwt"})
    assert r.status_code == 401


# --- 入力バリデーション ---
# 【注記】auth() は以前 verify_signature=False でJWTを自前デコードしていたため、
# ここで作る「でたらめな署名のダミートークン」でも通っていた（＝誰でも他人に
# なりすませる重大バグだった）。修正後は auth() が Supabase 本体に問い合わせて
# 検証するようになったため、ダミートークンはもう通らない（正しい挙動）。
# バリデーション自体をテストしたいこの2件は、auth 依存関係を差し替えて
# 「認証は通った体」にする。

@pytest.fixture
def authed_client():
    def _fake_auth():
        return main.AuthContext(user_id="00000000-0000-0000-0000-000000000001", client=None)
    main.app.dependency_overrides[main.auth] = _fake_auth
    yield client
    main.app.dependency_overrides.clear()


def test_rejects_zero_minutes(authed_client):
    """0分のタスクは DB に届く前に弾く（DB 側にも CHECK 制約あり）"""
    r = authed_client.post(
        "/api/tasks",
        json={"title": "テスト", "plannedMinutes": 0},
    )
    assert r.status_code == 422


def test_rejects_empty_title(authed_client):
    r = authed_client.post(
        "/api/tasks",
        json={"title": "", "plannedMinutes": 30},
    )
    assert r.status_code == 422


# --- オンボーディング：限界時間の計算 ---

def test_capacity_blends_sustainable_and_max_effort():
    """普段70% + 頑張った日30%のブレンドになっている"""
    capacity = main.compute_sustainable_capacity(
        free_time_minutes=600, sleep_minimum_minutes=420, fixed_commitment_minutes=480,
        sustainable_work_minutes=120, max_effort_minutes=240,
    )
    assert capacity == round(120 * 0.7 + 240 * 0.3)  # 156


def test_capacity_capped_by_physical_ceiling():
    """睡眠+固定予定を24時間から引いた残り時間を超えない"""
    capacity = main.compute_sustainable_capacity(
        free_time_minutes=1000, sleep_minimum_minutes=480, fixed_commitment_minutes=600,
        sustainable_work_minutes=500, max_effort_minutes=500,
    )
    # 24h - 8h(睡眠) - 10h(固定) = 6h(360分) が上限
    assert capacity <= 360


def test_capacity_never_below_minimum():
    """極端に小さい回答でも最低60分は確保する"""
    capacity = main.compute_sustainable_capacity(
        free_time_minutes=0, sleep_minimum_minutes=600, fixed_commitment_minutes=600,
        sustainable_work_minutes=0, max_effort_minutes=0,
    )
    assert capacity == 60


def test_capacity_never_exceeds_maximum():
    """極端に大きい回答でも最大600分(10時間)を超えない"""
    capacity = main.compute_sustainable_capacity(
        free_time_minutes=1440, sleep_minimum_minutes=0, fixed_commitment_minutes=0,
        sustainable_work_minutes=1440, max_effort_minutes=1440,
    )
    assert capacity == 600


def test_onboarding_requires_auth():
    r = client.post("/api/onboarding/calculate-capacity", json={
        "freeTimeMinutes": 300, "sleepMinimumMinutes": 420, "fixedCommitmentMinutes": 480,
        "sustainableWorkMinutes": 120, "maxEffortMinutes": 240,
    })
    assert r.status_code == 401


# --- 今日の総括：Gemini未設定時は503 ---

def test_daily_summary_returns_503_without_gemini_key(authed_client, monkeypatch):
    monkeypatch.setattr(main, "GEMINI_API_KEY", None)
    monkeypatch.setattr(main, "_gemini_client", None)
    r = authed_client.post("/api/daily-summary/generate", json={
        "capacityMinutes": 240, "plannedMinutes": 120, "actualMinutes": 90, "completedTasks": [],
    })
    assert r.status_code == 503

def test_task_to_api_converts_snake_to_camel():
    row = {
        "id": "abc",
        "user_id": "u1",
        "title": "レポート",
        "scheduled_date": "2026-08-24",
        "planned_minutes": 90,
        "actual_minutes": None,
        "is_completed": False,
        "start_time": "10:00:00",
    }
    out = main.task_to_api(row)
    assert out["plannedMinutes"] == 90
    assert out["date"] == "2026-08-24"
    assert out["isCompleted"] is False
    assert "planned_minutes" not in out
