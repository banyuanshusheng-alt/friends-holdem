// トーナメント（ブラインド上昇・脱落・決着）の検証。node test/tournament.test.js
import { Room } from '../src/room.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.error('  ✗ ' + m)); };

console.log('=== ブラインド上昇スケジュール ===');
{
  const room = new Room('T', { levelSeconds: 60, sb: 10, bb: 20 });
  ok(room.currentBlinds().sb === 10 && room.currentBlinds().bb === 20, 'Lv0 = 10/20');
  room.level = 2; ok(room.currentBlinds().sb === 20 && room.currentBlinds().bb === 40, 'Lv2 = 20/40 (2x)');
  room.level = 6; ok(room.currentBlinds().sb === 100 && room.currentBlinds().bb === 200, 'Lv6 = 100/200 (10x)');
  const fixed = new Room('F', { levelSeconds: 0, sb: 10, bb: 20 });
  fixed.level = 6; ok(fixed.currentBlinds().sb === 10, '固定モードは上がらない');
}

console.log('=== 脱落・決着（3人）===');
{
  const room = new Room('T', { levelSeconds: 60, startingChips: 1000 });
  ['a', 'b', 'c'].forEach((id) => room.addPlayer(id, id));
  ok(room.startHand().ok, '開始OK');
  ok([...room.tourneyFieldIds].sort().join() === 'a,b,c', 'フィールド確定(3人)');
  // c が飛ぶ
  room.game = { seats: [{ id: 'a', startChips: 1000 }, { id: 'b', startChips: 1000 }, { id: 'c', startChips: 1000 }] };
  room.getPlayer('c').chips = 0; room.getPlayer('a').chips = 1500; room.getPlayer('b').chips = 1500;
  room._processEliminations();
  ok(room.tourneyPlaces['c'] === 3, 'c=3位');
  ok(room.state !== 'finished', 'まだ継続');
  // b が飛ぶ → a 優勝
  room.game = { seats: [{ id: 'a', startChips: 1500 }, { id: 'b', startChips: 1500 }] };
  room.getPlayer('b').chips = 0; room.getPlayer('a').chips = 3000;
  room._processEliminations();
  ok(room.tourneyPlaces['b'] === 2, 'b=2位');
  ok(room.tourneyPlaces['a'] === 1, 'a=優勝(1位)');
  ok(room.state === 'finished', '決着した');
  ok(room.finalRanking[0].id === 'a' && room.finalRanking[0].place === 1, 'ランキング1位=a');
  ok(room.finalRanking[2].id === 'c', 'ランキング3位=c');
}

console.log('=== 同時脱落の順位（開始スタック少ない方が下位）===');
{
  const room = new Room('T2', { levelSeconds: 60, startingChips: 1000 });
  ['a', 'b', 'c', 'd'].forEach((id) => room.addPlayer(id, id));
  room.startHand();
  room.game = { seats: [{ id: 'a', startChips: 1000 }, { id: 'b', startChips: 1000 }, { id: 'c', startChips: 500 }, { id: 'd', startChips: 300 }] };
  room.getPlayer('c').chips = 0; room.getPlayer('d').chips = 0; room.getPlayer('a').chips = 1200; room.getPlayer('b').chips = 600;
  room._processEliminations();
  ok(room.tourneyPlaces['d'] === 4, 'd=4位(開始最少)');
  ok(room.tourneyPlaces['c'] === 3, 'c=3位');
  ok(room.state !== 'finished', '2人残りで継続');
}

console.log('=== 新トーナメントでリセット ===');
{
  const room = new Room('T3', { levelSeconds: 60, startingChips: 1000 });
  ['a', 'b'].forEach((id) => room.addPlayer(id, id));
  room.startHand();
  room.game = { seats: [{ id: 'a', startChips: 1000 }, { id: 'b', startChips: 1000 }] };
  room.getPlayer('b').chips = 0; room.getPlayer('a').chips = 2000;
  room._processEliminations();
  ok(room.state === 'finished', '決着');
  room.newTournament();
  ok(room.state === 'lobby', 'ロビーに戻る');
  ok(room.getPlayer('a').chips === 1000 && room.getPlayer('b').chips === 1000, 'チップがリセット');
  ok(room.level === 0 && room.levelEndsAt === 0, 'レベルがリセット');
  ok(room.finalRanking === null && room.tourneyFieldIds === null, 'トーナメント状態クリア');
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
