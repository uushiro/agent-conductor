#!/bin/bash
# Agent Conductor デモ録画スクリプト（ウィンドウ指定版）
# 使い方: ./scripts/record-demo.sh
# 停止: Ctrl+C

OUTPUT_MP4="/tmp/ac-demo-raw.mp4"
OUTPUT_GIF="$(cd "$(dirname "$0")/.." && pwd)/demo.gif"

# avfoundation のデバイス一覧を表示してスクリーン番号を確認
echo "📺 利用可能なスクリーン:"
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -E "AVFoundation|Capture"

echo ""
echo "📐 録画するウィンドウ領域を指定してください"
echo "   ヒント: アプリウィンドウにカーソルを合わせて左上座標を確認"
echo "   (スクリーンショット → プレビューで座標確認も可)"
echo ""
read -p "左上X座標 (default: 0): " X
read -p "左上Y座標 (default: 0): " Y
read -p "幅 (default: 1200): " W
read -p "高さ (default: 800): " H

X=${X:-0}
Y=${Y:-0}
W=${W:-1200}
H=${H:-800}

echo ""
echo "🎬 録画開始: x=${X} y=${Y} w=${W} h=${H}"
echo "   操作が終わったら Ctrl+C で停止してください"
echo ""

# Retina対応: 座標は論理ピクセル、avfoundationは物理ピクセルなので2倍
ffmpeg -y \
  -f avfoundation \
  -framerate 30 \
  -capture_cursor 1 \
  -i "1" \
  -vf "crop=$((W*2)):$((H*2)):$((X*2)):$((Y*2)),scale=${W}:${H}" \
  "$OUTPUT_MP4" 2>/dev/null

echo ""
echo "🔄 GIF変換中..."

ffmpeg -y -i "$OUTPUT_MP4" \
  -vf "fps=20,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" \
  /tmp/ac-demo-palette.png 2>/dev/null

ffmpeg -y -i "$OUTPUT_MP4" -i /tmp/ac-demo-palette.png \
  -lavfi "fps=20,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer" \
  "$OUTPUT_GIF" 2>/dev/null

echo "✅ 完成: $OUTPUT_GIF"
ls -lh "$OUTPUT_GIF"
