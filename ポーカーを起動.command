#!/bin/bash
# ダブルクリックで起動 → 共有リンクが表示されます。
# 遊ぶときに起動し、終わったらこのウィンドウを閉じてください。

cd "$(dirname "$0")"

# ================== 設定 ==================
#   合い言葉：身内で共有する言葉。好きに変えてOK（半角英数がおすすめ）
ACCESS_CODE="poker-night"
PORT=3000
# ==========================================

clear
echo "♠ 仲間内ホールデム を起動しています..."
echo ""

# 初回のみ：必要な部品を準備
if [ ! -d node_modules ]; then
  echo "（初回のみ）準備中… 1〜2分かかります。そのままお待ちください。"
  npm install >/tmp/holdem-npm.log 2>&1
fi

# 初回のみ：共有ツール(cloudflared)を用意
if [ ! -f cloudflared ]; then
  echo "（初回のみ）共有ツールを取得中…"
  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ]; then CF="cloudflared-darwin-arm64.tgz"; else CF="cloudflared-darwin-amd64.tgz"; fi
  curl -sL --max-time 120 -o cloudflared.tgz "https://github.com/cloudflare/cloudflared/releases/latest/download/$CF"
  tar xzf cloudflared.tgz 2>/dev/null && rm -f cloudflared.tgz && chmod +x cloudflared
fi

# 前回残っていたら掃除
pkill -f "node server.js" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

# 遊んでいる間、Macが勝手にスリープしてトンネルが落ちるのを防ぐ
caffeinate -i -w $$ &

# サーバー起動
PORT=$PORT ACCESS_CODE="$ACCESS_CODE" node server.js >/tmp/holdem-server.log 2>&1 &
SERVER_PID=$!
sleep 2

echo "共有リンクを準備中…（10秒ほど）"

# トンネル起動 → 公開URLを取得
./cloudflared tunnel --url "http://localhost:$PORT" >/tmp/holdem-tunnel.log 2>&1 &
TUNNEL_PID=$!

URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/holdem-tunnel.log | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

# 終了時にサーバーとトンネルを停止
trap 'kill $SERVER_PID $TUNNEL_PID 2>/dev/null; echo ""; echo "終了しました。"; ' EXIT

# リンクが取れたら、まず自分のブラウザで自動的に開く（＝あなたの待機画面）
if [ -n "$URL" ]; then
  sleep 3   # Cloudflare側にリンクが行き渡るのを少し待つ
  open "$URL"
fi

clear
echo "=================================================================="
echo ""
echo "   ♠ 準備完了！"
echo ""
echo "   あなたのブラウザが自動で開きます（これがあなたの待機画面）。"
echo "   合い言葉を入れて → 名前を入れて → 「部屋を作成」して待ってください。"
echo ""
echo "   ↓ この2つを身内のチャットに送ってください ↓"
echo ""
echo "   リンク  :  ${URL:-取得失敗。このウィンドウを閉じて、もう一度ダブルクリックしてください}"
echo "   合い言葉:  $ACCESS_CODE"
echo ""
echo "=================================================================="
echo "   ★重要★"
echo "   ・友達に送る前に、まず自分でリンクが開けるか確認してください"
echo "   ・このウィンドウは【絶対に閉じない】でください（閉じると全員エラー）"
echo "   ・リンクは毎回変わります。今出ているリンクを送ってください"
echo "   ・遊び終わったら、このウィンドウを閉じればOK"
echo "=================================================================="
echo ""
echo "（このウィンドウは開いたままにしてください。動作中…）"

# トンネルが動いている間は待機
wait $TUNNEL_PID
