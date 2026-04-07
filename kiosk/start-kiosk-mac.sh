#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Wayste Kiosk — macOS 起動スクリプト (M1/M2 Mac 向け)
#
# 使い方:
#   1. chmod +x start-kiosk-mac.sh
#   2. KIOSK_URL を実際のデプロイURLに書き換え（または環境変数で指定）
#   3. ターミナルで ./start-kiosk-mac.sh を実行
#   4. 停止するには Ctrl+C
#
# 自動起動にするには setup-mac.sh を先に実行してください。
# ──────────────────────────────────────────────────────────────

set -e

# ── 設定 ──
KIOSK_URL="${KIOSK_URL:-https://wayste-kiosk.vercel.app/}"
LOG_FILE="/tmp/wayste-kiosk.log"
CHROME_APP="/Applications/Google Chrome.app"

echo "[$(date)] Starting Wayste Kiosk..." | tee "$LOG_FILE"
echo "[$(date)] URL: $KIOSK_URL" | tee -a "$LOG_FILE"

# ── Chrome がインストールされているか確認 ──
if [ ! -d "$CHROME_APP" ]; then
  echo "[ERROR] Google Chrome が見つかりません: $CHROME_APP" | tee -a "$LOG_FILE"
  echo "  brew install --cask google-chrome  でインストールしてください。" | tee -a "$LOG_FILE"
  exit 1
fi

# ── スリープ・画面暗転を防止（このスクリプト実行中のみ有効） ──
# -d: ディスプレイスリープ防止, -i: アイドルスリープ防止, -s: システムスリープ防止
caffeinate -dis &
CAFFEINATE_PID=$!
echo "[$(date)] caffeinate started (PID: $CAFFEINATE_PID)" >> "$LOG_FILE"

# ── クリーンアップ（Ctrl+C や終了時に caffeinate を停止） ──
cleanup() {
  echo "[$(date)] Shutting down kiosk..." | tee -a "$LOG_FILE"
  kill "$CAFFEINATE_PID" 2>/dev/null
  exit 0
}
trap cleanup EXIT INT TERM

# ── Chrome のクラッシュ復帰フラグをクリア ──
CHROME_PREFS="$HOME/Library/Application Support/Google/Chrome/Default/Preferences"
if [ -f "$CHROME_PREFS" ]; then
  sed -i '' 's/"exited_cleanly":false/"exited_cleanly":true/' "$CHROME_PREFS" 2>/dev/null
  sed -i '' 's/"exit_type":"Crashed"/"exit_type":"Normal"/' "$CHROME_PREFS" 2>/dev/null
fi

# ── Chrome をキオスクモードで起動（クラッシュ時は自動再起動） ──
while true; do
  echo "[$(date)] Launching Chrome in kiosk mode..." >> "$LOG_FILE"

  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-translate \
    --disable-features=TranslateUI \
    --disable-component-update \
    --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream \
    --enable-features=WebSpeechAPI,WebGPU \
    --enable-unsafe-webgpu \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --password-store=basic \
    --disable-background-timer-throttling \
    --disable-renderer-backgrounding \
    "$KIOSK_URL" \
    >> "$LOG_FILE" 2>&1

  EXIT_CODE=$?
  echo "[$(date)] Chrome exited with code $EXIT_CODE. Restarting in 3s..." >> "$LOG_FILE"
  sleep 3
done
