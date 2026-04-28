<p align="center">
  <a href="README.md">English</a>
  &nbsp;·&nbsp;
  <strong>日本語</strong>
</p>

# wayste

<p align="center">
  <img src="public/marketing/hook-1.png" alt="wayste キオスク使用イメージ — 紙コップを持った手がラベル付きのゴミ箱の上にかざされている" width="720">
</p>

<p align="center">
  <a href="https://wayste.vercel.app/"><strong>デモを見る →</strong></a>
  &nbsp;·&nbsp;
  <a href="https://wayste.vercel.app/kiosk"><strong>キオスクを試す →</strong></a>
</p>

リアルタイムでゴミの分別を教えてくれるAIキオスク。ゴミ箱に近づいて品物を手に持っていると、上から見下ろす固定カメラが数秒で「これはどのゴミ箱？」を画面に出してくれます。アプリも、スマホも、ボタン操作も要りません。

オフィスや公共空間での実証実験向けに作りました。**判定はブラウザの中で行う**ので、画像は端末の外に出ず、プライバシーが守られます。1回ごとにかかる費用もゼロ。ローカルが見たことのない珍しい品物だけ、念のためクラウドに問い合わせます。英語と日本語に完全対応、サイトごとにゴミの種類を設定でき、画像認識のバイアス対策も入っています。

> **ステータス:** いまVercelでデモを動かしています。日本国内の複数のオフィスと空港の運営会社1社と、実証実験の話を進めているところ。本番運用はまだ始まっていません。

## なぜ作ったか

日本のオフィスや空港のゴミ箱は、4〜6種類に分かれていて（燃えるゴミ、プラスチック、ペットボトル、缶、紙、特別ゴミなど）、ラベルも文字が多い。人は2秒くらい見て諦めて、結局すべて燃えるゴミに入れてしまう。普通のアプリでは解決できません — ゴミを片手に持ったままQRコードを読み取りたい人なんていない。だから設計の制約は **ユーザーの手間ゼロ・インストール不要・その場で答えが出る** だけに絞りました。その結果、「固定カメラはゴミと手しか映さない（顔は決して映らない）、AIモデルはブラウザの中で動く（画像は端末から外に出ない）」という形に落ち着きました。

## エンジニアリングの見どころ

- **2段階のローカル優先パイプライン** — 自作した15クラス版のYOLO26mモデルが ONNX Runtime Web 経由でブラウザの中で動きます。確信度が高い判定はサーバーを呼ばずにその場で結果を出し、ローカルが知らない珍しい品物だけGPT-5.4 miniに任せる。よくある品物（ペットボトル、缶、紙コップ）はクラウドに到達しません。
- **画像認識の公平さ** — 肌の検出はRGB値ではなく、HSV色空間で判定（`h ≤ 50, 0.1 ≤ s ≤ 0.8, v ≥ 0.2`）しています。RGBの肌色判定は明るい肌色に偏り、現場で機能しないことが知られているからです。
- **感度の数値ひとつで全閾値が決まる** — 検出に関わる閾値（前景の比率、動き量、確信度のカットオフ）はすべて、サイト設定の `sensitivity`（0〜1）という1つのつまみから計算されます。コードのあちこちにマジックナンバーが散らばらないようにしています。
- **HMAC署名のキオスクセッション** — `KIOSK_API_TOKEN` を鍵にした、長く使える署名付きクッキーです。トークンを入れ替えるだけで、配置済みの全デバイスのセッションを一括で無効にできます。新しい端末は `/kiosk/unlock` でトークンを使ってアンロック。
- **環境への自動調整** — 起動して最初の45フレームで、その場所のノイズの基準値を測り、前景の判定基準を上書きします。同じキオスクが、強い蛍光灯の下でも、温色のオフィス照明でも、設定を直さずに動きます。
- **熱で性能が落ちたときの対策** — 画像処理にかかる時間をずっと監視していて、M1/M2 Macが熱で遅くなり始めたら、自動でフレームレートを半分に落とし、画面に警告バッジを出します。

---

## 何ができるのか

- カメラにかざされた物体を、ブラウザの画像認識で検出（クラウド不要）
- **2段階の判定パイプライン** — まずローカルYOLO、必要なときだけクラウドGPT：
  - **1段階目 — YOLO26m（必要なときだけブラウザで実行）:** 自作の15クラス版ゴミ検出モデル（`15class_v1.onnx`、39 MB）。ボトル、缶、コップ、袋、電池、生ゴミなど、よく出てくる品物をカバー。CVパイプラインが「分類するべき」と判断したときに動き、確信度が高ければサーバーを呼ばずにその場で結果を返します。
  - **2段階目 — OpenAI `gpt-5.4-mini`:** YOLOの確信度が、感度から計算したフォールバック閾値（デフォルト感度0.5で約0.725）を下回ったとき、または前景に何か映っているのにYOLOが見つけられなかったときに、こちらが動きます。
