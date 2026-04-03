#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Recycling Buddy — 実証実験データ一括バックアップ
#
# Vercel 上のログ（Redis）と画像（Blob）をローカルにダウンロードします。
# ファインチューニング用のデータセット収集に使います。
#
# 使い方:
#   1. .env.local から認証情報を読み込むか、環境変数を手動で設定
#   2. bash kiosk/backup-data.sh
#
# 必要な環境変数:
#   ADMIN_API_KEY       — admin API認証キー
#   KIOSK_URL           — デプロイURL（デフォルト: https://recycling-buddy-kiosk.vercel.app）
#
# 出力先: ./backup/<日付>/
#   ├── pilot-log.jsonl        — 全分類ログ
#   ├── feedback.jsonl         — ユーザーフィードバック
#   ├── finetune-dataset.jsonl — レビュー済みファインチューニングデータ
#   └── images/                — 画像ファイル（imageUrlがあるもの全て）
# ──────────────────────────────────────────────────────────────

set -e

# ── 設定 ──
KIOSK_URL="${KIOSK_URL:-https://recycling-buddy-kiosk.vercel.app}"
DATE=$(date +%Y-%m-%d)
BACKUP_DIR="./backup/${DATE}"
IMAGES_DIR="${BACKUP_DIR}/images"

# ── 認証キーの取得 ──
if [ -z "$ADMIN_API_KEY" ]; then
  # .env.local から読み込みを試行
  if [ -f ".env.local" ]; then
    ADMIN_API_KEY=$(grep '^ADMIN_API_KEY=' .env.local | cut -d'=' -f2-)
  fi
fi

if [ -z "$ADMIN_API_KEY" ]; then
  echo "[ERROR] ADMIN_API_KEY が設定されていません。"
  echo "  export ADMIN_API_KEY=<your-key>"
  echo "  または .env.local に ADMIN_API_KEY=... を追加してください。"
  exit 1
fi

AUTH_HEADER="x-api-key: ${ADMIN_API_KEY}"

echo "=== Recycling Buddy Data Backup ==="
echo "URL:    ${KIOSK_URL}"
echo "出力先: ${BACKUP_DIR}"
echo ""

mkdir -p "$IMAGES_DIR"

# ── 1. 分類ログ (pilot-log) のダウンロード ──
echo "[1/4] 分類ログをダウンロード中..."
HTTP_CODE=$(curl -s -o "${BACKUP_DIR}/pilot-log.jsonl" -w "%{http_code}" \
  -H "${AUTH_HEADER}" \
  "${KIOSK_URL}/api/pilot-log")

if [ "$HTTP_CODE" = "200" ]; then
  # JSONの配列をJSONLに変換
  if command -v python3 &>/dev/null; then
    python3 -c "
import json, sys
with open('${BACKUP_DIR}/pilot-log.jsonl', 'r') as f:
    data = json.load(f)
if isinstance(data, list):
    with open('${BACKUP_DIR}/pilot-log.jsonl', 'w') as f:
        for entry in data:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    print(f'  {len(data)} entries saved')
else:
    print('  (unexpected format, saved as-is)')
" 2>/dev/null || echo "  (saved raw JSON)"
  else
    echo "  (saved raw JSON — python3がないためJSONL変換をスキップ)"
  fi
else
  echo "  [WARN] HTTP ${HTTP_CODE} — ログの取得に失敗"
fi

# ── 2. フィードバックデータのダウンロード ──
echo "[2/4] フィードバックデータをダウンロード中..."
HTTP_CODE=$(curl -s -o "${BACKUP_DIR}/feedback.jsonl" -w "%{http_code}" \
  -H "${AUTH_HEADER}" \
  "${KIOSK_URL}/api/feedback-stats")

if [ "$HTTP_CODE" = "200" ]; then
  echo "  saved"
else
  echo "  [WARN] HTTP ${HTTP_CODE} — フィードバックの取得に失敗"
fi

