// 7枚（ホール2 + コミュニティ5）から最強の5枚役を判定する。
// 返り値は比較可能なスコア配列 [category, ...tiebreakers]。
// category: 8=ストレートフラッシュ 7=フォーカード 6=フルハウス 5=フラッシュ
//           4=ストレート 3=スリーカード 2=ツーペア 1=ワンペア 0=ハイカード
// 同カテゴリ内は tiebreakers を先頭から数値比較すれば強弱が決まる。

const CATEGORY_NAME = {
  8: 'ストレートフラッシュ',
  7: 'フォーカード',
  6: 'フルハウス',
  5: 'フラッシュ',
  4: 'ストレート',
  3: 'スリーカード',
  2: 'ツーペア',
  1: 'ワンペア',
  0: 'ハイカード',
};

// 連続する5枚（ストレート）を探す。A-2-3-4-5 の A=1 も考慮。返り値はストレートの最高ランク or null。
function straightHighRank(ranksSet) {
  // ranksSet: 存在するランクの Set
  const ranks = new Set(ranksSet);
  // ホイール（A-2-3-4-5）用に A(14) を 1 としても扱う
  const hasWheel = ranks.has(14) && ranks.has(2) && ranks.has(3) && ranks.has(4) && ranks.has(5);
  // 通常の高いストレートを優先して探す
  for (let high = 14; high >= 5; high--) {
    let ok = true;
    for (let r = high; r > high - 5; r--) {
      if (!ranks.has(r)) { ok = false; break; }
    }
    if (ok) return high;
  }
  if (hasWheel) return 5; // 5-high straight
  return null;
}

// 5枚固定のカードを評価する。
function evaluate5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);

  // ランクごとの枚数
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  // [count, rank] を count降順→rank降順で並べる
  const groups = Object.entries(counts)
    .map(([r, c]) => [c, Number(r)])
    .sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));

  const isFlush = suits.every((s) => s === suits[0]);
  const ranksSet = new Set(ranks);
  const straightHigh = straightHighRank(ranksSet);

  if (isFlush && straightHigh) {
    return [8, straightHigh];
  }
  if (groups[0][0] === 4) {
    return [7, groups[0][1], groups[1][1]]; // フォーカード + キッカー
  }
  if (groups[0][0] === 3 && groups[1][0] === 2) {
    return [6, groups[0][1], groups[1][1]]; // フルハウス
  }
  if (isFlush) {
    return [5, ...ranks]; // フラッシュ（高い順の5枚）
  }
  if (straightHigh) {
    return [4, straightHigh];
  }
  if (groups[0][0] === 3) {
    const kickers = groups.slice(1).map((g) => g[1]);
    return [3, groups[0][1], ...kickers];
  }
  if (groups[0][0] === 2 && groups[1][0] === 2) {
    const pairHigh = Math.max(groups[0][1], groups[1][1]);
    const pairLow = Math.min(groups[0][1], groups[1][1]);
    const kicker = groups[2][1];
    return [2, pairHigh, pairLow, kicker];
  }
  if (groups[0][0] === 2) {
    const kickers = groups.slice(1).map((g) => g[1]);
    return [1, groups[0][1], ...kickers];
  }
  return [0, ...ranks];
}

// スコア配列を比較。a>b なら正、a<b なら負、同点なら0。
export function compareScores(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function combinations5(cards) {
  const res = [];
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++)
            res.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
  return res;
}

// 5〜7枚のカードから最強スコアと、その5枚を返す。
export function evaluateBest(cards) {
  if (cards.length < 5) throw new Error('カードが5枚未満です');
  let best = null;
  let bestCards = null;
  const combos = cards.length === 5 ? [cards] : combinations5(cards);
  for (const combo of combos) {
    const score = evaluate5(combo);
    if (best === null || compareScores(score, best) > 0) {
      best = score;
      bestCards = combo;
    }
  }
  return { score: best, cards: bestCards, categoryName: CATEGORY_NAME[best[0]] };
}

export { CATEGORY_NAME, evaluate5 };
