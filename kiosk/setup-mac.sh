#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Wayste Kiosk — macOS 初期セットアップ (M1/M2 Mac 向け)
#
# 実行: bash kiosk/setup-mac.sh
#
# このスクリプトは以下を行います:
#   1. スクリーンセーバー・自動ロックの無効化
#   2. macOS 自動アップデートの一時停止
#   3. 起動スクリプトに実行権限を付与
#   4. ログイン時自動起動の LaunchAgent を登録
#
# 元に戻すには: bash kiosk/setup-mac.sh --restore
# ──────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.wayste.kiosk"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

# ── 復元モード ──
if [ "$1" = "--restore" ]; then
  echo "=== Wayste Kiosk: macOS 設定の復元 ==="

  echo "[1/3] スクリーンセーバー・ロックを元に戻します..."
  defaults delete com.apple.screensaver idleTime 2>/dev/null || true
  defaults delete com.apple.screensaver askForPassword 2>/dev/null || true

  echo "[2/3] 自動アップデートを再有効化..."
  sudo defaults delete /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload 2>/dev/null || true

  echo "[3/3] LaunchAgent を削除..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"

  echo ""
  echo "=== 復元完了 ==="
  echo "設定を完全に反映するにはログアウト→ログインしてください。"
  exit 0
fi

echo "=== Wayste Kiosk: macOS Setup ==="
echo ""

# ── 1. スクリーンセーバー・自動ロックの無効化 ──
echo "[1/4] スクリーンセーバーと自動ロックを無効化..."
# スクリーンセーバー起動までの時間を0（=無効）に
defaults write com.apple.screensaver idleTime -int 0
# パスワード要求を無効化
defaults write com.apple.screensaver askForPassword -int 0

echo "  注意: ディスプレイの自動スリープは start-kiosk-mac.sh の caffeinate で防止されます。"
echo "  システム設定 → ロック画面 → 「スクリーンセーバの開始後またはディスプレイがオフになったあとにパスワードを要求」をオフにしてください。"
echo ""

# ── 2. macOS 自動アップデートの一時停止 ──
echo "[2/4] 自動アップデートの自動ダウンロードを一時停止..."
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false
echo "  実証実験後に setup-mac.sh --restore で元に戻してください。"
echo ""

# ── 3. 起動スクリプトに実行権限を付与 ──
echo "[3/4] スクリプトに実行権限を付与..."
chmod +x "$SCRIPT_DIR/start-kiosk-mac.sh"
echo ""

# ── 4. ログイン時自動起動の LaunchAgent を登録 ──
echo "[4/4] LaunchAgent を登録 (ログイン時に自動起動)..."
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT_DIR}/start-kiosk-mac.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/tmp/wayste-kiosk.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/wayste-kiosk.log</string>
</dict>
</plist>
PLIST

launchctl load "$PLIST_PATH" 2>/dev/null || true

echo ""
echo "=== Setup Complete ==="
echo ""
echo "次のステップ:"
echo "  1. Google Chrome をインストール (まだの場合): brew install --cask google-chrome"
echo "  2. Chrome を一度手動で開き、カメラ権限を許可してください"
echo "     → ${KIOSK_URL:-https://wayste-kiosk.vercel.app/} にアクセス"
echo "     → カメラ許可のダイアログで「許可」をクリック"
echo "  3. テスト起動: ./kiosk/start-kiosk-mac.sh"
echo "     (Ctrl+C で停止)"
echo "  4. 本番: Mac を再起動するとログイン後に自動でキオスクモードが起動します"
echo ""
echo "キオスクの停止:"
echo "  Cmd+Q で Chrome を終了（3秒後に自動再起動します）"
echo "  完全停止: Ctrl+C でターミナルのスクリプトを停止"
echo ""
echo "設定の復元:"
echo "  bash kiosk/setup-mac.sh --restore"
echo ""
echo "ログの確認:"
echo "  cat /tmp/wayste-kiosk.log"
