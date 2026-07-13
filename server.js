// Express + Socket.IO サーバー。静的フロントの配信とリアルタイム対戦の両方を担う。
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import { createRoom, getRoom, cleanupRooms, roomCount } from './src/rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: roomCount() }));

// 合い言葉ロック：環境変数 ACCESS_CODE が設定されている場合のみ有効。
// 未設定（ローカル開発など）なら誰でも入れる。
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
function gateOk(socket) {
  return !ACCESS_CODE || socket.data.authed === true;
}

// socket.id -> { code, playerId }
const sessions = new Map();

function broadcastRoom(room) {
  for (const p of room.players) {
    if (p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('room:state', room.view(p.id));
    }
  }
}

function sanitizeName(name) {
  return String(name || '').trim().slice(0, 16) || 'プレイヤー';
}

io.on('connection', (socket) => {
  // 合い言葉ロックが必要かどうかを返す
  socket.on('auth:status', (cb) => {
    cb?.({ required: !!ACCESS_CODE, authed: gateOk(socket) });
  });

  // 合い言葉の照合
  socket.on('auth:check', (code, cb) => {
    if (!ACCESS_CODE) { socket.data.authed = true; return cb?.({ ok: true, required: false }); }
    if (String(code || '').trim() === ACCESS_CODE) {
      socket.data.authed = true;
      cb?.({ ok: true, required: true });
    } else {
      cb?.({ ok: false, required: true, error: '合い言葉が違います' });
    }
  });

  // 部屋を作成
  socket.on('room:create', ({ playerId, name, config }, cb) => {
    if (!gateOk(socket)) return cb?.({ ok: false, error: '合い言葉の認証が必要です' });
    const room = createRoom(config || {});
    const res = room.addPlayer(playerId, sanitizeName(name));
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    room.setConnected(playerId, true, socket.id);
    room.ensureHost();
    sessions.set(socket.id, { code: room.code, playerId });
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, playerId });
    broadcastRoom(room);
  });

  // 部屋に参加
  socket.on('room:join', ({ playerId, name, code }, cb) => {
    if (!gateOk(socket)) return cb?.({ ok: false, error: '合い言葉の認証が必要です' });
    const room = getRoom(code);
    if (!room) return cb?.({ ok: false, error: '部屋が見つかりません。コードを確認してください' });
    const res = room.addPlayer(playerId, sanitizeName(name));
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    room.setConnected(playerId, true, socket.id);
    room.ensureHost();
    sessions.set(socket.id, { code: room.code, playerId });
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, playerId });
    broadcastRoom(room);
  });

  // 既存セッションの復帰（リロード時など）
  socket.on('room:resume', ({ playerId, code }, cb) => {
    if (!gateOk(socket)) return cb?.({ ok: false, error: '合い言葉の認証が必要です' });
    const room = getRoom(code);
    if (!room || !room.getPlayer(playerId)) {
      return cb?.({ ok: false, error: 'セッションが見つかりません' });
    }
    room.setConnected(playerId, true, socket.id);
    room.ensureHost();
    sessions.set(socket.id, { code: room.code, playerId });
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, playerId });
    broadcastRoom(room);
  });

  function withRoom(cb, fn) {
    const sess = sessions.get(socket.id);
    if (!sess) return cb?.({ ok: false, error: 'セッションが切れています。再読み込みしてください' });
    const room = getRoom(sess.code);
    if (!room) return cb?.({ ok: false, error: '部屋が存在しません' });
    return fn(room, sess.playerId);
  }

  socket.on('room:config', ({ config }, cb) => withRoom(cb, (room, pid) => {
    if (room.hostId !== pid) return cb?.({ ok: false, error: 'ホストのみ変更できます' });
    const res = room.updateConfig(config || {});
    cb?.(res);
    broadcastRoom(room);
  }));

  socket.on('game:start', (_data, cb) => withRoom(cb, (room, pid) => {
    if (room.hostId !== pid) return cb?.({ ok: false, error: 'ホストのみ開始できます' });
    const res = room.startHand();
    cb?.(res);
    broadcastRoom(room);
  }));

  socket.on('game:next', (_data, cb) => withRoom(cb, (room, pid) => {
    if (room.hostId !== pid) return cb?.({ ok: false, error: 'ホストのみ進行できます' });
    const res = room.startHand();
    cb?.(res);
    broadcastRoom(room);
  }));

  socket.on('game:action', ({ action, amount }, cb) => withRoom(cb, (room, pid) => {
    const res = room.applyAction(pid, action, amount);
    cb?.(res);
    broadcastRoom(room);
  }));

  socket.on('stats:reset', (_data, cb) => withRoom(cb, (room, pid) => {
    if (room.hostId !== pid) return cb?.({ ok: false, error: 'ホストのみリセットできます' });
    room.resetStats();
    cb?.({ ok: true });
    broadcastRoom(room);
  }));

  socket.on('player:rebuy', ({ playerId, amount }, cb) => withRoom(cb, (room, pid) => {
    if (room.hostId !== pid) return cb?.({ ok: false, error: 'ホストのみチップ追加できます' });
    const res = room.rebuy(playerId, amount);
    cb?.(res);
    broadcastRoom(room);
  }));

  socket.on('player:sitout', ({ sitOut }, cb) => withRoom(cb, (room, pid) => {
    const p = room.getPlayer(pid);
    if (p) p.sittingOut = !!sitOut;
    cb?.({ ok: true });
    broadcastRoom(room);
  }));

  socket.on('disconnect', () => {
    const sess = sessions.get(socket.id);
    sessions.delete(socket.id);
    if (!sess) return;
    const room = getRoom(sess.code);
    if (!room) return;
    room.setConnected(sess.playerId, false, null);
    room.ensureHost();
    broadcastRoom(room);
  });
});

setInterval(cleanupRooms, 1000 * 60 * 5);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`♠ Friends Hold'em サーバー起動: http://localhost:${PORT}`);
});
