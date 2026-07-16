// エンジン検証（node test/engine.test.js で実行）。外部依存なしの簡易アサート。
import { evaluateBest, compareScores } from '../src/poker/handEvaluator.js';
import { Game } from '../src/poker/game.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); }
}
function C(str) {
  // "As","10h","Kd" 等をパース
  const suit = str.slice(-1);
  const r = str.slice(0, -1);
  const map = { A: 14, K: 13, Q: 12, J: 11 };
  const rank = map[r] || Number(r);
  return { rank, suit };
}
function hand(...codes) { return codes.map(C); }

console.log('=== 役判定 ===');
// カテゴリ判定
assert(evaluateBest(hand('As','Ks','Qs','Js','10s','2d','3c')).score[0] === 8, 'ロイヤル→SF(8)');
assert(evaluateBest(hand('9s','8s','7s','6s','5s','2d','Ac')).score[0] === 8, 'ストレートフラッシュ');
assert(evaluateBest(hand('As','Ah','Ad','Ac','Ks','2d','3c')).score[0] === 7, 'フォーカード');
assert(evaluateBest(hand('As','Ah','Ad','Ks','Kh','2d','3c')).score[0] === 6, 'フルハウス');
assert(evaluateBest(hand('As','Ks','9s','5s','2s','2d','3c')).score[0] === 5, 'フラッシュ');
assert(evaluateBest(hand('9h','8s','7d','6c','5s','2d','Ac')).score[0] === 4, 'ストレート');
assert(evaluateBest(hand('Ah','2s','3d','4c','5s','9d','Kc')).score[0] === 4, 'ホイール(A-5)ストレート');
assert(evaluateBest(hand('Ah','2s','3d','4c','5s','9d','Kc')).score[1] === 5, 'ホイールの最高札は5');
assert(evaluateBest(hand('As','Ah','Ad','Ks','9h','2d','3c')).score[0] === 3, 'スリーカード');
assert(evaluateBest(hand('As','Ah','Ks','Kh','9d','2d','3c')).score[0] === 2, 'ツーペア');
assert(evaluateBest(hand('As','Ah','Ks','9h','7d','2d','3c')).score[0] === 1, 'ワンペア');
assert(evaluateBest(hand('As','Kh','9s','7h','5d','3d','2c')).score[0] === 0, 'ハイカード');

// 強弱比較
const sf = evaluateBest(hand('9s','8s','7s','6s','5s','2d','Ac')).score;
const quad = evaluateBest(hand('As','Ah','Ad','Ac','Ks','2d','3c')).score;
assert(compareScores(sf, quad) > 0, 'SF > フォーカード');

// フラッシュ同士のキッカー
const flushA = evaluateBest(hand('As','Ks','9s','5s','2s','2d','3c')).score;
const flushK = evaluateBest(hand('Ks','Qs','9s','5s','2s','2d','3c')).score;
assert(compareScores(flushA, flushK) > 0, 'Aハイフラッシュ > Kハイフラッシュ');

// ツーペアのキッカー
const tpHighKicker = evaluateBest(hand('As','Ah','Ks','Kh','Qd','2d','3c')).score;
const tpLowKicker = evaluateBest(hand('As','Ah','Ks','Kh','9d','2d','3c')).score;
assert(compareScores(tpHighKicker, tpLowKicker) > 0, 'ツーペアはキッカーで決まる');

// フルハウス vs フラッシュ
const fh = evaluateBest(hand('As','Ah','Ad','Ks','Kh','2d','3c')).score;
const fl = evaluateBest(hand('As','Ks','9s','5s','2s','2d','3c')).score;
assert(compareScores(fh, fl) > 0, 'フルハウス > フラッシュ');

console.log('=== ゲーム進行 ===');
// 保存参照でチップを更新する簡易プレイヤー
function makePlayers(n, chips = 1000) {
  return Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, chips }));
}

