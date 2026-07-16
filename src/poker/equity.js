// オールイン時の勝率（エクイティ）計算。
// 残りコミュニティカードを全列挙 or モンテカルロで回して各プレイヤーの勝率%を出す。
import { freshDeck } from './deck.js';
import { evaluateBest, compareScores } from './handEvaluator.js';

const keyOf = (c) => `${c.rank}${c.suit}`;

function binom(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

// arr から k 枚の全組合せを cb に渡す
function eachCombo(arr, k, cb) {
  const idx = [];
  const rec = (start, depth) => {
    if (depth === k) { cb(idx.map((i) => arr[i])); return; }
    for (let i = start; i <= arr.length - (k - depth); i++) { idx[depth] = i; rec(i + 1, depth + 1); }
  };
  rec(0, 0);
}

function sample(arr, k) {
  const a = arr.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

// players: [{ id, hole: [card, card] }]（フォールドしていない全員）
// community: 場のカード（0/3/4枚）
// 返り値: { id: 勝率%(整数) }
export function computeEquity(players, community) {
  if (!players || players.length < 2) return {};
  const used = new Set();
  players.forEach((p) => p.hole.forEach((c) => used.add(keyOf(c))));
  community.forEach((c) => used.add(keyOf(c)));
  const remaining = freshDeck().filter((c) => !used.has(keyOf(c)));
  const need = 5 - community.length;

  const wins = {};
  players.forEach((p) => { wins[p.id] = 0; });
  let total = 0;

  const tally = (board) => {
    let best = null; let winners = [];
    for (const p of players) {
      const sc = evaluateBest([...p.hole, ...board]).score;
      if (best === null || compareScores(sc, best) > 0) { best = sc; winners = [p.id]; }
      else if (compareScores(sc, best) === 0) winners.push(p.id);
    }
    const share = 1 / winners.length;
    winners.forEach((id) => { wins[id] += share; });
    total += 1;
  };

  if (need === 0) {
    tally(community);
  } else if (binom(remaining.length, need) <= 200000) {
    eachCombo(remaining, need, (extra) => tally([...community, ...extra]));
  } else {
    const SAMPLES = 8000; // プリフロップ全オールイン等はモンテカルロ
    for (let i = 0; i < SAMPLES; i++) tally([...community, ...sample(remaining, need)]);
  }

  const eq = {};
  players.forEach((p) => { eq[p.id] = total ? Math.round((wins[p.id] / total) * 100) : 0; });
  return eq;
}
