// テキサスホールデム 1ハンドの進行を管理する状態機械。
// チップの権威的な計算（ベット・ポット・サイドポット・配当）はすべてここで行う。
import { freshDeck, shuffle } from './deck.js';
import { evaluateBest, compareScores } from './handEvaluator.js';

export const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown', 'complete'];

// players: [{ id, name, chips }] の配列（チップ>0 の参加者のみ）。順番＝着席順。
// dealerIndex: players 配列内のディーラーボタン位置。
// blinds: { sb, bb }
export class Game {
  constructor(players, dealerIndex, blinds) {
    this.blinds = blinds;
    this.dealerIndex = dealerIndex;
    this.deck = shuffle(freshDeck());
    this.community = [];
    this.street = 'preflop';
    this.currentBet = 0;
    this.lastRaiseSize = blinds.bb; // 最小レイズ幅の基準
    this.pots = []; // 確定したポット（表示用）。実配当は showdown で計算
    this.messageLog = [];
    this.result = null; // ハンド終了時の結果サマリ

    // 各席の状態
    this.seats = players.map((p) => ({
      id: p.id,
      name: p.name,
      player: p, // 永続プレイヤー参照（chips を直接更新）
      startChips: p.chips,
      hole: [],
      committed: 0, // このハンドで拠出した総額（サイドポット計算用）
      streetBet: 0, // 現ストリートで出した額
      folded: false,
      allIn: false,
      hasActed: false,
      noReraise: false, // ショートオールイン後、再レイズ権を失った状態（コール/フォールドのみ）
    }));

    this._deal();
    this._postBlinds();
  }

  activeCount() {
    // まだフォールドしていない席数
    return this.seats.filter((s) => !s.folded).length;
  }

  // 発言可能（アクションを取れる）席
  _actableSeats() {
    return this.seats.filter((s) => !s.folded && !s.allIn && s.player.chips > 0);
  }

  _deal() {
    // ボタンの左隣から2周配る（表現上は着席順で問題ない）
    for (let round = 0; round < 2; round++) {
      for (const seat of this.seats) {
        seat.hole.push(this.deck.pop());
      }
    }
  }

  _seatOffset(offset) {
    return (this.dealerIndex + offset) % this.seats.length;
  }

  _postBlind(seat, amount) {
    const pay = Math.min(amount, seat.player.chips);
    seat.player.chips -= pay;
    seat.streetBet += pay;
    seat.committed += pay;
    if (seat.player.chips === 0) seat.allIn = true;
    return pay;
  }

  _postBlinds() {
    const n = this.seats.length;
    let sbIndex, bbIndex, firstToAct;
    if (n === 2) {
      // ヘッズアップ：ボタン＝SB。プリフロップはSB(ボタン)から。
      sbIndex = this.dealerIndex;
      bbIndex = this._seatOffset(1);
      firstToAct = sbIndex;
    } else {
      sbIndex = this._seatOffset(1);
      bbIndex = this._seatOffset(2);
      firstToAct = this._seatOffset(3);
    }
    this._postBlind(this.seats[sbIndex], this.blinds.sb);
    this._postBlind(this.seats[bbIndex], this.blinds.bb);
    this.currentBet = this.blinds.bb;
    this.lastRaiseSize = this.blinds.bb;
    this.bbIndex = bbIndex;

    // ブラインドは強制なので「まだ行動していない」扱い
    this.toAct = this._nextActableFrom(firstToAct, true);
    this._log(`ブラインド投入: SB ${this.seats[sbIndex].name} / BB ${this.seats[bbIndex].name}`);
  }

  // fromIndex（含む）から発言可能な最初の席を探す
  _nextActableFrom(fromIndex, inclusive) {
    const n = this.seats.length;
    for (let i = 0; i < n; i++) {
      const idx = (fromIndex + (inclusive ? i : i + 1)) % n;
      const s = this.seats[idx];
      if (!s.folded && !s.allIn && s.player.chips > 0) return idx;
    }
    return -1;
  }

  currentSeat() {
    return this.toAct >= 0 ? this.seats[this.toAct] : null;
  }

