# 学食ガチャ

千葉工大の学食メニュー（日替り＋常設）から、予算内でランダムに組み合わせを提案する非公式Webアプリ。

公開URL: https://frogama55.github.io/gakushoku-gacha/

## 構成
- `index.html` / `style.css` / `app.js` — 静的サイト（ビルド不要、GitHub Pages で公開）
- `data/cafeterias.json` — 食堂の固定情報。**人が手で直す**（名前・営業時間・常設メニュー・変換ルール）
- `data/week.json` — 週ごとの日替りメニュー。**自動更新される**（食堂ごとに週を持つ）
- `scripts/update_menu.py` — PDFを取得して Gemini で読み取り、`week.json` を更新する
- `.github/workflows/update-menu.yml` — 上のスクリプトを毎日 6:00（日本時間）に実行

## ローカルで動かす
```bash
python3 -m http.server 8123
```

## メニュー自動更新
1. 毎日、3食堂のPDF（https://www.cit-s.com/dining/ のリンク先）をダウンロード
2. 前回のハッシュ値（`week.json` の `sourceHash`）と同じなら何もしない
3. 変わった食堂だけ Gemini に読ませる（過去の週を出力例として渡す）
4. `cafeterias.json` の `rules` を当てる
   - `excludeCats`: 除外するカテゴリ（津田沼のお弁当）
   - `cornerCats`: ※の注意を付けるカテゴリ（津田沼のパスタ＝軽食コーナー）
   - `toppingItems`: 常設でトッピングだけ日替りの品（新習志野1Fのグルメカレー）
   - 土日は捨てる、常設メニューと同名の品は日替りから外す
5. 検証（5日分そろっているか、価格が50〜1000円の10円単位か、重複、品数の急減、週が古くなっていないか）に通ったらコミットして公開
6. 失敗したら公開せず、「メニュー自動更新に失敗しました」という Issue を立てる（開いていればコメントを足す）

### 設定
- リポジトリの Secrets に `GEMINI_API_KEY`（Google AI Studio で発行）
- 任意: Variables に `GEMINI_MODEL`（既定は `gemini-3.8-flash`）
- 手動実行: Actions →「メニュー更新」→ Run workflow（`force` でPDFが同じでも読み直す）

### テスト
```bash
python3 -m unittest discover -s tests
```

## ルール
- 対象は平日（月〜金）のみ
- ガチャは買えるものが無くなるまで予算を埋める
- 「＜工大400＞」は400円