- **RGB材質解析** がYOLOのクラス名を、bounding boxの色（HSV）、透明度、金属っぽさ、形（縦横比）、LBPテクスチャから細かく分けます — 「bottle」を「ガラス瓶」「ペットボトル」「アルミ缶」のどれか正しい方に振り分けてからルールマッチングへ。
- 材質のヒント（色合い、彩度、透明度、表面の質感）は2段階目のGPTにも渡され、クラウド側の判定の精度も上がります。
- 確信度に応じて **はっきりした指示** を表示（生のパーセンテージはユーザーには見せません）：
  - 確信度が高い → **「リサイクルへ」**
  - 中ぐらい → **「これは燃えるゴミに見えます」** + 「念のためゴミ箱のラベルも見てね」と柔らかい注意
  - 低い → 推測した答え + **「迷ったら燃えるゴミへ」** という保険
- 必要なときは **捨てる前にやることの指示** を出します（例：「中身を空にしてキャップを外してください」）
- **英語・日本語** の両方に対応。サイトごとに最初の言語を設定できます。
- **複合品** を検出します（例：プラスチックの蓋つき紙コップ）。バラバラの構成要素ごとに分別の指示を分けて出します。
- **同時に最大4品** までカメラに映ったものを検出（鮮明さ・コントラスト・肌の比率で品質スコアをつける）。レスポンシブな分割画面（2列、3列、2×2グリッド）でフェードイン表示します。
- **起動時のローディング画面** — YOLOモデルの読み込みとウォームアップが終わるまで、キオスクは入力を受け付けません。準備が完了するまで、ロゴ付きのプログレス表示が出ます。
- キオスク端末側の **熱対策** — 画像処理が普段の2倍以上に遅くなったとき、応答性を保つために自動でフレームレートを半分に落とします。
- すべてのスキャンをRedisに記録し、実証実験のあとで分析できます。
- 撮影した画像は **Vercel Blob** に保存。URLにはランダムな文字列がついていて、外から推測できないようになっており、管理者ログインのページからしか見られません。
- 1日1回のcron jobで、パイロットデータをBlobへアーカイブし、古い画像を自動で消します。

---

## 使い方

1. カメラ付きの端末で `/kiosk` を開きます（最初の1回だけ `/kiosk/unlock` でアンロック。30日間有効なクッキーが入ります）
2. 品物（複数でもOK）をカメラの前にかざします
3. 結果を待ちます — よくある品物ならその場ですぐ（YOLO26m）。GPT-5.4 miniが必要な場合は1〜3秒くらい
4. 表示されたゴミ箱に捨てます — 物理的なゴミ箱の並びの中で、どの位置のものなのか、画面のインジケーターで案内されます
5. そのまま立ち去るか、**Done** をタップして待機画面に戻ります

---

## ページ構成

| URL | 役割 |
|-----|---------|
| `/` | 公開のマーケティングランディングページ（10セクション、デモ動画つき） |
| `/kiosk` | キオスク本体 — 有効な `kiosk_session` クッキーが必要 |
| `/kiosk/unlock` | 新しい端末をアンロックする画面 — 30日間有効な `kiosk_session` クッキーを発行 |
| `/insights` | 運用ダッシュボード — パイプラインの流れ、誤判定トップ、日ごとの推移（管理者のみ） |
| `/review` | 人によるレビュー — すべての判定結果と撮影画像を一覧で見て、Correct/Wrong/Nothing（誤検出）でマーク。フラグつき画像のZIPダウンロードもできる（管理者のみ） |

---

## 技術スタック

| レイヤー | 使っているもの |
|-------|-----------|
| フレームワーク | Next.js 16.2.4（App Router、TypeScript） |
| スタイル | Tailwind CSS v4 |
| ローカル推論（1段階目） | YOLO26m FP16 — 自作15クラス版ゴミ分別モデル（`15class_v1.onnx`、39 MB）を ONNX Runtime Web で実行 |
| AI判定（2段階目） | OpenAI `gpt-5.4-mini` |
| 材質の解析 | RGB色解析 + LBPテクスチャ解析を YOLO bounding box の上で実行 — クラス名を細かく分け、GPTにヒントを渡す |
| ローカル検出 | OffscreenCanvas で背景差分を120×120の正方形・約33fpsで処理。マルチblob解析（最大4個）、自動キャリブレーション |
| レスポンスの検証 | モデルの出力すべてに Zod スキーマでチェック |
| API のセキュリティ | HMAC署名のセッショントークン + 2段階認証（キオスク用トークン / 管理者キー） |
| データベース | Upstash Redis（パイロットログ + 管理者レビュー結果） |
| 画像ストレージ | Vercel Blob（撮影フレーム、日次のJSONLアーカイブ） |
| ホスティング | Vercel |