// チップ保存則：ハンド終了後、全員のチップ合計は不変
function chipConservationTest(n) {
  const players = makePlayers(n);
  const before = players.reduce((s, p) => s + p.chips, 0);
  const g = new Game(players, 0, { sb: 10, bb: 20 });
  let guard = 0;
  while (!g.isComplete() && guard < 500) {
    guard++;
    const seat = g.currentSeat();
    if (!seat) break;
    const legal = g.legalActions();
    // ランダムに行動（fold/call/check/raise）
    const r = Math.random();
    let action, amount;
    if (legal.toCall === 0) {
      if (r < 0.6 || !legal.actions.includes('raise') && !legal.actions.includes('bet')) action = 'check';
      else { action = legal.actions.includes('bet') ? 'bet' : 'raise'; amount = Math.min(legal.minRaiseTo, legal.maxRaiseTo); }
    } else {
      if (r < 0.2) action = 'fold';
      else if (r < 0.85) action = 'call';
      else if (legal.actions.includes('raise')) { action = 'raise'; amount = Math.min(legal.minRaiseTo, legal.maxRaiseTo); }
      else action = 'call';
    }
    const res = g.applyAction(seat.id, action, amount);
    if (!res.ok) { console.error('  action rejected:', action, amount, res.error); break; }
  }
  const after = players.reduce((s, p) => s + p.chips, 0);
  assert(g.isComplete(), `${n}人ゲームが正常終了 (guard=${guard})`);
  assert(before === after, `${n}人 チップ保存 (${before} → ${after})`);
  assert(players.every((p) => p.chips >= 0), `${n}人 チップが負にならない`);
}

for (let n = 2; n <= 6; n++) {
  for (let trial = 0; trial < 200; trial++) chipConservationTest(n);
}

console.log('=== §6-2 ショートオールインで再レイズ権が復活しない ===');
{
  const players = [
    { id: 'A', name: 'A', chips: 10000 },
    { id: 'B', name: 'B', chips: 10000 },
    { id: 'C', name: 'C', chips: 400 }, // BB100を払うと残300 → 合計400までしかオールインできない
  ];
  const g = new Game(players, 0, { sb: 50, bb: 100 });
  assert(g.currentSeat().id === 'A', 'Aが最初の手番（プリフロップ）');
  assert(g.applyAction('A', 'raise', 300).ok, 'Aが300へフルレイズ');       // inc200 >= 100
  assert(g.currentSeat().id === 'B', '次はB');
  assert(g.applyAction('B', 'call').ok, 'Bがコール');
  assert(g.currentSeat().id === 'C', '次はC');
  assert(g.applyAction('C', 'allin').ok, 'Cがオールイン(400へ=ショート)');  // inc100 < 200
  assert(g.currentSeat().id === 'A', 'Aに手番が戻る');
  const aLegal = g.legalActions();
  assert(!aLegal.actions.includes('raise'), 'A: 再レイズ不可（ショートオールインでは権利が復活しない）');
  assert(!aLegal.actions.includes('bet'), 'A: ベットも不可');
  assert(aLegal.actions.includes('call'), 'A: コールは可能');
  assert(!g.applyAction('A', 'raise', 800).ok, 'A: レイズ試行は拒否される');
  assert(g.applyAction('A', 'call').ok, 'A: コールは通る');
}

console.log('=== フルサイズのオールインは再レイズ権を復活させる ===');
{
  const players = [
    { id: 'A', name: 'A', chips: 10000 },
    { id: 'B', name: 'B', chips: 10000 },
    { id: 'C', name: 'C', chips: 600 }, // BB100払って残500 → 600まで（inc300>=200=フル）
  ];
  const g = new Game(players, 0, { sb: 50, bb: 100 });
  assert(g.applyAction('A', 'raise', 300).ok, 'Aが300へレイズ');
  assert(g.applyAction('B', 'call').ok, 'Bがコール');
  assert(g.applyAction('C', 'allin').ok, 'Cがオールイン(600へ=フル)');       // inc300 >= 200
  assert(g.currentSeat().id === 'A', 'Aに手番');
  assert(g.legalActions().actions.includes('raise'), 'A: フルオールインには再レイズできる');
}

console.log('=== オールイン時の勝率が計算される ===');
{
  const players = [{ id: 'A', name: 'A', chips: 1000 }, { id: 'B', name: 'B', chips: 1000 }];
  const g = new Game(players, 0, { sb: 10, bb: 20 });
  assert(g.currentSeat().id === 'A', 'HU: Aが先に行動');
  assert(g.applyAction('A', 'allin').ok, 'A オールイン');
  assert(g.applyAction('B', 'allin').ok, 'B オールイン（コール）');
  assert(g.isComplete(), 'ハンド終了');
  assert(g.result.allinEquity && g.result.allinEquity.eq, 'オールイン勝率が計算されている');
  const eq = g.result.allinEquity.eq;
  const sum = (eq.A || 0) + (eq.B || 0);
  assert(sum >= 98 && sum <= 102, `勝率合計が約100 (${sum})`);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
