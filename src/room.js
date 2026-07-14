// ルーム（テーブル）管理：プレイヤー・チップ・ハンド進行・セッション成績。
import { Game } from './poker/game.js';

const MAX_PLAYERS = 9;

export class Room {
  constructor(code, config) {
    this.code = code;
    this.config = {
      startingChips: config.startingChips ?? 1000,
      sb: config.sb ?? 10,
      bb: config.bb ?? 20,
      levelSeconds: Math.max(0, Math.floor(config.levelSeconds ?? 0)), // 0=固定ブラインド、>0=その秒数ごとに上昇
    };
    // ブラインド時計
    this.level = 0;
    this.levelEndsAt = 0; // 0=未開始。最初のハンドで起動
    // トーナメント（脱落・決着）
    this.tourneyFieldIds = null; // 参加者ID（開始時に確定）
    this.tourneyPlaces = {};     // playerId -> 最終順位
    this.finalRanking = null;    // 決着時の順位配列
    this.players = []; // { id, name, chips, connected, socketId, sittingOut }
    this.hostId = null;
    this.creatorId = null; // 部屋を作った人（再接続でホストを取り戻す）
    this.game = null;
    this.dealerIndex = -1; // 前ハンドのボタン位置（players 配列基準ではなく参加者順で管理）
    this.dealerPlayerId = null;
    this.handNumber = 0;
    this.state = 'lobby'; // 'lobby' | 'playing' | 'handover'
    this.createdAt = Date.now();
    this.lastActivity = Date.now();

    // セッション成績（累計）
    this.statsBaseline = {}; // playerId -> リセット時点のチップ
    this.history = [{ hand: 0, stacks: {} }]; // 推移グラフ用スナップショット
  }

  touch() { this.lastActivity = Date.now(); }

  // ブラインド上昇スケジュール（基準SB/BBに対する倍率）
  _blindsForLevel(level) {
    const MULT = [1, 1.5, 2, 3, 4, 6, 10, 14, 20, 30, 50, 80];
    const m = MULT[Math.min(level, MULT.length - 1)];
    return { sb: Math.max(1, Math.round(this.config.sb * m)), bb: Math.max(2, Math.round(this.config.bb * m)) };
  }
  currentBlinds() {
    return this.config.levelSeconds > 0 ? this._blindsForLevel(this.level) : { sb: this.config.sb, bb: this.config.bb };
  }
  // サーバーの定期tickから呼ぶ。レベルが上がったら true を返す。
  updateClock() {
    if (this.config.levelSeconds <= 0 || this.levelEndsAt <= 0) return false;
    let changed = false;
    const now = Date.now();
    while (now >= this.levelEndsAt) {
      this.level += 1;
      this.levelEndsAt += this.config.levelSeconds * 1000;
      changed = true;
    }
    if (changed) this.touch();
    return changed;
  }

  getPlayer(id) { return this.players.find((p) => p.id === id); }
  activePlayers() { return this.players.filter((p) => p.connected); }
  // ハンドに参加できる（接続中・チップあり・着席）プレイヤー
  eligiblePlayers() {
    return this.players.filter((p) => p.connected && p.chips > 0 && !p.sittingOut);
  }