---

## ローカル開発

### 必要なもの

- Node.js 18+
- OpenAIアカウント（APIクレジット必須）
- Webカメラ

### インストールと起動

```bash
git clone https://github.com/ryuto1127/wayste.git
cd wayste
npm install
```

`.env.local` を作る：

```env
OPENAI_API_KEY=sk-...
```

```bash
npm run dev
```

- [http://localhost:3000](http://localhost:3000) → 公開のマーケティングランディングページ
- [http://localhost:3000/kiosk](http://localhost:3000/kiosk) → キオスク本体（カメラのアクセスを許可）

開発時は `KIOSK_API_TOKEN` が未設定だとセッションのチェックがバイパスされるので、`/kiosk` を直接開けます。

> **カメラの反転について:** デフォルトでは映像を **反転していません** — 外向きの固定キオスクカメラで使うと、これで正しく見えます（パッケージの文字がそのまま読める）。ノートPCの内蔵カメラ（自撮り用）でテストするときは、`.env.local` に `NEXT_PUBLIC_MIRROR_CAMERA=true` を追加すると映像が反転します。

---

## デプロイ

### 1. GitHubにpushしてVercelにデプロイ

```bash
vercel --prod
```

または、GitHubリポジトリをVercelに接続して、`git push` ごとに自動デプロイ。

### 2. ストレージを足す

```bash
# Redis — パイロットログとユーザーフィードバックを保存
vercel integration add upstash
```

Blob（画像ストレージ）は **Vercelダッシュボード → Storage → Create Database → Blob** から追加。

### 3. 環境変数をローカルに同期

```bash
vercel env pull
```

### 環境変数

| 変数 | 必須 | 説明 |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI APIキー |
| `KV_REST_API_URL` | 本番 | Upstash Redis REST URL |
| `KV_REST_API_TOKEN` | 本番 | Upstash Redis トークン |
| `BLOB_READ_WRITE_TOKEN` | 本番 | Vercel Blob トークン |
| `SITE_ID` | No | 読み込むサイト設定（デフォルト: `japan-office`）。サイト設定の `defaultLocale` がUIの言語を決める |
| `BLOB_ENABLED` | No | `false` で画像アップロードを完全に止める（デフォルトは有効） |
| `NEXT_PUBLIC_MIRROR_CAMERA` | No | 自撮りカメラ用なら `true`、外向きキオスクカメラなら未設定または `false` |
| `RATE_LIMIT_MAX` | No | 1分あたりのIPごとの最大判定リクエスト数（デフォルト `15`） |
| `OPENAI_DAILY_BUDGET` | No | UTC日単位のOpenAI判定呼び出しの上限。推奨は実験時 `500`、本番 `5000`。未設定で上限なし |
| `KIOSK_API_TOKEN` | 本番 | **サーバー専用** のトークン。キオスク用エンドポイント（`/api/classify`、`/api/pilot-log` POST）で必須。localhost開発時は省略すれば認証スキップ。`NEXT_PUBLIC_*` で公開してはいけない。新しい端末は `/kiosk/unlock` でアンロック |
| `BLOB_STORE_HOST` | 本番 | Vercel Blobストアのホスト名（例: `abc123.public.blob.vercel-storage.com`）。Blobトークンが攻撃者の管理するストアに送られるのを防ぐ |
| `ADMIN_API_KEY` | No | 管理者ページ（`/insights`、`/review`）のパスワード。HTTP Basic Auth → 4時間のセッションクッキー。dev時は省略可。入れ替えるとすべてのセッションが無効になる |
| `CRON_SECRET` | No | `/api/cron/cleanup` 用のVercel Cron認証シークレット |
| `BLOB_RETENTION_DAYS` | No | cron jobで撮影画像を消すまでの日数（デフォルト `90`） |
| `NEXT_PUBLIC_INFERENCE_BACKEND` | No | `onnx`（デフォルト、ブラウザのONNX Runtime）または `http`（ローカル推論サーバー） |
| `NEXT_PUBLIC_INFERENCE_URL` | No | `NEXT_PUBLIC_INFERENCE_BACKEND=http` のときに使うサーバーURL（デフォルト `http://localhost:8000/detect`） |

---

## 判定の流れ

```
ユーザーがカメラの前に品物をかざす
        ↓
ブラウザの画像認識パイプラインが物体を検出
（背景差分、ROI blob検出 — すべて端末の中で完結）
        ↓
動きと鮮明さのチェックを通った高品質フレームを5枚集める
        ↓
── 1段階目: YOLO26m FP16（必要なときだけブラウザで実行）─────────────────
パイプラインが「判定するべき」と判断したらYOLO26m（自作15クラスゴミ分別モデル）が動く。
15クラスはすべてゴミの品物（ボトル、缶、コップ、袋、電池、生ゴミなど）で、
どれを検出しても分別ストリームに直接対応している。
        ↓
一番良かった検出のbounding boxにRGB材質解析を実行：
  · 色（HSV）、透明度、金属っぽさ、bbox の縦横比
  · LBPテクスチャ解析 → 紙 / プラスチック / 金属の表面の推定
  · refineClassName で一般的なYOLOラベルを細かく分ける
    （例: "bottle" → "ガラス瓶"、"ペットボトル"、"アルミ缶"）
        ↓
YOLO26m の確信度 ≥ YOLO_FALLBACK_THRESHOLD（デフォルト感度0.5で約0.725）の場合
        → 結果をすぐに返す（その場で完了、サーバー呼び出しなし）
        → YOLO単独のログを /api/pilot-log に送る（ブロックしない）
        ↓
── 2段階目: OpenAI gpt-5.4-mini ──────────────────────────────────────────
YOLOの確信度がフォールバック閾値より下、または前景に何か映っているのに
YOLOが対応する検出を見つけられなかったときに動き出す。
  · 中央の正方形クロップ（例: 1280×720から720×720）を /api/classify に送る
  · 材質ヒント（色、透明度、テクスチャ）が使えるときは一緒に送る —
    GPTのプロンプトに「ローカル解析: transparent=true, metallic=false, ...」を追加
  · gpt-5.4-mini が品物 + 任意の preAction 指示を判定
  · Zod がモデルのJSON出力を検証。未知のストリームIDは needs_review に倒す
  · 複合品（複数の構成からなる物体）は検出して、要素ごとの分別指示に分解
        ↓
── 共通の処理 ────────────────────────────────────────────────────────────
オーバーライドルールを適用（単語の区切りで判定するパターンマッチ、より具体的なものから順に試す）
        ↓
信頼レベルを決める：
  ≥70%   → high    → 「[BIN] へ」
  40〜70% → medium  → 「これは [BIN] に見えます」 + ゴミ箱のラベル確認の注意
  <40% / review   → low     → 推測の答え + 「迷ったら [default] へ」
        ↓
必要なら捨てる前のアクションを表示（例: 「中身を空にしてキャップを外してください」）
        ↓
1品ならフルスクリーンで大きく、2〜4品なら分割グリッドで結果を表示。
各blobは中心の位置の近さでYOLOの検出と対応づける — マッチしなかったblobで、
品質スコア（鮮明さ + コントラスト）が高いものはGPTに送り、低いものは捨てる。
画像のBlobへのアップロードとRedisログは非同期で動く（レスポンスを止めない）
```

---

## 信頼性のための機能

| 機能 | 動き |
|---------|-----------|
| **エラーバウンダリー** | 描画でクラッシュしたら復旧画面を表示し、10秒後に自動でリロード |
| **APIタイムアウト** | OpenAIの呼び出しは15秒で打ち切る — キオスクが永遠にハングすることはない |
| **設定可能なレート制限** | `RATE_LIMIT_MAX` 環境変数でIPごとの上限を決める（デフォルト15/分）。429が返ったらクライアント側で1.2秒待ってから1回だけリトライ |
| **エラーの種類分け** | タイムアウトには「接続が遅い」、それ以外の失敗には「判定に失敗しました」を表示。黙ってのみ込まない |
| **設定のホットリロード** | サイト設定は5分キャッシュ — オーバーライドの変更は再起動なしで反映 |
| **保留品キュー** | 1スロットのキュー。処理中・結果表示中・クールダウン中に新しい品物を見つけたら覚えておいて、クールダウンが終わったら待機状態をスキップして次のスキャンへすぐ進む |
| **キオスクセッションクッキー** | HMAC署名された長寿命の `kiosk_session` クッキー（30日）が判定とログPOSTを認可する。`KIOSK_API_TOKEN` を入れ替えるとすべてのクッキーが無効になる |
| **モデル起動ゲート** | 起動時にYOLOモデルを読み込んでウォームアップする。`overallReady` がtrueになるまで、ローディング画面で入力をブロック |
| **熱で性能が落ちたときの対策** | 画像処理にかかる時間を継続的に追跡。平均が普段の2倍を超えたら（M1/M2 Macの熱スロットリング）、フレームレートを自動で半分に落として警告バッジを出す |

---

## セキュリティ

### セッショントークンの仕組み

新しいキオスク端末は、`POST /api/kiosk/session`（または `/kiosk/unlock` 画面）で `KIOSK_API_TOKEN` を、HMAC-SHA256で署名された `kiosk_session` クッキーに交換します。クッキーは30日有効。`KIOSK_API_TOKEN` を入れ替えると、発行済みのクッキーすべてが無効になります。すべての判定とログPOSTは、クッキーかトークンを確認してから処理を始めます。

### 2段階認証

| 段階 | 環境変数 | 仕組み | 守られているエンドポイント |
|------|---------|-----------|---------------------|
| キオスク | `KIOSK_API_TOKEN` | `kiosk_session` クッキー または `Authorization: Bearer <token>` | `/api/classify`、`/api/pilot-log`（POST） |
| 管理者 | `ADMIN_API_KEY` | HTTP Basic Auth → 4時間のセッションクッキー（middleware） | `/insights`、`/review`、`/api/review/*`、`/api/dashboard-metrics`、`/api/pilot-log`（DELETE） |

両方とも環境変数が未設定のときは認証なしで動くので、ローカル開発に追加設定は要りません。管理者認証は middleware だけで完結 — 最初のBasic Authプロンプトのあとは、4時間のセッションクッキーで毎回パスワードを入れる必要がなくなります。

### 画像のプライバシー

撮影した画像は Vercel Blob に公開アクセス可能でアップロードします（`@vercel/blob` v2 がサーバーサイドの読み取りに必要なため）。プライバシーはアプリケーション側で守ります：
- URLにランダムな文字列がついている — 推測できないし、順番に試しても見つけ出せない
- URLは管理者ログインしたページ（`/review`、`/api/pilot-image`）からしか見られない
- 画像は `BLOB_RETENTION_DAYS` を超えたら自動で消える（デフォルト90日）
- `BLOB_ENABLED=false` にすれば画像アップロードを完全に止められる

---

## 画像認識パイプライン

ローカルの画像認識パイプラインは、RGBの数値範囲ではなく **HSV色空間で肌を検出** しています。HSVのアプローチ（`h ≤ 50, 0.1 ≤ s ≤ 0.8, v ≥ 0.2`）は、肌の色全般に対して公平 — 明るい肌に偏りがちなRGBの判定の問題を避けられます。肌の比率のチェック（`MAX_SKIN_RATIO = 0.80`）が「手そのものを物体だと誤判定する」のを防ぎつつ、手に持った品物はちゃんと検出できるようにしています。

**自動キャリブレーション**: 起動して最初の45フレーム（背景の安定期間）で、ノイズの基準値（前景比率の平均、標準偏差、いちばん大きいblobのベースライン）を計測します。この数字をもとに、その場所固有の `ROI_FG_THRESHOLD` を計算し、各カメラのノイズ特性に合わせます。

**感度**: サイト設定にある単一の `sensitivity` パラメータ（0.0 = 厳しい、1.0 = 敏感、デフォルト0.5）が、`lib/threshold-config.ts` の `computeThresholds()` を通して、すべての検出と判定の閾値を制御します。自動キャリブレーションが使えるときは、前景閾値はそちらが上書きします。

タイミングはキオスクの応答性に合わせて調整：
- **結果表示**: 品物が取り除かれるまで表示し続ける（30秒のセーフティアウト）
- **クールダウン**: スキャンの間に1.5秒
- **物体が無くなったかの判定**: 連続3フレームで何も映っていないとき（感度 > 0.7なら2フレーム）

### 保留品キュー

連続スキャンが瞬時に感じられるよう、パイプラインは1スロットのキューを持っています。処理中（判定中・結果表示中・クールダウン中）に前景のblobが3フレーム連続で検出されたら、保留フラグを立てる。クールダウンが終わると待機状態を完全にスキップして直接 `object_detected` に進むので、ユーザーが品物をもう一度かざさなくても、次のスキャンがすぐ始まります。キューの深さはちょうど1 — 2つ目が来たら1つ目を上書き（last-wins）。手動で再キャリブレーションするとキューはクリアされます。

---

## 分別ルールのカスタマイズ

ルールは `config/sites/` の中のJSONファイルで管理。コードを変える必要はありません。

### サイト設定の構造

```json
{
  "siteId": "my-office",
  "siteName": "My Office — 2nd Floor",
  "defaultLocale": "en",
  "reviewThreshold": 0.55,
  "sensitivity": 0.5,
  "mirrorCamera": false,
  "streams": [
    { "id": "recycling", "label": "Recycling", "color": "#2563EB", "description": "..." },
    { "id": "compost",   "label": "Compost",   "color": "#16A34A", "description": "..." },
    { "id": "landfill",  "label": "Landfill",  "color": "#525252", "description": "..." }
  ],
  "overrides": [
    { "pattern": "coffee cup", "stream": "landfill", "note": "Lined cups are not recyclable." }
  ],
  "siteRules": [
    { "pattern": "toner", "instruction": "Leave by the copy room.", "stream": "special", "requiresStaff": true }
  ],
  "staffHandlingItems": ["fluorescent", "chemical"],
  "defaultStream": "landfill"
}
```

新しい場所のルールを作るときは、`config/sites/japan-office.json`（デフォルト）または `config/sites/office-hq.json` を `config/sites/your-site.json` にコピーして編集し、Vercelの環境変数に `SITE_ID=your-site` を設定。日本語が中心のサイトなら `defaultLocale` を `"ja"`、英語が中心なら `"en"` に。

### 日本語のゴミ分別ストリーム

`japan-office` の設定は、日本語にローカライズされたストリーム（`burnable`、`non-burnable`、`recyclable`、`plastic`、`special`、`needs_review`）の例になっています。オーバーライドは日本語の品名にも対応（例：`ペットボトル` → recyclable、`電池` → special）。詳しくは `config/sites/japan-office.json` を見てください。

### オーバーライドのパターンマッチ

パターンは **単語の区切りで判定** します — `"cup"` というパターンは `"paper cup"` には合致しますが、`"cupcake"` には合致しません。パターンはより具体的なものから順に試します — `"coffee cup"` は `"cup"` より自動的に優先されます。

### 信頼度の閾値

`reviewThreshold`（デフォルト `0.55`）は、結果を「不確実」として柔らかく表示するかどうかの境界です。下げるとゆるく、上げるともっと高い確信度を要求してから「これだ」と断定するようになります。

---

## 実証実験のあとの作業

実環境テストが終わったら：

1. `/insights` でパイプラインの流れ、誤判定トップ、日ごとの推移を見る
2. `/review` で **すべての判定結果** を撮影画像つきで一覧。フィルタ可能なグリッドで、エントリごとにモデル名と鮮明度スコアが見える
3. 各エントリを **Correct**、**Wrong**（モデルが言ったクラス名が画像と合っていない）、**Nothing**（誤検出）でマークする
4. フラグつき画像（Wrong + 確信度が低いCorrect）の **ZIPアーカイブ** をダウンロードして、アノテーションツールに入れる
5. インサイトをもとに `config/sites/*.json` にオーバーライドルールを追加

> **注意:** インサイトの統計は `/review` で管理者がレビューしたものだけを反映しています — キオスクの中にフィードバックボタンはありません。レビューされていないものは除外され、確認済みのデータだけで集計されます。

生のデータはすべてUpstashコンソールに：
- `recycling:pilot-log` — すべての判定結果（品物、ストリーム、確信度、使ったモデル、応答時間、画像URL）
- `recycling:review-verdicts` — 管理者のレビュー結果（correct / wrong / false_detection）。requestIdをキーに保存

### データの保持

Vercel Cron が毎日UTC 03:00（`/api/cron/cleanup`）に：
1. いまのパイロットログをJSONLファイルにしてBlobの `archives/YYYY-MM-DD/` にアーカイブ
2. `BLOB_RETENTION_DAYS` を超えた撮影画像を削除（デフォルト90日）

別に週次のcron（`/api/cron/export-finetuning`）が、パイロットログを構造化されたファインチューニング用データセットとしてBlobに書き出し、再学習にすぐ使える状態にします。

インサイトダッシュボードの日付範囲データ管理UIから、手動でパージすることもできます（中で `DELETE /api/pilot-log` を呼び出している）。

---

## プロジェクト構成

```
├── app/
│   ├── api/
│   │   ├── calibration/         # キャリブレーション予測の追跡（Redisバック）
│   │   ├── classify/            # 単発 + バッチの判定（GPT-5.4 mini、オーバーライド、Blobアップロード）
│   │   ├── cron/
│   │   │   ├── cleanup/             # 日次cron: パイロットログをBlobへアーカイブ、古い画像を削除
│   │   │   └── export-finetuning/   # 週次cron: パイロットログをファインチューニング用データセットとしてBlobへ書き出し
│   │   ├── dashboard-metrics/   # /insights 用のGET集計（ファネル + 誤判定トップ + 推移）
│   │   ├── health/              # サービスのヘルスチェック
│   │   ├── kiosk/
│   │   │   └── session/         # POST: KIOSK_API_TOKEN を kiosk_session クッキーに交換
│   │   ├── kiosk-stats/         # 当日の判定成功率（管理者レビュー済みのみ）
│   │   ├── pilot-image/         # Blobホスト撮影フレームの署名URLプロキシ
│   │   ├── pilot-log/           # パイロットログの読み書きと削除（GET/POST/DELETE）
│   │   ├── review/              # レビュー結果、エントリ削除、ZIP/CSVエクスポート
│   │   └── site-config/         # クライアント用にサイトの defaultLocale + streams を返す
│   ├── demo/screens/            # 内部用の画面状態ショーケース（ユーザーには見せない）
│   ├── insights/                # 運用ダッシュボード（ファネル、誤判定、推移）
│   ├── kiosk/                   # キオスク表示（page.tsx）+ アンロックフロー（unlock/page.tsx）+ ダーク固定ビューポートのレイアウト
│   ├── review/                  # 人間レビュー — Correct/Wrong/Nothing 判定、ZIPエクスポート
│   └── page.tsx                 # 公開のマーケティングランディングページ（10セクション構成）
├── components/
│   ├── AdminNav.tsx             # 管理者用の共通ナビ（insights ↔ review ↔ kiosk）
│   ├── CameraFeed.tsx           # カメラの初期化 + フレームキャプチャ（mirror prop対応）
│   ├── CameraScreen.tsx         # カメラビューの状態（scanning / detecting）
│   ├── ErrorBoundary.tsx        # 自動リロードつきのクラッシュ復旧
│   ├── IdleScreen.tsx           # 待機 / アトラクション画面
│   ├── KioskDisplay.tsx         # CVパイプライン + 状態機械のオーケストレーター
│   ├── PerformancePanel.tsx     # タブごとのパフォーマンスチャート（CV、YOLO、熱）— review ページ用
│   ├── ResultScreen.tsx         # フルスクリーン / 分割画面の結果表示（1〜4品、2×2グリッド）
│   ├── SystemStatusBadge.tsx    # YOLOモデル + 熱警告のステータス表示
│   └── insights/                # /insights のビュー + チャートサブコンポーネント
│       ├── InsightsView.tsx
│       ├── MetricsTimeseries.tsx
│       ├── MisclassTopChart.tsx
│       └── PipelineFunnel.tsx
├── config/
│   └── sites/                   # 場所ごとの分別ルールJSONファイル
│       ├── airport.json
│       ├── japan-office.json    # デフォルトサイト — 日本語ストリーム（burnable / non-burnable / recyclable / plastic / special）
│       ├── office-hq.json
│       └── pilot.json
├── public/
│   └── models/                  # ブラウザに配信するONNX資産
│       ├── 15class_v1.onnx          # YOLO26m FP16 — 実行時の検出モデル
│       └── yolo-rules.json          # YOLOクラス → 分別ストリームのマッピング
├── kiosk/                       # キオスクのデプロイスクリプト
│   ├── setup-mac.sh                 # macOS M1/M2 セットアップ（スクリーンセーバー、自動更新、LaunchAgent）
│   ├── start-kiosk-mac.sh           # Chromeキオスクモードの自動再起動
│   ├── setup-pi.sh                  # Raspberry Pi セットアップ
│   ├── start-kiosk.sh               # 汎用Linuxキオスクの起動
│   ├── backup-data.sh               # データバックアップスクリプト
│   └── kiosk.desktop                # Linuxデスクトップエントリ
├── training/                    # オフラインデータセット準備 + モデル学習（Python; 実行時は使わない）
│   ├── finetune_yolo26n.ipynb       # 自作データセットでのYOLO26nファインチューニング
│   ├── train_clean.py               # クリーンデータ学習エントリ
│   ├── prepare_dataset.py           # データセット準備（OIDv6 + TACO）
│   ├── prepare_pilot_data.py        # パイロットログ画像を学習データに変換
│   ├── build_*_dataset.py           # クラスセット別のデータセットビルダー（39/42/46クラス）
│   ├── ai_curate.py / ai_verify_class.py / filter_quality.py  # 品質と分類のチェック
│   └── ...                          # その他のノートブック、エクスポーター、補助スクリプト
├── __tests__/                   # Jestユニットテスト（下「テストの実行」を参照）
├── middleware.ts                # 管理者Basic Auth → 4時間のセッションクッキー
├── instrumentation.ts           # Next.js instrumentation hook（起動時の環境変数チェック）
└── lib/
    ├── audit-log.ts                 # 追記専用の管理者アクションログ
    ├── auth.ts                      # （古い / 未使用）— kiosk-auth.ts + middleware が代わり
    ├── background-task.ts           # waitUntil ラッパー（レスポンスのあとに走る処理用）
    ├── bbox-utils.ts                # IoU、フレームフィンガープリント、貪欲bboxマッチング
    ├── blob-store.ts                # Vercel Blobアップロードのヘルパー
    ├── blob-url.ts                  # Blob URLのホスト名のallow-listチェック
    ├── calibration.ts               # キャリブレーション予測の追跡（Redis）
    ├── crypto-utils.ts              # HMAC + 一定時間で動く文字列比較
    ├── daily-budget.ts              # UTC日単位のOpenAI呼び出し上限
    ├── dashboard-metrics.ts         # /insights のレスポンスを作る純粋関数
    ├── empty-module.js              # ONNX Runtime のサーバーサイドimport用スタブ
    ├── env-validation.ts            # 起動時の環境変数チェック
    ├── face-detect.ts               # ブラウザの顔検出（プライバシーフィルター）
    ├── face-detect-server.ts        # サーバーサイドの顔検出（プライバシーフィルター）
    ├── frame-analyzer.ts            # ローカルCVパイプライン（背景モデル、マルチblob検出）
    ├── i18n.ts                      # EN/JAの翻訳
    ├── inference-backend.ts         # YOLO推論バックエンドの抽象化（ONNX または HTTP）
    ├── insights-helpers.ts          # /insights 用のクライアントヘルパー
    ├── kiosk-auth.ts                # HMAC署名 `kiosk_session` クッキー + ベアラートークン検証
    ├── kiosk-counter.ts             # ストリームごとの分別カウンター（待機画面の生統計）
    ├── kiosk-stats.ts               # 当日の成功率（管理者レビュー済みのみ）
    ├── material-vocabulary.ts       # GPTサブ分類プロンプト用の材質視覚キュー
    ├── milestone-check.ts           # レビュー閾値達成時のマイルストーン通知（Resend）
    ├── models/                      # サーバーサイドで使うバンドル済みONNX資産（顔検出器）
    ├── notifications.ts             # Resendメールヘルパー
    ├── offline-cache.ts             # ブラウザlocalStorageの結果キャッシュ（50件、24h TTL）
    ├── openai-pricing.ts            # トークン使用量 → USD換算（予算追跡用）
    ├── perf-monitor.ts              # タブ内パフォーマンスモニター + BroadcastChannel同期
    ├── pilot-log.ts                 # Redisログ（recycling:pilot-log リスト）
    ├── pilot-log-schema.ts          # パイロットログエントリのZodスキーマ
    ├── redis.ts                     # Upstash Redisクライアント + キー定数
    ├── request-id.ts                # ログ相関用のリクエストごとUUID
    ├── rgb-material-analyzer.ts     # YOLOのあとのRGB/テクスチャ材質解析（色、LBP、形）
    ├── site-streams-context.tsx     # サイトストリームをクライアントコンポーネントに渡すReactコンテキスト
    ├── threshold-config.ts          # マスター感度 → 閾値の計算
    ├── types.ts                     # 共有のTypeScript型
    ├── waste-rules-core.ts          # コアルールエンジン（パターンマッチング、ストリーム解決）
    ├── waste-rules.ts               # ルールエンジンの公開API（オーバーライド、結果構築、GPTプロンプト）
    ├── yolo-inference.ts            # YOLO26m FP16 ONNX Runtime Web 推論（必要なときだけ）
    └── yolo-rules.ts                # YOLOクラス名 → 分別ストリームのマッピング（/models/yolo-rules.json を読み込む）
```

---

## テストの実行

```bash
npm test
```

18スイート、合計442のユニットテスト。状態機械、CVパイプラインの閾値、感度由来の閾値、オーバーライドのパターンマッチング、オフラインキャッシュ、通知、判定APIルート、RGB材質/テクスチャ解析、複数品blob検出、順次モデルローディング、bboxユーティリティ、ダッシュボードメトリクス + 統合、insightsヘルパー、OpenAIの価格と予算、解析エクスポートをカバー。

---

## ライセンス

MIT
