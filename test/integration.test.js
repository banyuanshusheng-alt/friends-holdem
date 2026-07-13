// サーバー統合テスト：複数クライアントを接続し、実際のハンドを最後まで進める。
// 事前に別プロセスでサーバーを起動しておくこと（PORT で指定）。
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.error('  ✗ ' + m)); };

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { forceNew: true, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}
function emit(s, ev, data) {
  return new Promise((resolve) => s.emit(ev, data, resolve));
}
// 指定プレイヤーの最新 state を待つ
function nextState(s, pred) {
  return new Promise((resolve) => {
    const h = (st) => { if (!pred || pred(st)) { s.off('room:state', h); resolve(st); } };
    s.on('room:state', h);
  });
}

async function main() {
  const NUM = 3;
  const clients = [];
  const pids = [];
  const latest = []; // 各クライアントの最新 state

  for (let i = 0; i < NUM; i++) {
    const s = await connect();
    const pid = 'test_pid_' + i + '_' + Math.random().toString(36).slice(2, 6);
    pids.push(pid);
    s.on('room:state', (st) => { latest[i] = st; });
    clients.push(s);
  }

  // ホストが部屋を作成
  const created = await emit(clients[0], 'room:create', { playerId: pids[0], name: 'ホスト', config: { startingChips: 1000, sb: 10, bb: 20 } });
  ok(created.ok && created.code, '部屋作成');
  const code = created.code;

  // 他の2人が参加
  for (let i = 1; i < NUM; i++) {
    const r = await emit(clients[i], 'room:join', { playerId: pids[i], name: '客' + i, code });
    ok(r.ok, `プレイヤー${i} 参加`);
  }
  await sleep(100);
  ok(latest[0].players.length === NUM, `全員が同じ部屋に (${latest[0]?.players.length}人)`);

  // 開始
  const started = await emit(clients[0], 'game:start', {});
  ok(started.ok, 'ゲーム開始');
  await sleep(100);
  ok(latest[0].game && latest[0].game.street === 'preflop', 'プリフロップ開始');

  // 各クライアントは自分のホールカードのみ見える
  for (let i = 0; i < NUM; i++) {
    const g = latest[i].game;
    const me = g.seats.find((s) => s.id === pids[i]);
    const others = g.seats.filter((s) => s.id !== pids[i]);
    ok(me.hole && me.hole.length === 2, `P${i}: 自分の手札2枚が見える`);
    ok(others.every((o) => o.hole === null), `P${i}: 他人の手札は隠れている`);
  }

  // ハンドを最後まで自動進行（全員 call/check、たまに fold しない）
  let guard = 0;
  while (guard < 200) {
    guard++;
    // 現在の手番を持つクライアントを探す
    const toAct = latest[0].game && latest[0].game.toActId;
    if (!toAct || latest[0].state === 'handover') break;
    const idx = pids.indexOf(toAct);
    if (idx === -1) break;
    const g = latest[idx].game;
    const legal = g.legal;
    let action;
    if (!legal || !legal.actions) break;
    if (legal.actions.includes('check')) action = 'check';
    else if (legal.actions.includes('call')) action = 'call';
    else action = 'fold';
    const r = await emit(clients[idx], 'game:action', { action });
    ok(r.ok, `P${idx} ${action}`);
    await sleep(30);
  }
  ok(latest[0].state === 'handover', `ハンドが完了して handover へ (guard=${guard})`);
  ok(latest[0].game.result, '結果が生成された');

  // チップ保存則
  const total = latest[0].players.reduce((s, p) => s + p.chips, 0);
  ok(total === NUM * 1000, `チップ保存 (${total} = ${NUM * 1000})`);

  // ショーダウンで残った手札が全員に公開される
  const result = latest[0].game.result;
  if (result.showdown) {
    for (let i = 0; i < NUM; i++) {
      const g = latest[i].game;
      const revealedSeats = g.seats.filter((s) => {
        const rp = result.players.find((p) => p.id === s.id);
        return rp && rp.revealed;
      });
      ok(revealedSeats.every((s) => s.hole && s.hole.length === 2), `P${i}: ショーダウンの手札が公開`);
    }
  }

  // 履歴スナップショットが記録された
  ok(latest[0].history.length >= 2, `推移履歴が記録された (${latest[0].history.length})`);

  // 次のハンド → ボタンが移動
  const dealerBefore = latest[0].game.dealerId;
  const next = await emit(clients[0], 'game:next', {});
  ok(next.ok, '次のハンド開始');
  await sleep(100);
  ok(latest[0].game.dealerId !== dealerBefore || NUM === 1, 'ディーラーボタンが移動');

  // 成績リセット
  await emit(clients[0], 'game:action', { action: 'fold' }).catch(() => {});
  const reset = await emit(clients[0], 'stats:reset', {});
  ok(reset.ok, '成績リセット');
  await sleep(80);
  ok(latest[0].standings.every((p) => p.net === 0), 'リセット後は全員の損益が0');

  // 非ホストは開始できない
  const denied = await emit(clients[1], 'game:start', {});
  ok(!denied.ok, '非ホストの開始は拒否される');

  console.log(`\n統合テスト結果: ${pass} pass / ${fail} fail`);
  for (const c of clients) c.close();
  process.exit(fail === 0 ? 0 : 1);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