# ── 3. ファインチューニングデータセットのダウンロード ──
echo "[3/4] ファインチューニングデータセットをダウンロード中..."
HTTP_CODE=$(curl -s -o "${BACKUP_DIR}/finetune-dataset.jsonl" -w "%{http_code}" \
  -H "${AUTH_HEADER}" \
  "${KIOSK_URL}/api/review/export?format=finetune")

if [ "$HTTP_CODE" = "200" ]; then
  LINES=$(wc -l < "${BACKUP_DIR}/finetune-dataset.jsonl" | tr -d ' ')
  echo "  ${LINES} entries saved"
elif [ "$HTTP_CODE" = "404" ]; then
  echo "  (レビュー済みエントリなし — /review でレビューしてから再実行)"
  rm -f "${BACKUP_DIR}/finetune-dataset.jsonl"
else
  echo "  [WARN] HTTP ${HTTP_CODE} — データセットの取得に失敗"
fi

# ── 4. 画像の一括ダウンロード ──
echo "[4/4] 画像をダウンロード中..."

if [ ! -f "${BACKUP_DIR}/pilot-log.jsonl" ]; then
  echo "  [SKIP] pilot-log.jsonl がないため画像ダウンロードをスキップ"
else
  # JSONL からimageUrlを抽出してダウンロード
  IMAGE_COUNT=0
  SKIP_COUNT=0
  FAIL_COUNT=0

  if command -v python3 &>/dev/null; then
    # Python で URL を抽出（より堅牢）
    python3 -c "
import json
urls = []
with open('${BACKUP_DIR}/pilot-log.jsonl', 'r') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            url = entry.get('imageUrl')
            if url:
                urls.append(url)
        except:
            pass
for url in urls:
    print(url)
" 2>/dev/null | while IFS= read -r url; do
      # ファイル名をURLの末尾から生成
      FILENAME=$(echo "$url" | sed 's|.*/||' | sed 's|?.*||')
      if [ -z "$FILENAME" ]; then
        FILENAME="image-$(date +%s%N).jpg"
      fi

      DEST="${IMAGES_DIR}/${FILENAME}"
      if [ -f "$DEST" ]; then
        SKIP_COUNT=$((SKIP_COUNT + 1))
        continue
      fi

      HTTP_CODE=$(curl -s -o "$DEST" -w "%{http_code}" "$url")
      if [ "$HTTP_CODE" = "200" ]; then
        IMAGE_COUNT=$((IMAGE_COUNT + 1))
      else
        rm -f "$DEST"
        FAIL_COUNT=$((FAIL_COUNT + 1))
      fi
    done
    echo "  完了"
  else
    # grep でURLを抽出（フォールバック）
    grep -o '"imageUrl":"[^"]*"' "${BACKUP_DIR}/pilot-log.jsonl" \
      | sed 's/"imageUrl":"//;s/"$//' \
      | while IFS= read -r url; do
          FILENAME=$(echo "$url" | sed 's|.*/||' | sed 's|?.*||')
          DEST="${IMAGES_DIR}/${FILENAME}"
          [ -f "$DEST" ] && continue
          curl -s -o "$DEST" "$url" 2>/dev/null
        done
    echo "  完了"
  fi

  TOTAL_IMAGES=$(find "$IMAGES_DIR" -name "*.jpg" 2>/dev/null | wc -l | tr -d ' ')
  echo "  画像ファイル数: ${TOTAL_IMAGES}"
fi

# ── 完了 ──
echo ""
echo "=== Backup Complete ==="
echo ""
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
echo "出力先: ${BACKUP_DIR} (${TOTAL_SIZE})"
echo ""
echo "ファイル一覧:"
ls -la "$BACKUP_DIR"/ 2>/dev/null
echo ""
echo "画像:"
find "$IMAGES_DIR" -name "*.jpg" 2>/dev/null | wc -l | tr -d ' '
echo " files in ${IMAGES_DIR}/"
echo ""
echo "このデータをファインチューニングに使用するには:"
echo "  1. finetune-dataset.jsonl のimageUrlをローカルパスに差し替え"
echo "  2. Roboflow にアップロードしてアノテーション"
echo "  3. Google Colab で YOLO26n をファインチューニング"
