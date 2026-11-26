"""scripts/update_menu.py の変換と検証のテスト（Gemini は呼ばない）。

実行: python3 -m unittest discover -s tests
"""
import copy
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import update_menu as um  # noqa: E402

BASE = json.loads((ROOT / "data" / "cafeterias.json").read_text(encoding="utf-8"))
WEEK = json.loads((ROOT / "data" / "week.json").read_text(encoding="utf-8"))
CAFS = {c["id"]: c for c in BASE["cafeterias"]}


def current(cid):
    e = copy.deepcopy(WEEK["cafeterias"][cid])
    e.pop("sourceHash", None)
    return e


class RoundTrip(unittest.TestCase):
    def test_week_json_survives_round_trip(self):
        # 今の week.json を Gemini 形式に戻して変換し直すと、元に戻ること
        for cid, caf in CAFS.items():
            with self.subTest(cid=cid):
                self.assertEqual(um.transform(um.to_example(current(cid)), caf), current(cid))

    def test_current_data_passes_validation(self):
        for cid in CAFS:
            with self.subTest(cid=cid):
                self.assertEqual(um.validate(current(cid), current(cid)), [])


class Rules(unittest.TestCase):
    def raw(self, items, date="2026-11-30", **day):
        return {"days": [{"date": date, "closed": False, "items": items, **day}]}

    def test_tsudanuma_rules(self):
        raw = self.raw([
            {"name": "お弁当 唐揚", "price": 350, "category": "お弁当", "slot": "lunch"},
            {"name": "今日のパスタ（ﾅﾎﾟﾘﾀﾝ）", "price": 300, "category": "パスタ", "slot": "lunch"},
            {"name": "ﾁｷﾝｶﾂ&ｺﾛｯｹ", "price": 350, "category": "定食・丼", "slot": "lunch"},
            {"name": "日替りサラダ（ツナ）", "price": 150, "category": "サラダ", "slot": "lunch"},
        ])
        items = um.transform(raw, CAFS["tsudanuma"])["daily"]["2026-11-30"]
        self.assertEqual([m["name"] for m in items], ["今日のパスタ（ナポリタン）", "チキンカツ＆コロッケ", "日替りサラダ（ツナ）"])
        self.assertEqual(items[0]["corner"], "軽食コーナー")
        self.assertFalse(items[2]["main"])

    def test_topping_and_regular_are_split_out(self):
        raw = self.raw([
            {"name": "グルメカレー（メンチカツ）", "price": 350, "category": "カレー", "slot": "lunch"},
            {"name": "カレー", "price": 250, "category": "カレー", "slot": "lunch"},
            {"name": "ライス", "price": 100, "category": "小鉢・単品", "slot": "lunch"},
            {"name": "唐揚丼", "price": 350, "category": "定食・丼", "slot": "lunch"},
        ])
        e = um.transform(raw, CAFS["shinnara1f"])
        self.assertEqual(e["toppings"], {"グルメカレー": {"2026-11-30": "メンチカツ"}})
        self.assertEqual([m["name"] for m in e["daily"]["2026-11-30"]], ["唐揚丼"])

    def test_weekend_dropped_and_week_start_is_monday(self):
        raw = {"days": [
            {"date": "2026-12-02", "closed": False, "items": [{"name": "親子丼", "price": 350, "category": "丼", "slot": "lunch"}]},
            {"date": "2026-12-05", "closed": False, "items": [{"name": "唐揚", "price": 350, "category": "定食・丼", "slot": "lunch"}]},
        ]}
        e = um.transform(raw, CAFS["shinnara2f"])
        self.assertEqual(e["weekStart"], "2026-11-30")
        self.assertEqual(list(e["daily"]), ["2026-12-02"])


class Validation(unittest.TestCase):
    def test_detects_problems(self):
        prev = current("tsudanuma")
        bad = copy.deepcopy(prev)
        del bad["daily"]["2026-11-24"]
        bad["daily"]["2026-11-25"][0]["price"] = 4000
        bad["daily"]["2026-11-26"].append(dict(bad["daily"]["2026-11-26"][1]))
        errors = "\n".join(um.validate(bad, prev))
        self.assertIn("2026-11-24 のメニューがない", errors)
        self.assertIn("4000 円がおかしい", errors)
        self.assertIn("重複", errors)

    def test_detects_sudden_drop_and_old_week(self):
        prev = current("tsudanuma")
        thin = copy.deepcopy(prev)
        for iso in thin["daily"]:
            thin["daily"][iso] = thin["daily"][iso][:2]
        self.assertTrue(any("急減" in e for e in um.validate(thin, prev)))
        newer = dict(prev, weekStart="2026-11-30")
        self.assertTrue(any("古い" in e for e in um.validate(prev, newer)))

    def test_closed_day_is_allowed(self):
        e = current("shinnara2f")  # 11/23 は休業
        self.assertIn("2026-11-23", e["closed"])
        self.assertEqual(um.validate(e, None), [])


if __name__ == "__main__":
    unittest.main()
