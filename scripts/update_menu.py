#!/usr/bin/env python3
"""学食の週間メニューPDFを取得し、Gemini で読み取って data/week.json を更新する。

流れ:
  1. 各食堂のPDFをダウンロードし、前回のハッシュ値と比べる（同じなら何もしない）
  2. 変わった食堂だけ Gemini にPDFを読ませ、決まった形のJSONを受け取る
  3. 食堂ごとのルール（data/cafeterias.json の rules）をプログラムで当てる
  4. 検証に通った食堂だけ week.json に書き込む

使い方:
  GEMINI_API_KEY=... python3 scripts/update_menu.py           # 通常実行
  python3 scripts/update_menu.py --force --only tsudanuma      # ハッシュが同じでも読み直す
  python3 scripts/update_menu.py --extracted dir/              # Gemini を呼ばず dir/<id>.json を使う（テスト用）

終了コード: 0=成功（更新なしを含む） / 1=検証やAPIのエラーがあった（成功した食堂は書き込み済み）
外部ライブラリは使わない（GitHub Actions の標準の Python で動かすため）。
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CAFETERIAS_PATH = ROOT / "data" / "cafeterias.json"
WEEK_PATH = ROOT / "data" / "week.json"
JST = dt.timezone(dt.timedelta(hours=9))

DEFAULT_MODEL = "gemini-3.8-flash"
API_BASE = "https://generativelanguage.googleapis.com/v1beta"
API_REVISION = "2026-05-20"
USER_AGENT = "gakushoku-gacha-menu-updater/1.0"

CATEGORIES = ["朝定食", "定食・丼", "丼", "カレー", "麺", "パスタ", "サラダ", "お弁当", "夕定食", "小鉢・単品", "その他"]
SIDE_CATEGORIES = {"サラダ", "小鉢・単品", "その他"}
SLOTS = ["morning", "lunch", "dinner"]

# Gemini に返させるJSONの形
EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "days": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "YYYY-MM-DD"},
                    "closed": {"type": "boolean", "description": "その日が終日休業なら true"},
                    "closedSlots": {"type": "array", "items": {"type": "string", "enum": SLOTS},
                                    "description": "その日だけ休みの時間帯"},
                    "note": {"type": "string", "description": "その日のお知らせ（なければ空文字）"},
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "price": {"type": "integer"},
                                "category": {"type": "string", "enum": CATEGORIES},
                                "slot": {"type": "string", "enum": SLOTS},
                            },
                            "required": ["name", "price", "category", "slot"],
                        },
                    },
                },
                "required": ["date", "closed", "items"],
            },
        }
    },
    "required": ["days"],
}


class UpdateError(Exception):
    pass


# ---------------------------------------------------------------- 入出力

def load_json(path: pathlib.Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path: pathlib.Path, obj) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def http(url: str, body: dict | None = None, headers: dict | None = None, timeout: int = 180) -> bytes:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def download_pdf(url: str) -> bytes:
    pdf = http(url)
    if not pdf.startswith(b"%PDF"):
        raise UpdateError(f"PDFではないデータが返ってきました: {url}")
    return pdf


# ---------------------------------------------------------------- Gemini

def build_prompt(caf: dict, today: dt.date, example: dict | None) -> str:
    regular = "、".join(f"{m['name']}（¥{m['price']}）" for m in caf["regular"]) or "なし"
    lines = [
        f"千葉工業大学の学生食堂「{caf['name']}」（{caf['place']}）の週間メニューPDFです。",
        "表を読み取り、指定のJSONスキーマで日ごとのメニューを返してください。",
        "",
        "# ルール",
        f"- 今日は {today.isoformat()}。PDFの日付に年がなければ、今日に近い年を補ってください。",
        "- 月〜金だけを出力します。土曜・日曜は出力しないでください。",
        "- 価格は円の整数。「＜工大400＞」は 400。行見出しにだけ価格がある場合はその価格を各日に当てる。",
        "- 半角カタカナは全角にする。料理名は表の文字どおりに、改行で分かれた語はつなげる。",
        "- 行見出しが料理の種類を表すときは、それと分かる名前にする（例: カレー欄の「メンチカツ」→「メンチカツカレー」）。",
        "- トッピングだけが日替りのメニュー（例: グルメカレー）は「グルメカレー（唐揚）」の形にする。",
        "- 毎日同じ常設メニュー（定番・単品・小鉢の欄）は出力しない。この食堂の常設メニュー: " + regular,
        "- 朝定食は slot=morning、夕定食は slot=dinner、それ以外は slot=lunch。",
        "- 「休業」と書かれた日は closed=true、items は空。夕方だけ休みなどは closedSlots に入れる。",
        "- 祝日や営業時間の変更などのお知らせは、その日の note に短く書く。",
        "- 同じ日に同じ名前のメニューを重複して出さない。読み取れない文字は推測で埋めず、その品を省く。",
    ]
    if example:
        lines += ["", "# 出力の例（この食堂の過去の週。形式と命名の参考にする。内容は今回のPDFに従う）",
                  json.dumps(example, ensure_ascii=False)]
    return "\n".join(lines)


def find_json_text(node):
    """レスポンスの中から、days を含むJSON文字列を探す（APIの版によって置き場所が違うため）。"""
    found = None
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "text" and isinstance(v, str):
                parsed = parse_json_text(v)
                if isinstance(parsed, dict) and "days" in parsed:
                    found = parsed
            else:
                found = find_json_text(v) or found
    elif isinstance(node, list):
        for v in node:
            found = find_json_text(v) or found
    return found


def parse_json_text(text: str):
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def call_gemini(pdf: bytes, prompt: str, api_key: str, model: str) -> dict:
    b64 = base64.b64encode(pdf).decode()
    headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}
    attempts = [
        # 現行の Interactions API
        (f"{API_BASE}/interactions", {**headers, "Api-Revision": API_REVISION}, {
            "model": model,
            "input": [
                {"type": "text", "text": prompt},
                {"type": "document", "data": b64, "mime_type": "application/pdf"},
            ],
            "response_format": {"type": "text", "mime_type": "application/json", "schema": EXTRACT_SCHEMA},
        }),
        # 旧来の generateContent（Interactions API が使えないときの予備）
        (f"{API_BASE}/models/{model}:generateContent", headers, {
            "contents": [{"parts": [
                {"inline_data": {"mime_type": "application/pdf", "data": b64}},
                {"text": prompt + "\n\n# 出力するJSONスキーマ\n" + json.dumps(EXTRACT_SCHEMA, ensure_ascii=False)},
            ]}],
            "generationConfig": {"responseMimeType": "application/json"},
        }),
    ]
    errors = []
    for url, hdrs, body in attempts:
        for retry in range(3):
            try:
                res = json.loads(http(url, body, hdrs))
                result = find_json_text(res)
                if result is None:
                    raise UpdateError("レスポンスにメニューのJSONが見つかりません")
                return result
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:300]
                if e.code in (429, 500, 502, 503, 504) and retry < 2:
                    time.sleep(20 * (retry + 1))
                    continue
                errors.append(f"{url.split('/v1beta/')[1]} → HTTP {e.code}: {detail}")
                break
            except (UpdateError, urllib.error.URLError, TimeoutError) as e:
                errors.append(f"{url.split('/v1beta/')[1]} → {e}")
                break
    raise UpdateError("Gemini の呼び出しに失敗しました:\n" + "\n".join(errors))


# ---------------------------------------------------------------- 変換（食堂ごとのルール）

def normalize_name(name: str) -> str:
    s = unicodedata.normalize("NFKC", name)  # 半角カナ→全角、全角英数→半角
    s = s.replace("(", "（").replace(")", "）").replace("&", "＆").replace("~", "〜")
    return re.sub(r"\s+", " ", s).strip()


def transform(raw: dict, caf: dict) -> dict:
    """Gemini の出力を week.json の1食堂分の形にする。"""
    rules = caf.get("rules", {})
    exclude = set(rules.get("excludeCats", []))
    corners = rules.get("cornerCats", {})
    topping_items = rules.get("toppingItems", [])
    regular_names = {m["name"] for m in caf["regular"]}

    daily, closed, closed_slots, notes, toppings = {}, [], {}, {}, {}
    for day in raw.get("days", []):
        try:
            date = dt.date.fromisoformat(day["date"])
        except (KeyError, ValueError):
            raise UpdateError(f"日付が読めません: {day.get('date')!r}")
        if date.weekday() >= 5:  # 土日は扱わない
            continue
        iso = date.isoformat()
        if day.get("closed"):
            closed.append(iso)
        if day.get("closedSlots"):
            closed_slots[iso] = sorted(set(day["closedSlots"]), key=SLOTS.index)
        if day.get("note"):
            notes[iso] = day["note"].strip()

        items = []
        for it in day.get("items", []):
            name = normalize_name(it["name"])
            cat = it["category"]
            if cat in exclude or cat == "小鉢・単品" or name in regular_names:
                continue
            topping = next((t for t in topping_items if name.startswith(t + "（") and name.endswith("）")), None)
            if topping:
                toppings.setdefault(topping, {})[iso] = name[len(topping) + 1:-1]
                continue
            item = {"name": name, "price": int(it["price"]), "cat": cat,
                    "main": cat not in SIDE_CATEGORIES, "slot": it["slot"]}
            if cat in corners:
                item["corner"] = corners[cat]
            items.append(item)
        if items or iso not in closed:
            daily[iso] = items

    dates = sorted(set(daily) | set(closed))
    if not dates:
        raise UpdateError("平日のメニューが1日分もありません")
    first = dt.date.fromisoformat(dates[0])
    week_start = first - dt.timedelta(days=first.weekday())
    return {"weekStart": week_start.isoformat(), "daily": dict(sorted(daily.items())),
            "closed": sorted(closed), "closedSlots": closed_slots, "notes": notes, "toppings": toppings}


def to_example(entry: dict) -> dict:
    """week.json の1食堂分を Gemini の出力形式に戻す（プロンプトの例とテストに使う）。"""
    days = []
    for iso in sorted(set(entry["daily"]) | set(entry.get("closed", []))):
        items = [{"name": m["name"], "price": m["price"], "category": m["cat"], "slot": m["slot"]}
                 for m in entry["daily"].get(iso, [])]
        for item_name, by_date in entry.get("toppings", {}).items():
            if iso in by_date:
                items.append({"name": f"{item_name}（{by_date[iso]}）", "price": 350, "category": "カレー", "slot": "lunch"})
        day = {"date": iso, "closed": iso in entry.get("closed", []), "items": items}
        if entry.get("closedSlots", {}).get(iso):
            day["closedSlots"] = entry["closedSlots"][iso]
        if entry.get("notes", {}).get(iso):
            day["note"] = entry["notes"][iso]
        days.append(day)
    return {"days": days}


# ---------------------------------------------------------------- 検証

def validate(entry: dict, prev: dict | None) -> list[str]:
    errors = []
    start = dt.date.fromisoformat(entry["weekStart"])
    weekdays = [(start + dt.timedelta(days=i)).isoformat() for i in range(5)]

    if prev and entry["weekStart"] < prev["weekStart"]:
        errors.append(f"週の開始日 {entry['weekStart']} が前回（{prev['weekStart']}）より古い")
    for iso in weekdays:
        if iso not in entry["daily"] and iso not in entry["closed"]:
            errors.append(f"{iso} のメニューがない（休業の印もない）")
    for iso in entry["daily"]:
        if iso not in weekdays:
            errors.append(f"{iso} が週（{weekdays[0]}〜{weekdays[-1]}）の外にある")

    for iso, items in entry["daily"].items():
        seen = set()
        for m in items:
            if not m["name"]:
                errors.append(f"{iso}: 名前が空のメニューがある")
            if not (50 <= m["price"] <= 1000) or m["price"] % 10:
                errors.append(f"{iso}: {m['name']} の価格 {m['price']} 円がおかしい")
            key = (m["name"], m["slot"])
            if key in seen:
                errors.append(f"{iso}: {m['name']} が重複している")
            seen.add(key)

    # 列のずれなどで品数が急に減っていないか（前回の1日あたり平均の半分未満ならエラー）
    def per_day(e):
        open_days = [items for iso, items in e["daily"].items() if iso not in e.get("closed", [])]
        return sum(len(x) for x in open_days) / len(open_days) if open_days else 0
    if prev and per_day(prev) and per_day(entry) < per_day(prev) * 0.5:
        errors.append(f"1日あたりの品数が {per_day(prev):.1f} → {per_day(entry):.1f} に急減した")
    return errors


# ---------------------------------------------------------------- メイン

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="PDFが変わっていなくても読み直す")
    ap.add_argument("--only", action="append", help="この食堂IDだけ処理する（複数指定可）")
    ap.add_argument("--extracted", type=pathlib.Path, help="Gemini を呼ばず <dir>/<id>.json を使う")
    ap.add_argument("--dry-run", action="store_true", help="week.json を書き換えない")
    args = ap.parse_args(argv)

    base = load_json(CAFETERIAS_PATH)
    week = load_json(WEEK_PATH)
    api_key = os.environ.get("GEMINI_API_KEY", "")
    model = os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL
    today = dt.datetime.now(JST).date()

    report, failed, changed = [], False, False
    for caf in base["cafeterias"]:
        cid = caf["id"]
        if args.only and cid not in args.only:
            continue
        prev = week["cafeterias"].get(cid)
        try:
            pdf = download_pdf(caf["pdf"])
            digest = hashlib.sha256(pdf).hexdigest()
            if prev and prev.get("sourceHash") == digest and not args.force:
                report.append(f"- {caf['name']}: PDFに変化なし")
                continue
            if args.extracted:
                raw = load_json(args.extracted / f"{cid}.json")
            else:
                if not api_key:
                    raise UpdateError("環境変数 GEMINI_API_KEY が設定されていません")
                prompt = build_prompt(caf, today, to_example(prev) if prev else None)
                raw = call_gemini(pdf, prompt, api_key, model)
            entry = transform(raw, caf)
            errors = validate(entry, prev)
            if errors:
                raise UpdateError("検証エラー:\n" + "\n".join(f"  - {e}" for e in errors))
            entry["sourceHash"] = digest
            if entry != prev:
                week["cafeterias"][cid] = entry
                changed = True
            count = sum(len(v) for v in entry["daily"].values())
            report.append(f"- {caf['name']}: 更新（{entry['weekStart']} の週、日替り {count} 品）")
        except (UpdateError, urllib.error.URLError, OSError, KeyError, ValueError) as e:
            failed = True
            report.append(f"- {caf['name']}: **失敗** {e}")

    if changed and not args.dry_run:
        week["updatedAt"] = today.isoformat()
        save_json(WEEK_PATH, week)

    text = "\n".join(report)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"## メニュー更新（モデル: {model}）\n{text}\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
