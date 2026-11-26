# 学食ガチャ

千葉工大の学食メニュー（日替り＋常設）から、予算内でランダムに組み合わせを提案する非公式Webアプリ。

## 構成
- `index.html` / `style.css` / `app.js` — 静的サイト（ビルド不要）
- `data/menu.json` — 週間メニュー（出典: https://www.cit-s.com/dining/ の各食堂PDF）

## ローカルで動かす
`fetch` でJSONを読むため、ファイルを直接開くのではなくサーバー経由で開く。

```bash
python3 -m http.server 8123
```

## menu.json の形
- `weekStart`: 週の月曜（月〜土の6日分を表示）
- 食堂ごとに `daily[日付]`（日替り）と `regular`（常設）
- `slot`: `morning` / `lunch` / `dinner`。`dinnerCats` に入れたカテゴリは昼の品も夕方の候補に含める
- `closed`（終日休業）、`closedSlots`（時間帯だけ休み）、`notes`（その日の注意書き）

- `dailyTopping`: 常設メニューの日替りトッピング（例: 新習志野1Fのグルメカレー）
- `corner`: 注意書きを出すコーナー名（例: 津田沼の軽食コーナー。昼のみ）

## ルール
- 対象は平日（月〜金）のみ。土日は扱わない
- ガチャは買えるものが無くなるまで予算を埋める
- 津田沼の「お弁当」（4号館で販売）は対象外
- 「＜工大400＞」は400円