  // 現在手番の席が取れるアクション候補
  legalActions() {
    const seat = this.currentSeat();
    if (!seat) return null;
    const toCall = this.currentBet - seat.streetBet;
    const actions = [];
    actions.push('fold');
    if (toCall <= 0) {
      actions.push('check');
    } else {
      actions.push('call');
    }
    const canOpen = seat.player.chips > Math.max(toCall, 0); // レイズする余地があるか
    // §6-2: 再レイズ権を失っている席（ショートオールインに直面）はベット/レイズ不可
    if (canOpen && !seat.noReraise) {
      actions.push(this.currentBet === 0 ? 'bet' : 'raise');
    }
    // オールイン：再レイズ不可の席は「持ちチップがコール額以下（＝実質コール）」のときのみ
    if (!seat.noReraise || seat.player.chips <= Math.max(toCall, 0)) {
      actions.push('allin');
    }
    return {
      actions,
      toCall: Math.max(0, toCall),
      minRaiseTo: this.currentBet + this.lastRaiseSize, // 「合計いくらまで上げるか」の最小値
      maxRaiseTo: seat.streetBet + seat.player.chips,
      chips: seat.player.chips,
    };
  }

  // action: 'fold'|'check'|'call'|'bet'|'raise'|'allin'
  // amount: bet/raise のとき「このストリートでの合計ベット額(raiseTo)」
  applyAction(playerId, action, amount) {
    const seat = this.currentSeat();
    if (!seat) return { ok: false, error: 'ハンドは進行中ではありません' };
    if (seat.id !== playerId) return { ok: false, error: 'あなたの手番ではありません' };

    const toCall = this.currentBet - seat.streetBet;

    switch (action) {
      case 'fold': {
        seat.folded = true;
        this._log(`${seat.name} がフォールド`);
        break;
      }
      case 'check': {
        if (toCall > 0) return { ok: false, error: 'チェックできません（コールが必要）' };
        this._log(`${seat.name} がチェック`);
        break;
      }
      case 'call': {
        if (toCall <= 0) return { ok: false, error: 'コールする額がありません' };
        this._putIn(seat, Math.min(toCall, seat.player.chips));
        this._log(`${seat.name} がコール`);
        break;
      }
      case 'bet':
      case 'raise': {
        if (seat.noReraise) return { ok: false, error: 'このベットには再レイズできません（コール/フォールドのみ）' };
        const raiseTo = Math.floor(amount);
        if (!Number.isFinite(raiseTo)) return { ok: false, error: '不正な金額です' };
        const maxTo = seat.streetBet + seat.player.chips;
        if (raiseTo > maxTo) return { ok: false, error: 'チップが足りません' };
        const isAllIn = raiseTo === maxTo;
        const minTo = this.currentBet + this.lastRaiseSize;
        // 最小レイズ未満はオールインのときのみ許可
        if (raiseTo < minTo && !isAllIn) {
          return { ok: false, error: `最小レイズは ${minTo} までです` };
        }
        if (raiseTo <= this.currentBet) {
          return { ok: false, error: 'レイズ額が現在のベットを超えていません' };
        }
        this._putIn(seat, raiseTo - seat.streetBet);
        this._applyAggression(seat, raiseTo);
        this._log(`${seat.name} が ${this.currentBet} へ${action === 'bet' ? 'ベット' : 'レイズ'}`);
        break;
      }
      case 'allin': {
        const all = seat.player.chips;
        const newStreetBet = seat.streetBet + all;
        // 再レイズ不可の席が、コール額を超えてオールイン＝レイズは認めない
        if (seat.noReraise && newStreetBet > this.currentBet) {
          return { ok: false, error: 'このベットには再レイズできません（コール/フォールドのみ）' };
        }
        this._putIn(seat, all);
        if (newStreetBet > this.currentBet) this._applyAggression(seat, newStreetBet);
        this._log(`${seat.name} がオールイン (${newStreetBet})`);
        break;
      }
      default:
        return { ok: false, error: '不明なアクションです' };
    }

    seat.hasActed = true;
    this._advance();
    return { ok: true };
  }

  _putIn(seat, amount) {
    const pay = Math.min(amount, seat.player.chips);
    seat.player.chips -= pay;
    seat.streetBet += pay;
    seat.committed += pay;
    if (seat.player.chips === 0) seat.allIn = true;
  }

