/* 仲間内ホールデム クライアント */
(() => {
  'use strict';

  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const RED_SUITS = new Set(['h', 'd']);
  const PALETTE = ['#e8c766', '#4c8dff', '#35c07a', '#e8624a', '#b57edc', '#38b6c4', '#e8a13a', '#ff7eb6', '#8dd35f'];

  // キャラクター定義
  const CHARS = [
    { id: 'haru', name: 'ハルくん', color: '#c0392b' },
    { id: 'hina', name: 'ひなちゃん', color: '#2f6fb0' },
    { id: 'yan', name: 'ヤンヤン', color: '#3a8a3a' },
    { id: 'jui', name: 'じゅい', color: '#c96a86' },
    { id: 'ryu', name: 'りゅうちゃん', color: '#7d5ba6' },
  ];
  const charById = (id) => CHARS.find((c) => c.id === id) || CHARS[0];
  const charImg = (id) => `/chars/${charById(id).id}.png`;
  let selectedChar = localStorage.getItem('holdem_char') || 'haru';

  // ---- 永続 ID（アカウント無しでも再接続で席を保持）----
  function getPlayerId() {
    let id = localStorage.getItem('holdem_pid');
    if (!id) { id = 'pl_' + Math.random().toString(36).slice(2, 11); localStorage.setItem('holdem_pid', id); }
    return id;
  }
  const playerId = getPlayerId();

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  const socket = io();
  let state = null;   // 直近の room:state
  let currentCode = null;

  // 演出用：前回状態の記憶
  let prevLog = '';
  let prevToActId = null;
  let celebratedHand = -1;
  let firstEffect = true;

  // ================= サウンド（Web Audioで合成。音声ファイル不要） =================
  const Sound = (() => {
    let ctx = null;
    let enabled = localStorage.getItem('holdem_sound') !== 'off';
    function ensure() {
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; } }
      if (ctx && ctx.state === 'suspended') ctx.resume();
    }
    function blip(freq, start, dur, opt) {
      if (!ctx) return;
      opt = opt || {};
      const t0 = ctx.currentTime + start;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = opt.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (opt.sweep) osc.frequency.exponentialRampToValueAtTime(opt.sweep, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(opt.vol || 0.16, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.03);
    }
    function chip(start, n) {
      for (let i = 0; i < (n || 1); i++) blip(1150 + Math.random() * 450, start + i * 0.05, 0.06, { type: 'triangle', vol: 0.11 });
    }
    const sounds = {
      deal: () => { for (let i = 0; i < 3; i++) blip(560, i * 0.06, 0.05, { type: 'triangle', vol: 0.08 }); },
      check: () => blip(300, 0, 0.1, { type: 'sine', vol: 0.14 }),
      call: () => chip(0, 2),
      bet: () => chip(0, 3),
      raise: () => { chip(0, 3); blip(480, 0, 0.13, { type: 'sine', vol: 0.09, sweep: 760 }); },
      allin: () => { blip(280, 0, 0.5, { type: 'sawtooth', vol: 0.11, sweep: 720 }); chip(0.12, 4); },
      fold: () => blip(360, 0, 0.24, { type: 'sine', vol: 0.12, sweep: 150 }),
      turn: () => { blip(880, 0, 0.12, { type: 'sine', vol: 0.14 }); blip(1320, 0.1, 0.13, { type: 'sine', vol: 0.11 }); },
      win: () => { [523, 659, 784, 1047].forEach((f, i) => blip(f, i * 0.09, 0.22, { type: 'triangle', vol: 0.16 })); },
      youwin: () => { [523, 659, 784, 1047, 1319].forEach((f, i) => blip(f, i * 0.08, 0.26, { type: 'triangle', vol: 0.19 })); chip(0.22, 5); },
    };
    function play(name) { if (!enabled) return; ensure(); if (!ctx) return; (sounds[name] || (() => {}))(); }
    function setEnabled(v) { enabled = v; localStorage.setItem('holdem_sound', v ? 'on' : 'off'); if (v) ensure(); }
    function isEnabled() { return enabled; }
    return { play, setEnabled, isEnabled, ensure };
  })();
  // 最初のユーザー操作でオーディオを有効化（ブラウザ制約）
  document.addEventListener('click', () => Sound.ensure(), { once: true });
  document.addEventListener('touchstart', () => Sound.ensure(), { once: true });

  // ================= トースト =================
  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ================= 画面遷移 =================
  function hideLoading() { const l = $('#loading'); if (l) l.hidden = true; }
  function showGate() { hideLoading(); $('#gate').hidden = false; $('#home').hidden = true; $('#game').hidden = true; }
  function showHome() { hideLoading(); $('#gate').hidden = true; $('#home').hidden = false; $('#game').hidden = true; }
  function showGame() { hideLoading(); $('#gate').hidden = true; $('#home').hidden = true; $('#game').hidden = false; }

  // ================= 合い言葉ロック =================
  // 認証済みなら保存された部屋へ復帰、未認証ならホームを表示
  function afterAuth() {
    const savedRoom = localStorage.getItem('holdem_room');
    if (!savedRoom) { if (!currentCode) showHome(); return; }
    socket.emit('room:resume', { playerId, code: savedRoom }, (res) => {
      if (res.ok) enterRoom(res.code);
      else if (!currentCode) { localStorage.removeItem('holdem_room'); showHome(); }
    });
  }

  $('#gate-btn').addEventListener('click', submitGate);
  $('#gate-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGate(); });
  function submitGate() {
    const code = $('#gate-input').value.trim();
    if (!code) return;
    socket.emit('auth:check', code, (r) => {
      if (r.ok) { sessionStorage.setItem('holdem_gate', code); $('#gate-error').hidden = true; afterAuth(); }
      else { const e = $('#gate-error'); e.textContent = r.error || '合い言葉が違います'; e.hidden = false; }
    });
  }

  // ================= 接続・入退室 =================
  function saveName(n) { localStorage.setItem('holdem_name', n); }
  $('#name').value = localStorage.getItem('holdem_name') || '';

  // キャラクター選択（ホーム画面）
  function renderCharPicker() {
    const picker = $('#char-picker');
    if (!picker) return;
    picker.innerHTML = '';
    CHARS.forEach((c) => {
      const item = el('div', 'char-item' + (c.id === selectedChar ? ' selected' : ''));
      item.style.setProperty('--char-color', c.color);
      const av = el('div', 'char-avatar');
      const img = document.createElement('img');
      img.src = charImg(c.id); img.alt = c.name; img.loading = 'lazy';
      av.appendChild(img);
      item.appendChild(av);
      item.title = c.name;
      item.addEventListener('click', () => {
        selectedChar = c.id;
        localStorage.setItem('holdem_char', c.id);
        renderCharPicker();
      });
      picker.appendChild(item);
    });
  }
  renderCharPicker();

  $('#btn-create').addEventListener('click', () => {
    const name = $('#name').value.trim();
    if (!name) return toast('名前を入力してください', true);
    saveName(name);
    const config = {
      startingChips: Number($('#cfg-chips').value) || 1000,
      sb: Number($('#cfg-sb').value) || 10,
      bb: Number($('#cfg-bb').value) || 20,
    };
    socket.emit('room:create', { playerId, name, config, char: selectedChar }, (res) => {
      if (!res.ok) return homeError(res.error);
      enterRoom(res.code);
    });
  });

  $('#btn-join').addEventListener('click', () => {
    const name = $('#name').value.trim();
    const code = $('#join-code').value.trim().toUpperCase();
    if (!name) return toast('名前を入力してください', true);
    if (code.length !== 4) return toast('4文字のルームコードを入力してください', true);
    saveName(name);
    socket.emit('room:join', { playerId, name, code, char: selectedChar }, (res) => {
      if (!res.ok) return homeError(res.error);
      enterRoom(res.code);
    });
  });
  $('#join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

  function homeError(msg) { const e = $('#home-error'); e.textContent = msg; e.hidden = false; }

  function enterRoom(code) {
    currentCode = code;
    localStorage.setItem('holdem_room', code);
    $('#room-code-text').textContent = code;
    showGame();
  }

  // 接続確立時：まず合い言葉ロックの要否を確認 → 認証後に部屋へ自動復帰
  socket.on('connect', () => {
    socket.emit('auth:status', (st) => {
      if (st && st.required && !st.authed) {
        const saved = sessionStorage.getItem('holdem_gate');
        if (saved) {
          socket.emit('auth:check', saved, (r) => {
            if (r.ok) afterAuth();
            else { sessionStorage.removeItem('holdem_gate'); showGate(); }
          });
        } else {
          showGate();
        }
      } else {
        afterAuth();
      }
    });
  });

  $('#btn-leave').addEventListener('click', () => {
    if (!confirm('部屋から退出しますか？（チップと成績は残ります。同じ名前・端末で再入室すれば復帰できます）')) return;
    localStorage.removeItem('holdem_room');
    currentCode = null; state = null;
    showHome();
    socket.disconnect(); socket.connect();
  });

  // ================= サーバー状態受信 =================
  socket.on('room:state', (s) => { state = s; render(); });

  // ================= カード描画 =================
  function cardEl(card, size) {
    if (!card) { const b = el('div', 'card back' + (size ? ' ' + size : '')); return b; }
    const red = RED_SUITS.has(card.suit);
    const c = el('div', 'card' + (red ? ' red' : '') + (size ? ' ' + size : ''));
    c.innerHTML = `<span class="rank">${rankLabel(card.rank)}</span><span class="suit">${SUIT[card.suit]}</span>`;
    return c;
  }
  function rankLabel(r) { return ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[r] || String(r); }

  // ================= メイン描画 =================
  function render() {
    if (!state) return;
    $('#room-code-text').textContent = state.code;
    const you = state.players.find((p) => p.id === state.youId);
    const isHost = state.hostId === state.youId;
    $('#hand-label').textContent = state.handNumber > 0 ? `ハンド #${state.handNumber}` : 'ロビー';

    renderSeats();
    renderBoard();
    renderActionBar(you, isHost);
    renderLog();
    handleEffects();
    if (!$('#stats-panel').hidden) renderStats();
  }

  // ================= 演出（音・勝利バナー） =================
  function handleEffects() {
    const g = state.game;
    const lastLog = g && g.log && g.log.length ? g.log[g.log.length - 1] : '';
    const toAct = g ? g.toActId : null;
    // 初回（入室/リロード直後）は鳴らさず、基準だけ記録
    if (firstEffect) {
      firstEffect = false;
      prevLog = lastLog; prevToActId = toAct;
      if (state.state === 'handover' && g && g.result) celebratedHand = state.handNumber;
      return;
    }
    // 1) 直近ログの変化で効果音
    if (lastLog && lastLog !== prevLog) { playForLog(lastLog); prevLog = lastLog; }
    // 2) 自分の手番になったら通知音
    if (toAct && toAct === state.youId && prevToActId !== state.youId && state.state === 'playing') Sound.play('turn');
    prevToActId = toAct;
    // 3) 勝敗演出（handover に入って結果が出た初回のみ）
    if (state.state === 'handover' && g && g.result && celebratedHand !== state.handNumber) {
      celebratedHand = state.handNumber;
      celebrate(g.result);
    }
  }

  function playForLog(line) {
    if (line.includes('フォールド')) Sound.play('fold');
    else if (line.includes('チェック')) Sound.play('check');
    else if (line.includes('オールイン')) Sound.play('allin');
    else if (line.includes('レイズ') || line.includes('ベット')) Sound.play('raise');
    else if (line.includes('コール')) Sound.play('call');
    else if (line.includes('フロップ') || line.includes('ターン') || line.includes('リバー') || line.includes('ブラインド投入')) Sound.play('deal');
  }

  function celebrate(result) {
    const winners = new Set();
    result.pots.forEach((p) => p.winners.forEach((w) => winners.add(w)));
    const youWon = winners.has(state.youId);
    const names = [...winners].map((id) => (result.players.find((p) => p.id === id) || {}).name).filter(Boolean);
    const total = result.pots.reduce((s, p) => s + p.amount, 0);
    Sound.play(youWon ? 'youwin' : 'win');
    const wp = result.players.find((p) => p.id === [...winners][0]);
    const handName = wp && wp.hand ? wp.hand.category : '';
    showWinBanner(youWon, names.join('・'), total, handName);
  }

  let winBannerTimer;
  function showWinBanner(youWon, names, total, handName) {
    const b = $('#win-banner');
    b.className = 'win-banner' + (youWon ? ' you' : '');
    b.innerHTML = `<div class="wb-inner">
      <div class="wb-title">${youWon ? '🎉 あなたの勝ち！' : '🏆 ' + names + ' の勝ち'}</div>
      <div class="wb-amount">+${fmt(total)} 獲得</div>
      ${handName ? `<div class="wb-hand">${handName}</div>` : ''}
    </div>`;
    b.hidden = false;
    clearTimeout(winBannerTimer);
    winBannerTimer = setTimeout(() => { b.hidden = true; }, 3200);
  }

  // 席配置：相手は上側の弧に、自分は常に下中央に固定
  function renderSeats() {
    const container = $('#seats');
    container.innerHTML = '';
    const players = state.players;
    const gameSeats = state.game ? state.game.seats : [];
    const seatById = {};
    for (const gs of gameSeats) seatById[gs.id] = gs;

    const narrow = window.innerWidth <= 560;
    const youIdx = players.findIndex((p) => p.id === state.youId);
    const opponents = players.filter((_, i) => i !== youIdx);
    const layout = []; // { player, x, y, isYou }

    const m = opponents.length;
    opponents.forEach((p, k) => {
      // 上側の弧（200°〜340°、270°が真上）に均等配置
      const deg = m === 1 ? 270 : 200 + (140 * k) / (m - 1);
      const th = (deg * Math.PI) / 180;
      layout.push({ player: p, x: 50 + 41 * Math.cos(th), y: (narrow ? 42 : 44) + 37 * Math.sin(th), isYou: false });
    });
    // 自分は下中央。スマホは少し上げてアクションバーとの被りを防ぐ
    if (youIdx !== -1) layout.push({ player: players[youIdx], x: 50, y: narrow ? 83 : 87, isYou: true });

    layout.forEach(({ player: p, x, y, isYou }) => {
      const gs = seatById[p.id];
      const seat = el('div', 'seat' + (isYou ? ' you-seat' : ''));
      seat.style.left = x + '%';
      seat.style.top = y + '%';
      if (gs) {
        if (gs.isTurn) seat.classList.add('is-turn');
        if (gs.folded) seat.classList.add('folded');
      }

      // カード（自分 or ショーダウン公開のみ表向き）
      const cards = el('div', 'seat-cards');
      if (gs && !gs.folded) {
        if (gs.hole && gs.hole.length) {
          gs.hole.forEach((c) => cards.appendChild(cardEl(c, p.id === state.youId ? 'big' : 'small')));
        } else {
          cards.appendChild(cardEl(null, 'small')); cards.appendChild(cardEl(null, 'small'));
        }
      }
      seat.appendChild(cards);

      // ポッド
      const pod = el('div', 'seat-pod');
      // キャラアバター
      const av = el('div', 'seat-avatar');
      av.style.setProperty('--char-color', charById(p.char).color);
      const aimg = document.createElement('img'); aimg.src = charImg(p.char); aimg.alt = '';
      av.appendChild(aimg);
      pod.appendChild(av);
      const nameRow = el('div', 'seat-name');
      if (gs && gs.isDealer) nameRow.appendChild(el('span', 'dealer-btn', 'D'));
      nameRow.appendChild(document.createTextNode(p.name));
      if (p.id === state.youId) nameRow.appendChild(el('span', 'you-badge', '(あなた)'));
      pod.appendChild(nameRow);

      pod.appendChild(el('div', 'seat-chips', fmt(p.chips)));

      // タグ（オールイン/退席/勝者/見学）
      const resultPlayer = state.game && state.game.result
        ? state.game.result.players.find((rp) => rp.id === p.id) : null;
      const won = resultPlayer && resultPlayer.won > 0;
      if (won) { seat.classList.add('winner'); pod.appendChild(el('span', 'seat-tag tag-win', `+${fmt(resultPlayer.won)}`)); }
      else if (gs && gs.allIn) pod.appendChild(el('span', 'seat-tag tag-allin', 'ALL IN'));
      else if (!gs && state.state !== 'lobby') pod.appendChild(el('span', 'seat-tag tag-off', p.sittingOut ? '見学' : (p.chips <= 0 ? 'チップ切れ' : '待機')));
      if (!p.connected) pod.appendChild(el('span', 'seat-tag tag-out', 'オフライン'));

      // ショーダウンの役名
      if (resultPlayer && resultPlayer.revealed && resultPlayer.hand) {
        pod.appendChild(el('div', 'seat-hand', resultPlayer.hand.category));
      }
      seat.appendChild(pod);

      // ベット額チップ
      if (gs && gs.streetBet > 0) {
        seat.appendChild(el('div', 'seat-bet', fmt(gs.streetBet)));
      }
      container.appendChild(seat);
    });
  }

  function renderBoard() {
    const community = $('#community');
    community.innerHTML = '';
    const g = state.game;
    if (g && g.community) g.community.forEach((c) => community.appendChild(cardEl(c)));

    const pot = $('#pot');
    if (g && g.totalPot > 0) pot.innerHTML = `POT <b>${fmt(g.totalPot)}</b>`;
    else pot.innerHTML = '';

    const msg = $('#board-msg');
    if (!g) {
      msg.textContent = state.players.length < 2 ? '友達の入室を待っています…' : 'ホストの開始を待っています';
    } else if (g.result) {
      msg.textContent = resultMessage(g.result);
    } else {
      msg.textContent = streetName(g.street);
    }
  }

  function streetName(s) {
    return ({ preflop: 'プリフロップ', flop: 'フロップ', turn: 'ターン', river: 'リバー', showdown: 'ショーダウン' })[s] || '';
  }

  function resultMessage(result) {
    const winners = new Set();
    result.pots.forEach((p) => p.winners.forEach((w) => winners.add(w)));
    const names = [...winners].map((id) => (result.players.find((p) => p.id === id) || {}).name).filter(Boolean);
    if (names.length === 0) return 'ハンド終了';
    const total = result.pots.reduce((s, p) => s + p.amount, 0);
    return `${names.join('・')} が ${fmt(total)} を獲得`;
  }

  // ================= アクションバー =================
  function renderActionBar(you, isHost) {
    const bar = $('#action-bar');
    bar.innerHTML = '';
    const g = state.game;

    // --- ロビー / ハンド間 ---
    if (!g || state.state === 'lobby' || state.state === 'handover') {
      const wrap = el('div', 'lobby-bar');

      if (state.state === 'handover' && g && g.result) {
        const sum = el('div', 'result-summary');
        sum.appendChild(el('div', 'result-title', resultMessage(g.result)));
        wrap.appendChild(sum);
      }

      // プレイヤー一覧
      const list = el('div', 'lobby-players');
      state.players.forEach((p) => {
        const chip = el('div', 'lobby-chip' + (p.connected ? '' : ' off'));
        const av = el('span', 'lobby-avatar');
        av.style.setProperty('--char-color', charById(p.char).color);
        const aimg = document.createElement('img'); aimg.src = charImg(p.char); aimg.alt = '';
        av.appendChild(aimg);
        chip.appendChild(av);
        chip.appendChild(document.createTextNode(`${p.name}　${fmt(p.chips)}`));
        if (p.isHost) chip.appendChild(el('span', 'you-badge', 'HOST'));
        list.appendChild(chip);
      });
      wrap.appendChild(list);

      const eligible = state.players.filter((p) => p.connected && p.chips > 0).length;
      if (isHost) {
        const btn = el('button', 'btn btn-primary btn-block', state.state === 'handover' ? '次のハンドへ' : 'ゲーム開始');
        btn.disabled = eligible < 2;
        btn.addEventListener('click', () => {
          socket.emit(state.state === 'handover' ? 'game:next' : 'game:start', {}, (res) => { if (!res.ok) toast(res.error, true); });
        });
        wrap.appendChild(btn);
        if (eligible < 2) wrap.appendChild(el('div', 'lobby-hint', 'チップを持つ参加者が2人以上そろうと開始できます'));
      } else {
        wrap.appendChild(el('div', 'waiting-note', state.state === 'handover' ? 'ホストが次のハンドを始めるのを待っています…' : 'ホストの開始を待っています…'));
      }

      // 途中でチップ切れ→ホストにチップ追加を促す（ホスト操作は成績パネル側）
      bar.appendChild(wrap);
      return;
    }

    // --- 対局中：自分の手番か ---
    const g2 = state.game;
    const myTurn = g2.toActId === state.youId;
    if (!myTurn) {
      const seat = g2.seats.find((s) => s.id === g2.toActId);
      if (seat) bar.appendChild(el('div', 'waiting-note', `${seat.name} の番です…`));
      return;
    }

    const legal = g2.legal; // { actions, toCall, minRaiseTo, maxRaiseTo, chips }
    if (!legal || !legal.actions) return;

    // レイズ/ベットのコントロール
    let raiseTo = Math.min(legal.minRaiseTo, legal.maxRaiseTo);
    const canRaise = legal.actions.includes('bet') || legal.actions.includes('raise');
    const raiseLabel = legal.actions.includes('bet') ? 'ベット' : 'レイズ';

    if (canRaise && legal.maxRaiseTo > legal.minRaiseTo) {
      const rc = el('div', 'raise-controls');
      const range = el('input'); range.type = 'range';
      range.min = legal.minRaiseTo; range.max = legal.maxRaiseTo; range.step = 1; range.value = raiseTo;
      const amt = el('div', 'raise-amount', fmt(raiseTo));
      range.addEventListener('input', () => { raiseTo = Number(range.value); amt.textContent = fmt(raiseTo); });
      rc.appendChild(range); rc.appendChild(amt);
      bar.appendChild(rc);

      // クイックベット
      const quick = el('div', 'quick-bets');
      const pot = g2.totalPot;
      const mkQuick = (label, val) => {
        const v = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(val)));
        const b = el('button', 'chip-btn', label);
        b.addEventListener('click', () => { raiseTo = v; range.value = v; amt.textContent = fmt(v); });
        return b;
      };
      quick.appendChild(mkQuick('最小', legal.minRaiseTo));
      quick.appendChild(mkQuick('½ポット', legal.toCall + pot * 0.5 + legal.toCall));
      quick.appendChild(mkQuick('ポット', legal.toCall + pot + legal.toCall));
      quick.appendChild(mkQuick('MAX', legal.maxRaiseTo));
      bar.appendChild(quick);
    }

    // アクションボタン
    const row = el('div', 'act-row');
    const act = (a, label, cls) => {
      const b = el('button', 'btn ' + cls, label);
      b.addEventListener('click', () => sendAction(a, a === 'bet' || a === 'raise' ? raiseTo : undefined));
      return b;
    };
    row.appendChild(act('fold', 'フォールド', 'btn-fold'));
    if (legal.actions.includes('check')) row.appendChild(act('check', 'チェック', 'btn-check'));
    if (legal.actions.includes('call')) row.appendChild(act('call', `コール ${fmt(legal.toCall)}`, 'btn-call'));
    bar.appendChild(row);

    const row2 = el('div', 'act-row');
    if (canRaise) {
      if (legal.maxRaiseTo > legal.minRaiseTo) {
        row2.appendChild(act(legal.actions.includes('bet') ? 'bet' : 'raise', `${raiseLabel} ${fmt(raiseTo)}`, 'btn-' + (legal.actions.includes('bet') ? 'bet' : 'raise')));
      }
    }
    row2.appendChild(act('allin', `オールイン ${fmt(legal.chips)}`, 'btn-allin'));
    // レイズボタンのラベルを動的更新
    if (canRaise && legal.maxRaiseTo > legal.minRaiseTo) {
      const raiseBtn = row2.querySelector('.btn-bet, .btn-raise');
      const rangeInput = bar.querySelector('input[type=range]');
      if (rangeInput && raiseBtn) rangeInput.addEventListener('input', () => { raiseBtn.textContent = `${raiseLabel} ${fmt(Number(rangeInput.value))}`; });
    }
    bar.appendChild(row2);
  }

  let actionLock = false;
  function sendAction(action, amount) {
    if (actionLock) return;
    actionLock = true;
    socket.emit('game:action', { action, amount }, (res) => {
      actionLock = false;
      if (!res.ok) toast(res.error, true);
    });
  }

  // ================= ログ =================
  function renderLog() {
    const log = $('#log');
    const g = state.game;
    if (g && g.log && g.log.length) log.textContent = g.log[g.log.length - 1];
    else log.textContent = '';
  }

  // ================= 成績パネル =================
  $('#btn-stats').addEventListener('click', () => { $('#stats-panel').hidden = false; renderStats(); });
  $('#stats-panel').addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) $('#stats-panel').hidden = true; });
  document.querySelectorAll('#stats-panel .stats-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#stats-panel .stats-tabs .tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      $('#tab-board').hidden = which !== 'board';
      $('#tab-graph').hidden = which !== 'graph';
      if (which === 'graph') renderChart();
    });
  });

  // ================= 遊び方・役パネル =================
  $('#btn-info').addEventListener('click', () => { $('#info-panel').hidden = false; buildHandRankings(); });
  $('#info-panel').addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) $('#info-panel').hidden = true; });
  document.querySelectorAll('#info-panel .stats-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#info-panel .stats-tabs .tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.itab;
      $('#itab-rules').hidden = which !== 'rules';
      $('#itab-hands').hidden = which !== 'hands';
      if (which === 'hands') buildHandRankings();
    });
  });

  function buildHandRankings() {
    const wrap = $('#hand-rankings');
    if (wrap.dataset.built) return;
    wrap.dataset.built = '1';
    const C = (r, s) => ({ rank: r, suit: s });
    const list = [
      ['ロイヤルフラッシュ', '同じマークの 10・J・Q・K・A（最強）', [C(10, 's'), C(11, 's'), C(12, 's'), C(13, 's'), C(14, 's')]],
      ['ストレートフラッシュ', '同じマークで数字が5枚連続', [C(5, 'h'), C(6, 'h'), C(7, 'h'), C(8, 'h'), C(9, 'h')]],
      ['フォーカード', '同じ数字が4枚', [C(9, 'c'), C(9, 'd'), C(9, 'h'), C(9, 's'), C(14, 'd')]],
      ['フルハウス', 'スリーカード＋ワンペア', [C(13, 's'), C(13, 'h'), C(13, 'd'), C(5, 'c'), C(5, 'h')]],
      ['フラッシュ', '同じマークが5枚（連続でなくてOK）', [C(2, 's'), C(5, 's'), C(8, 's'), C(11, 's'), C(13, 's')]],
      ['ストレート', '数字が5枚連続（マークはバラバラ）', [C(4, 'c'), C(5, 'd'), C(6, 'h'), C(7, 's'), C(8, 'c')]],
      ['スリーカード', '同じ数字が3枚', [C(12, 's'), C(12, 'h'), C(12, 'd'), C(7, 'c'), C(2, 'h')]],
      ['ツーペア', 'ペアが2組', [C(11, 's'), C(11, 'h'), C(4, 'd'), C(4, 'c'), C(9, 's')]],
      ['ワンペア', 'ペアが1組', [C(14, 's'), C(14, 'd'), C(8, 'c'), C(6, 'h'), C(3, 's')]],
      ['ハイカード', '役なし。一番高い数字で勝負', [C(14, 's'), C(11, 'd'), C(8, 'h'), C(5, 'c'), C(2, 'd')]],
    ];
    list.forEach(([name, desc, cards], i) => {
      const row = el('div', 'hr-row' + (i === 0 ? ' top' : ''));
      row.appendChild(el('div', 'hr-rank', String(i + 1)));
      const info = el('div', 'hr-info');
      info.appendChild(el('div', 'hr-name', name));
      info.appendChild(el('div', 'hr-desc', desc));
      row.appendChild(info);
      const cs = el('div', 'hr-cards');
      cards.forEach((c) => cs.appendChild(cardEl(c, 'mini')));
      row.appendChild(cs);
      wrap.appendChild(row);
    });
  }

  // ================= 音のON/OFF =================
  const btnSound = $('#btn-sound');
  function updateSoundIcon() { btnSound.textContent = Sound.isEnabled() ? '🔊' : '🔇'; }
  updateSoundIcon();
  btnSound.addEventListener('click', () => {
    Sound.setEnabled(!Sound.isEnabled());
    updateSoundIcon();
    if (Sound.isEnabled()) { Sound.ensure(); Sound.play('turn'); }
    toast(Sound.isEnabled() ? '🔊 音: ON' : '🔇 音: OFF');
  });
  $('#btn-reset-stats').addEventListener('click', () => {
    if (state.hostId !== state.youId) return toast('リセットはホストのみ可能です', true);
    if (!confirm('勝敗推移をリセットしますか？以降の損益は現在のチップを基準に計算されます。')) return;
    socket.emit('stats:reset', {}, (res) => { if (res.ok) { toast('成績をリセットしました'); } else toast(res.error, true); });
  });

  function renderStats() {
    renderLeaderboard();
    if (!$('#tab-graph').hidden) renderChart();
  }

  function renderLeaderboard() {
    const lb = $('#leaderboard');
    lb.innerHTML = '';
    state.standings.forEach((p, i) => {
      const row = el('div', 'lb-row');
      row.appendChild(el('div', 'lb-rank', String(i + 1)));
      const name = el('div', 'lb-name', p.name + (p.id === state.youId ? ' <span class="you-badge">(あなた)</span>' : ''));
      row.appendChild(name);
      row.appendChild(el('div', 'lb-chips', fmt(p.chips) + ' chip'));
      const netCls = p.net > 0 ? 'net-pos' : (p.net < 0 ? 'net-neg' : 'net-zero');
      row.appendChild(el('div', 'lb-net ' + netCls, (p.net > 0 ? '+' : '') + fmt(p.net)));
      lb.appendChild(row);
    });

    // ホスト向けチップ追加ボタン
    if (state.hostId === state.youId) {
      const bustPlayers = state.players.filter((p) => p.chips <= 0);
      if (bustPlayers.length) {
        const note = el('div', 'stats-note', 'チップ切れのプレイヤーにチップを追加できます:');
        lb.appendChild(note);
        bustPlayers.forEach((p) => {
          const b = el('button', 'btn btn-block', `${p.name} に ${fmt(state.config.startingChips)} 追加`);
          b.style.marginTop = '8px';
          b.addEventListener('click', () => socket.emit('player:rebuy', { playerId: p.id, amount: state.config.startingChips }, (res) => { if (!res.ok) toast(res.error, true); else toast('チップを追加しました'); }));
          lb.appendChild(b);
        });
      }
    }
  }

  function renderChart() {
    const chart = $('#chart');
    const legend = $('#chart-legend');
    chart.innerHTML = ''; legend.innerHTML = '';
    const history = state.history || [];
    if (history.length < 2) {
      chart.appendChild(el('div', 'chart-empty', 'ハンドが進むと、ここにチップ推移が表示されます。'));
      return;
    }

    const players = state.players;
    const W = 400, H = 240, pad = { l: 44, r: 12, t: 12, b: 24 };
    const xs = history.map((h) => h.hand);
    const allVals = [];
    for (const h of history) for (const p of players) allVals.push(h.stacks[p.id] ?? 0);
    let minY = Math.min(...allVals), maxY = Math.max(...allVals);
    if (minY === maxY) { minY -= 10; maxY += 10; }
    const padY = (maxY - minY) * 0.1; minY -= padY; maxY += padY;
    const minX = Math.min(...xs), maxX = Math.max(...xs);

    const X = (v) => pad.l + (maxX === minX ? 0.5 : (v - minX) / (maxX - minX)) * (W - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - minY) / (maxY - minY)) * (H - pad.t - pad.b);

    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="チップ推移グラフ">`;
    // グリッド線 + Y軸ラベル
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const val = minY + (maxY - minY) * (i / ticks);
      const y = Y(val);
      svg += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#333849" stroke-width="1"/>`;
      svg += `<text x="${pad.l - 6}" y="${y + 3}" fill="#6b7180" font-size="9" text-anchor="end">${fmt(Math.round(val))}</text>`;
    }
    // 各プレイヤーの折れ線
    players.forEach((p, idx) => {
      const color = PALETTE[idx % PALETTE.length];
      let d = '';
      history.forEach((h, i) => {
        const v = h.stacks[p.id];
        if (v === undefined) return;
        d += (d ? ' L' : 'M') + X(h.hand) + ',' + Y(v);
      });
      if (d) svg += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      // 最終点
      const last = history[history.length - 1];
      if (last.stacks[p.id] !== undefined) {
        svg += `<circle cx="${X(last.hand)}" cy="${Y(last.stacks[p.id])}" r="3" fill="${color}"/>`;
      }
    });
    svg += `</svg>`;
    chart.innerHTML = svg;

    players.forEach((p, idx) => {
      const item = el('div', 'legend-item');
      const sw = el('span', 'legend-swatch'); sw.style.background = PALETTE[idx % PALETTE.length];
      item.appendChild(sw); item.appendChild(document.createTextNode(p.name));
      legend.appendChild(item);
    });
  }

  // ================= ルームコードのコピー =================
  $('#room-code-chip').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.code); toast('ルームコードをコピーしました'); }
    catch { toast('コード: ' + state.code); }
  });

  // ================= ユーティリティ =================
  function fmt(n) { return (n || 0).toLocaleString('ja-JP'); }

  // 初期表示は connect ハンドラ（auth:status の結果）で決定する。
})();
