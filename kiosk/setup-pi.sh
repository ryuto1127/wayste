#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Raspberry Pi 5 初期セットアップスクリプト
#
# 前提: Raspberry Pi OS (64-bit, Desktop) がインストール済み
# 実行: curl -sL <this-url> | bash  または  bash setup-pi.sh
# ──────────────────────────────────────────────────────────────

set -e

echo "=== Recycling Buddy Kiosk: Raspberry Pi Setup ==="

# ── 1. システム更新 ──
echo "[1/5] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# ── 2. 必要パッケージのインストール ──
echo "[2/5] Installing required packages..."
sudo apt-get install -y \
  chromium-browser \
  unclutter \
  xdotool \
  fonts-noto-cjk \
  fonts-noto-cjk-extra

# ── 3. キオスク起動スクリプトの配置 ──
echo "[3/5] Installing kiosk startup script..."
cp start-kiosk.sh /home/pi/start-kiosk.sh
chmod +x /home/pi/start-kiosk.sh

# ── 4. 自動起動の設定 ──
echo "[4/5] Configuring autostart..."
mkdir -p /etc/xdg/autostart
sudo cp kiosk.desktop /etc/xdg/autostart/kiosk.desktop

# ── 5. カメラの有効化 ──
echo "[5/5] Enabling camera..."
# Raspberry Pi 5 では libcamera がデフォルトで有効
# USB カメラの場合は追加設定不要
# CSI カメラの場合は /boot/firmware/config.txt に以下を追加:
#   camera_auto_detect=1
#   dtoverlay=imx219  (Camera Module 3の場合)

echo ""
echo "=== Setup Complete ==="
echo ""
echo "次のステップ:"
echo "  1. /home/pi/start-kiosk.sh の KIOSK_URL を実際のURLに変更"
echo "  2. sudo reboot で再起動"
echo "  3. 自動的にキオスクモードで起動します"
echo ""
echo "カメラの確認:"
echo "  libcamera-hello --timeout 5000"
echo ""
echo "ログの確認:"
echo "  cat /tmp/kiosk.log"