  addPlayer(id, name, char) {
    let p = this.getPlayer(id);
    if (p) {
      // 再接続
      p.connected = true;
      p.name = name || p.name;
      if (char) p.char = char;
      this.touch();
      return { ok: true, player: p, rejoined: true };
    }
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: 'この部屋は満席です（最大9人）' };
    }
    p = {
      id,
      name: name || 'プレイヤー',
      char: char || 'haru',
      chips: this.config.startingChips,
      connected: true,
      socketId: null,
      sittingOut: this.state !== 'lobby', // 対局中の途中参加は次ハンドから
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = id;
    if (!this.creatorId) this.creatorId = id;
    this.statsBaseline[id] = p.chips;
    // 既存の履歴スナップショットにも初期値を補完
    for (const snap of this.history) {
      if (snap.stacks[id] === undefined) snap.stacks[id] = p.chips;
    }
    this.touch();
    return { ok: true, player: p, rejoined: false };
  }

  setConnected(id, connected, socketId) {
    const p = this.getPlayer(id);
    if (!p) return;
    p.connected = connected;
    if (socketId !== undefined) p.socketId = socketId;
    this.touch();
  }

  setChar(id, char) {
    const p = this.getPlayer(id);
    if (p && char) { p.char = char; this.touch(); }
  }

  // ホストを確定する。作成者が接続中なら常に作成者へ戻す。
  // 作成者が不在なら、現ホストが切断中のときだけ接続中の誰かへ委譲する。
  ensureHost() {
    const creator = this.getPlayer(this.creatorId);
    if (creator && creator.connected) { this.hostId = this.creatorId; return; }
    const host = this.getPlayer(this.hostId);
    if (!host || !host.connected) {
      const next = this.activePlayers()[0];
      if (next) this.hostId = next.id; // 誰も居なければ hostId は据え置き（再接続で復帰）
    }
  }

  updateConfig(config) {
    if (this.state !== 'lobby') return { ok: false, error: '対局中は設定を変更できません' };
    if (config.startingChips !== undefined) {
      const v = Math.floor(config.startingChips);
      if (v < 100 || v > 1000000) return { ok: false, error: '初期チップは100〜1,000,000で指定してください' };
      this.config.startingChips = v;
      // ロビー中なら全員のチップを新しい初期値に合わせる
      for (const p of this.players) { p.chips = v; this.statsBaseline[p.id] = v; }
      this.history = [{ hand: 0, stacks: Object.fromEntries(this.players.map((p) => [p.id, v])) }];
    }
    if (config.sb !== undefined) {
      const v = Math.floor(config.sb);
      if (v < 1) return { ok: false, error: 'SBは1以上で指定してください' };
      this.config.sb = v;
    }
    if (config.bb !== undefined) {
      const v = Math.floor(config.bb);
      if (v < 2) return { ok: false, error: 'BBは2以上で指定してください' };
      this.config.bb = v;
    }
    if (this.config.bb <= this.config.sb) {
      this.config.bb = this.config.sb * 2;
    }
    this.touch();
    return { ok: true };
  }

  // ホストによるチップ追加（リバイ／アドオン）
  rebuy(playerId, amount) {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, error: 'プレイヤーが見つかりません' };
    const v = Math.floor(amount);
    if (!Number.isFinite(v) || v <= 0) return { ok: false, error: '追加額が不正です' };
    p.chips += v;
    // 追加分は成績のベースラインにも加算（＝リバイは損益に含めない）
    this.statsBaseline[p.id] = (this.statsBaseline[p.id] || 0) + v;
    this.touch();
    return { ok: true };
  }

  // 席順（players 配列順）でボタンを回す
  _nextDealerId(participants) {
    if (this.dealerPlayerId === null) {
      return participants[0].id;
    }
    // 現在のボタンの「次」の参加者を探す
    const order = this.players.map((p) => p.id).filter((id) => participants.some((x) => x.id === id));
    const idx = order.indexOf(this.dealerPlayerId);
    if (idx === -1) return participants[0].id;
    return order[(idx + 1) % order.length];
  }

  startHand() {
    if (this.state === 'finished') {
      return { ok: false, error: 'このトーナメントは終了しました。新しいトーナメントを始めてください' };
    }
    const isTour = this.config.levelSeconds > 0;
    // 途中参加者の着席を解除（今ハンドから参加可能に）
    for (const p of this.players) {
      if (p.connected && p.chips > 0) p.sittingOut = false;
    }
    // 開始済みトーナメントはフィールドの生存者のみ（途中参加は次のトーナメントから）
    const participants = (isTour && this.tourneyFieldIds)
      ? this.players.filter((p) => this.tourneyFieldIds.includes(p.id) && p.chips > 0)
      : this.eligiblePlayers();
    if (participants.length < 2) {
      return { ok: false, error: 'チップを持つ参加者が2人以上必要です' };
    }
    // players 配列の並びに沿って参加者を整列（席順を安定させる）
    const ordered = this.players.filter((p) => participants.some((x) => x.id === p.id));
    const dealerId = this._nextDealerId(ordered);
    const dealerIndex = ordered.findIndex((p) => p.id === dealerId);

    // トーナメント時は最初のハンドでブラインド時計を起動＆フィールド確定
    if (isTour && this.levelEndsAt === 0) {
      this.levelEndsAt = Date.now() + this.config.levelSeconds * 1000;
      this.tourneyFieldIds = participants.map((p) => p.id);
      this.tourneyPlaces = {};
    }
    const blinds = this.currentBlinds();
    this.game = new Game(
      ordered.map((p) => ({ id: p.id, name: p.name, chips: p.chips, _ref: p })),
      dealerIndex,
      blinds,
    );
    // Game は players[i].chips を直接更新する。ordered の各要素は _ref を持つので同期する。
    this._syncBinding = this.game.seats.map((s) => s.player);
    this.dealerPlayerId = dealerId;
    this.handNumber += 1;
    this.state = 'playing';
    this.touch();
    return { ok: true };
  }

  applyAction(playerId, action, amount) {
    if (!this.game || this.state !== 'playing') {
      return { ok: false, error: 'ハンドが進行していません' };
    }
    // Game 内 seat.player は { id, name, chips, _ref } のオブジェクト。
    const res = this.game.applyAction(playerId, action, amount);
    if (!res.ok) return res;
    // Game が更新したチップを本体プレイヤーへ反映
    this._flushChips();
    if (this.game.isComplete()) {
      this._onHandComplete();
    }
    this.touch();
    return { ok: true };
  }

  _flushChips() {
    for (const seat of this.game.seats) {
      if (seat.player._ref) seat.player._ref.chips = seat.player.chips;
    }
  }

  _onHandComplete() {
    this._flushChips();
    this.state = 'handover';
    // 推移スナップショットを記録
    const stacks = {};
    for (const p of this.players) stacks[p.id] = p.chips;
    this.history.push({ hand: this.handNumber, stacks });
    if (this.history.length > 500) this.history.shift();
    // トーナメント：脱落判定・決着判定
    if (this.config.levelSeconds > 0 && this.tourneyFieldIds) this._processEliminations();
  }

  _processEliminations() {
    const field = this.tourneyFieldIds;
    const fieldSize = field.length;
    // このハンド開始時のスタック（同時脱落の順位付けに使用）
    const seatStart = {};
    for (const s of this.game.seats) seatStart[s.id] = s.startChips;
    // 新たにチップが尽きた（未確定の）フィールドプレイヤー
    const newlyBusted = field
      .map((id) => this.getPlayer(id))
      .filter((p) => p && p.chips <= 0 && !(p.id in this.tourneyPlaces) && (p.id in seatStart));
    // ハンド開始時チップが少ない方を下位（先にplaceを埋める）
    newlyBusted.sort((a, b) => (seatStart[a.id] || 0) - (seatStart[b.id] || 0));
    let placed = Object.keys(this.tourneyPlaces).length;
    for (const p of newlyBusted) {
      this.tourneyPlaces[p.id] = fieldSize - placed; // 5人なら最初の脱落=5位
      placed++;
    }
    // フィールドの生存者（チップ>0）が1人以下なら決着
    const alive = field.map((id) => this.getPlayer(id)).filter((p) => p && p.chips > 0);
    if (alive.length <= 1) {
      if (alive.length === 1) this.tourneyPlaces[alive[0].id] = 1;
      this._finishTournament();
    }
  }

  _finishTournament() {
    this.state = 'finished';
    this.finalRanking = this.tourneyFieldIds
      .map((id) => {
        const p = this.getPlayer(id);
        return { id, name: p ? p.name : '?', char: p ? p.char : 'haru', chips: p ? p.chips : 0, place: this.tourneyPlaces[id] || 99 };
      })
      .sort((a, b) => a.place - b.place);
    this.touch();
  }

  // 新しいトーナメントを開始（チップ・レベル・順位をリセット）
  newTournament() {
    for (const p of this.players) { p.chips = this.config.startingChips; p.sittingOut = false; }
    this.level = 0; this.levelEndsAt = 0;
    this.tourneyFieldIds = null; this.tourneyPlaces = {}; this.finalRanking = null;
    this.game = null; this.dealerPlayerId = null; this.handNumber = 0;
    this.state = 'lobby';
    for (const p of this.players) this.statsBaseline[p.id] = p.chips;
    this.history = [{ hand: 0, stacks: Object.fromEntries(this.players.map((p) => [p.id, p.chips])) }];
    this.touch();
    return { ok: true };
  }

  // 成績（累計損益＝現在チップ − ベースライン）
  standings() {
    return this.players
      .map((p) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        net: p.chips - (this.statsBaseline[p.id] ?? p.chips),
        connected: p.connected,
      }))
      .sort((a, b) => b.net - a.net || b.chips - a.chips);
  }

  resetStats() {
    for (const p of this.players) this.statsBaseline[p.id] = p.chips;
    this.history = [{ hand: this.handNumber, stacks: Object.fromEntries(this.players.map((p) => [p.id, p.chips])) }];
    this.touch();
    return { ok: true };
  }

  // クライアントへ渡す部屋の状態（viewerId 視点）
  view(viewerId) {
    return {
      code: this.code,
      config: this.config,
      state: this.state,
      hostId: this.hostId,
      handNumber: this.handNumber,
      youId: viewerId,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        char: p.char || 'haru',
        chips: p.chips,
        connected: p.connected,
        sittingOut: p.sittingOut,
        isHost: p.id === this.hostId,
      })),
      game: this.game ? this.game.publicView(viewerId) : null,
      standings: this.standings(),
      history: this.history,
      maxPlayers: MAX_PLAYERS,
      // ブラインド時計
      levelSeconds: this.config.levelSeconds,
      level: this.level,
      blinds: this.currentBlinds(),
      levelEndsAt: this.levelEndsAt,
      // トーナメント脱落・決着
      finished: this.state === 'finished',
      finalRanking: this.finalRanking,
      places: this.tourneyPlaces,
    };
  }
}
