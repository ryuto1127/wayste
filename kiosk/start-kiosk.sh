#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Wayste Kiosk — Raspberry Pi 起動スクリプト
#
# 使い方:
#   1. このファイルを Raspberry Pi にコピー
#   2. chmod +x start-kiosk.sh
#   3. KIOSK_URL を実際のデプロイURLに書き換え
#   4. 自動起動: /etc/xdg/autostart/kiosk.desktop に登録
# ──────────────────────────────────────────────────────────────

# ── 設定 ──
KIOSK_URL="${KIOSK_URL:-https://wayste-kiosk.vercel.app/}"
LOG_FILE="/tmp/kiosk.log"

echo "[$(date)] Starting Wayste Kiosk..." > "$LOG_FILE"
echo "[$(date)] URL: $KIOSK_URL" >> "$LOG_FILE"

export DISPLAY=:0

# ── ディスプレイのスリープ・スクリーンセーバーを無効化 ──
xset s off 2>/dev/null
xset -dpms 2>/dev/null
xset s noaccel 2>/dev/null

# ── マウスカーソルを非表示（タッチスクリーン向け） ──
# unclutter がインストールされている場合のみ
if command -v unclutter &>/dev/null; then
  unclutter -idle 0.5 -root &
fi

# ── 前回のクラッシュ復帰フラグをクリア ──
CHROMIUM_DIR="$HOME/.config/chromium"
if [ -d "$CHROMIUM_DIR" ]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' \
    "$CHROMIUM_DIR/Default/Preferences" 2>/dev/null
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' \
    "$CHROMIUM_DIR/Default/Preferences" 2>/dev/null
fi

# ── Chromium をキオスクモードで起動 ──
chromium-browser \
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
  --enable-features=WebSpeechAPI \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --password-store=basic \
  --disable-gpu-sandbox \
  "$KIOSK_URL" \
  >> "$LOG_FILE" 2>&1