  // ベット/レイズ/オールインで場のベット額が上がったときの処理。
  // フルレイズ（増分 >= 直前レイズ幅）なら全員に再レイズ権を含めて手番を回す。
  // ショートオールイン（フル未満）なら、既にアクション済みの席は再レイズ権を失う（コール/フォールドのみ）。
  _applyAggression(seat, newStreetBet) {
    const inc = newStreetBet - this.currentBet;
    const isFull = inc >= this.lastRaiseSize;
    this.currentBet = newStreetBet;
    if (isFull) {
      this.lastRaiseSize = inc;
      for (const s of this.seats) {
        if (s === seat || s.folded || s.allIn) continue;
        s.hasActed = false;   // もう一度アクションが必要
        s.noReraise = false;  // ベッティングが再オープン＝再レイズ権も復活
      }
      seat.noReraise = false;
    } else {
      // ショートオールイン：コール額は上がるが再レイズ権は復活しない
      for (const s of this.seats) {
        if (s === seat || s.folded || s.allIn) continue;
        if (s.hasActed) s.noReraise = true; // アクション済み → 以降はコール/フォールドのみ
        // 未アクションの席はそのまま（満額の選択肢を保持）
      }
    }
  }

  _bettingRoundComplete() {
    // フォールドしていない席が1人以下ならハンド終了
    if (this.activeCount() <= 1) return true;
    const actable = this._actableSeats();
    if (actable.length === 0) return true; // 全員オールイン
    for (const s of actable) {
      if (!s.hasActed) return false;
      if (s.streetBet !== this.currentBet) return false;
    }
    return true;
  }

  _advance() {
    // フォールドで1人だけ残った → 即終了
    if (this.activeCount() <= 1) {
      this._finishHand();
      return;
    }
    if (this._bettingRoundComplete()) {
      this._nextStreet();
      return;
    }
    // 次の手番へ
    this.toAct = this._nextActableFrom(this.toAct, false);
    // 手番が回らない（発言可能者が実質1人でベットも揃っている）ケースの保険
    if (this.toAct === -1) {
      this._nextStreet();
    }
  }

  _nextStreet() {
    // ストリート繰り越し：ベットをリセット
    for (const s of this.seats) {
      s.streetBet = 0;
      s.hasActed = false;
      s.noReraise = false;
    }
    this.currentBet = 0;
    this.lastRaiseSize = this.blinds.bb;

    // 以降ベットできる人が1人以下なら、リバーまで一気に配ってショーダウン
    const canBet = this._actableSeats().length;

    if (this.street === 'preflop') {
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.street = 'flop';
      this._log('フロップ公開');
    } else if (this.street === 'flop') {
      this.community.push(this.deck.pop());
      this.street = 'turn';
      this._log('ターン公開');
    } else if (this.street === 'turn') {
      this.community.push(this.deck.pop());
      this.street = 'river';
      this._log('リバー公開');
    } else if (this.street === 'river') {
      this._finishHand();
      return;
    }

    if (canBet <= 1) {
      // ベット不能 → このストリートのアクションは無いので更に先へ
      this._nextStreet();
      return;
    }

    // ポストフロップの手番：ボタンの左隣（ヘッズアップは非ボタン）から
    const start = this.seats.length === 2 ? this._seatOffset(1) : this._seatOffset(1);
    this.toAct = this._nextActableFrom(start, true);
  }

  // サイドポットを committed から計算
  _computePots() {
    const contributors = this.seats.filter((s) => s.committed > 0);
    const levels = [...new Set(contributors.map((s) => s.committed))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      const layerContributors = contributors.filter((s) => s.committed >= level);
      const amount = (level - prev) * layerContributors.length;
      const eligible = layerContributors.filter((s) => !s.folded).map((s) => s.id);
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    // 同じ eligible 集合のポットは統合
    const merged = [];
    for (const pot of pots) {
      const key = pot.eligible.slice().sort().join(',');
      const found = merged.find((m) => m.key === key);
      if (found) found.amount += pot.amount;
      else merged.push({ key, amount: pot.amount, eligible: pot.eligible });
    }
    return merged.map(({ amount, eligible }) => ({ amount, eligible }));
  }

  _finishHand() {
    const pots = this._computePots();
    const remaining = this.seats.filter((s) => !s.folded);

    // 各席のベスト評価（コミュニティが5枚あるときのみ）
    const evals = {};
    const showdownNeeded = remaining.length > 1;
    for (const s of remaining) {
      if (this.community.length === 5) {
        evals[s.id] = evaluateBest([...s.hole, ...this.community]);
      }
    }

    const winnings = {}; // id -> 獲得チップ
    for (const s of this.seats) winnings[s.id] = 0;
    const potResults = [];

    for (const pot of pots) {
      const eligibleSeats = this.seats.filter((s) => pot.eligible.includes(s.id) && !s.folded);
      let winners = [];
      if (eligibleSeats.length === 1) {
        winners = eligibleSeats;
      } else if (this.community.length === 5) {
        let best = null;
        for (const s of eligibleSeats) {
          const sc = evals[s.id].score;
          if (best === null || compareScores(sc, best) > 0) {
            best = sc;
            winners = [s];
          } else if (compareScores(sc, best) === 0) {
            winners.push(s);
          }
        }
      } else {
        // コミュニティ未完（通常は起きない）→ eligible 全員で分配
        winners = eligibleSeats;
      }

      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      // 端数はボタンから時計回りで最初の勝者へ
      const orderedWinners = this._orderFromButton(winners);
      for (const w of orderedWinners) {
        let award = share;
        if (remainder > 0) { award += 1; remainder -= 1; }
        w.player.chips += award;
        winnings[w.id] += award;
      }
      potResults.push({
        amount: pot.amount,
        winners: orderedWinners.map((w) => w.id),
      });
    }

    // 結果サマリ
    this.street = 'complete';
    this.toAct = -1;
    this.result = {
      showdown: showdownNeeded && this.community.length === 5,
      community: this.community.slice(),
      pots: potResults,
      players: this.seats.map((s) => ({
        id: s.id,
        name: s.name,
        folded: s.folded,
        hole: s.hole,
        committed: s.committed,
        won: winnings[s.id],
        net: s.player.chips - s.startChips,
        endChips: s.player.chips,
        hand: evals[s.id] ? { category: evals[s.id].categoryName, cards: evals[s.id].cards } : null,
        // ショーダウンに残った（=手札公開）か
        revealed: !s.folded && showdownNeeded && this.community.length === 5,
      })),
    };
    this._log('ハンド終了');
  }

  _orderFromButton(seats) {
    const n = this.seats.length;
    const order = [];
    for (let i = 1; i <= n; i++) {
      const idx = (this.dealerIndex + i) % n;
      const s = this.seats[idx];
      if (seats.includes(s)) order.push(s);
    }
    return order;
  }

  _log(msg) {
    this.messageLog.push(msg);
    if (this.messageLog.length > 30) this.messageLog.shift();
  }

  isComplete() {
    return this.street === 'complete';
  }

  // クライアントへ渡す公開ビュー。viewerId の席のみホールカードを含める。
  publicView(viewerId) {
    const legal = this.currentSeat() ? this.legalActions() : null;
    const totalPot = this.seats.reduce((sum, s) => sum + s.committed, 0);
    return {
      street: this.street,
      community: this.community,
      currentBet: this.currentBet,
      totalPot,
      dealerId: this.seats[this.dealerIndex].id,
      toActId: this.toAct >= 0 ? this.seats[this.toAct].id : null,
      legal: this.currentSeat() && this.currentSeat().id === viewerId ? legal : (legal ? { toCall: legal.toCall } : null),
      log: this.messageLog.slice(-6),
      seats: this.seats.map((s) => ({
        id: s.id,
        name: s.name,
        chips: s.player.chips,
        streetBet: s.streetBet,
        committed: s.committed,
        folded: s.folded,
        allIn: s.allIn,
        isDealer: this.seats[this.dealerIndex].id === s.id,
        isTurn: this.toAct >= 0 && this.seats[this.toAct].id === s.id,
        // 自分の手札か、ショーダウン後の公開のみ見せる
        hole: (s.id === viewerId)
          ? s.hole
          : (this.result && this.result.players.find((p) => p.id === s.id)?.revealed ? s.hole : null),
      })),
      result: this.result,
    };
  }
}
