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
  let finishCelebrated = false;

  // 通算タブの3本立てランキング切替（points=王者 / bounty=賞金王 / kos=ハンター）
  let seasonBoard = 'points';

  // オールイン成立後のライブ演出（ボードを1枚ずつめくりながら勝率更新）
  let runoutState = null;   // 演出中: { board:[card...], eq:{id:pct}|null }
  let runoutHand = -1;      // 演出済みハンド番号
  let runoutTimer = null;

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
      ko: () => { blip(150, 0, 0.22, { type: 'sawtooth', vol: 0.16, sweep: 60 }); [880, 1320].forEach((f, i) => blip(f, 0.12 + i * 0.08, 0.18, { type: 'triangle', vol: 0.14 })); chip(0.12, 4); },
      badbeat: () => { [415, 349, 294, 233].forEach((f, i) => blip(f, i * 0.19, 0.26, { type: 'sawtooth', vol: 0.13, sweep: f * 0.9 })); }, // 下降＝がっかり音
    };
    function play(name) { if (!enabled) return; ensure(); if (!ctx) return; (sounds[name] || (() => {}))(); }

    // ===== BGM（MP3ファイル /bgm.mp3 をループ再生）=====
    let bgmAudio = null, bgmWanted = false;
    function bgmEl() {
      if (!bgmAudio) {
        bgmAudio = new Audio('/bgm.mp3');
        bgmAudio.loop = true;
        bgmAudio.volume = 0.35;
        bgmAudio.preload = 'auto';
      }
      return bgmAudio;
    }
    function bgmRun() { // 条件が揃えば再生（ジェスチャ前は失敗しうる→次のタップで再試行）
      if (!enabled || !bgmWanted) return;
      bgmEl().play().catch(() => {});
    }
    function bgmHalt() { if (bgmAudio) bgmAudio.pause(); }
    function startBGM() { bgmWanted = true; bgmRun(); }  // 入室時
    function stopBGM() { bgmWanted = false; bgmHalt(); if (bgmAudio) { try { bgmAudio.currentTime = 0; } catch (e) {} } } // 退出時

    function setEnabled(v) {
      enabled = v; localStorage.setItem('holdem_sound', v ? 'on' : 'off');
      if (v) { ensure(); bgmRun(); } else bgmHalt(); // ミュートは bgmWanted を保持
    }
    function isEnabled() { return enabled; }
    return { play, setEnabled, isEnabled, ensure, startBGM, stopBGM, bgmRun };
  })();
  // ユーザー操作のたびにオーディオ有効化＋BGM再生を試みる（ブラウザの自動再生制約対策）
  function audioKick() { Sound.ensure(); Sound.bgmRun(); }
  document.addEventListener('click', audioKick);
  document.addEventListener('touchstart', audioKick);

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

  // モード選択（シーズン戦／クイックマッチ）
  let selectedMode = 'season';
  const modePicker = $('#mode-picker');
  if (modePicker) {
    modePicker.querySelectorAll('.mode-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedMode = btn.dataset.mode;
        modePicker.querySelectorAll('.mode-opt').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
  }

  $('#btn-create').addEventListener('click', () => {
    const name = $('#name').value.trim();
    if (!name) return toast('名前を入力してください', true);
    saveName(name);
    const config = {
      startingChips: Number($('#cfg-chips').value) || 1000,
      sb: Number($('#cfg-sb').value) || 10,
      bb: Number($('#cfg-bb').value) || 20,
      levelSeconds: Number($('#cfg-level').value) || 0,
      mode: selectedMode,
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
    if (Sound.isEnabled()) Sound.startBGM();
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
    Sound.stopBGM();
    showHome();
    socket.disconnect(); socket.connect();
  });

  // ================= サーバー状態受信 =================
  socket.on('room:state', (s) => {
    state = s;
    maybeStartRunout();
    render();
  });

  // handover に入り allinRunout があれば、ボードを段階的にめくる演出を開始
  function maybeStartRunout() {
    const g = state.game;
    const runout = g && g.result && g.result.allinRunout;
    // 演出対象でない状態に移ったら演出をリセット
    if (state.state !== 'handover' || !runout) {
      if (runoutState) { runoutState = null; clearTimeout(runoutTimer); }
      return;
    }
    if (runoutHand === state.handNumber) return;   // このハンドは演出済み
    if (firstEffect) return;                       // 入室/リロード直後は即結果表示
    runoutHand = state.handNumber;
    celebratedHand = state.handNumber;             // 通常演出は演出終了時に手動発火
    startRunout(runout, g.result.community, g.result);
  }

  function startRunout(runout, fullBoard, result) {
    clearTimeout(runoutTimer);
    const steps = runout.steps || [];
    let i = 0;
    let prevLen = -1;
    const tick = () => {
      if (i >= steps.length) {
        runoutState = null;               // 全札公開＝本来の結果表示に戻す
        render();
        const badBeat = maybeBadBeat(result);
        if (!badBeat) celebrate(result);
        if (state.lastKOs && state.lastKOs.length) showKOBanner(state.lastKOs);
        return;
      }
      const step = steps[i];
      runoutState = { board: fullBoard.slice(0, step.len), eq: step.eq };
      if (step.len > prevLen && prevLen >= 0) Sound.play('deal'); // 新しい札が出た時だけ
      prevLen = step.len;
      render();
      i++;
      runoutTimer = setTimeout(tick, 1400);
    };
    tick();
  }

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
    updateBlindClock();
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
      const badBeat = maybeBadBeat(g.result);
      if (!badBeat) celebrate(g.result); // 通常の勝利バナーはバッドビートが無い時のみ
      if (state.lastKOs && state.lastKOs.length) showKOBanner(state.lastKOs);
    }
    // トーナメント決着の演出（1回だけ）
    if (state.finished && !finishCelebrated) {
      finishCelebrated = true;
      const champ = (state.finalRanking || []).find((x) => x.place === 1);
      Sound.play(champ && champ.id === state.youId ? 'youwin' : 'win');
    } else if (!state.finished) {
      finishCelebrated = false;
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

  let koBannerTimer;
  function showKOBanner(kos) {
    Sound.play('ko');
    const youKO = kos.some((k) => k.koerId === state.youId);
    const b = $('#ko-banner');
    b.className = 'ko-banner' + (youKO ? ' you' : '');
    b.innerHTML = `<div class="kb-inner">
      <div class="kb-title">🎯 KO!</div>
      ${kos.map((k) => `<div class="kb-line"><b>${esc(k.koerName)}</b> が <b>${esc(k.bustedName)}</b> を撃破 <span class="kb-amt">+${fmt(k.amount)}</span></div>`).join('')}
    </div>`;
    b.hidden = false;
    clearTimeout(koBannerTimer);
    koBannerTimer = setTimeout(() => { b.hidden = true; }, 3000);
  }

  // オールインで高勝率だったのに負けた＝バッドビート
  function maybeBadBeat(result) {
    const aeq = result.allinEquity;
    if (!aeq || !aeq.eq) return false;
    const entries = Object.entries(aeq.eq).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return false;
    const [favId, favPct] = entries[0];
    const favP = result.players.find((p) => p.id === favId);
    const favWon = favP && favP.won > 0;
    if (favPct >= 75 && favP && !favWon) { showBadBeat(favP.name, favPct); return true; }
    return false;
  }

  let badBeatTimer;
  function showBadBeat(name, pct) {
    Sound.play('badbeat');
    const b = $('#badbeat-banner');
    b.innerHTML = `<div class="bb2-inner">
      <div class="bb2-title">😱 BAD BEAT</div>
      <div class="bb2-line"><b>${esc(name)}</b> が <b class="bb2-pct">${pct}%</b> から敗北…</div>
    </div>`;
    b.hidden = false;
    clearTimeout(badBeatTimer);
    badBeatTimer = setTimeout(() => { b.hidden = true; }, 3400);
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

      // 大きめのアバターを主役に（名前は出さない：顔で「今こいつの番だ」が分かる）
      const av = el('div', 'seat-avatar' + (p.id === state.youId ? ' you' : ''));
      av.style.setProperty('--char-color', charById(p.char).color);
      const aimg = document.createElement('img'); aimg.src = charImg(p.char); aimg.alt = p.name; aimg.title = p.name;
      av.appendChild(aimg);
      if (gs && gs.isDealer) av.appendChild(el('span', 'dealer-badge', 'D'));
      if (p.id === state.youId) av.appendChild(el('span', 'you-tag', 'あなた'));
      seat.appendChild(av);

      // チップと状態タグ
      const info = el('div', 'seat-info');
      const inLobby = state.state === 'lobby' || state.state === 'finished';
      const season = state.config && state.config.mode === 'season';
      if (inLobby && season) {
        // 卓外（集合中・決着後）は持ち金（口座）を主表示
        info.appendChild(el('div', 'seat-chips', `🏦${fmt(p.bankroll || 0)}`));
      } else {
        info.appendChild(el('div', 'seat-chips', fmt(p.chips)));
        // 対局中も口座を小さく併記（シーズン戦のみ）
        if (season) info.appendChild(el('div', 'seat-bank', `🏦${fmt(p.bankroll || 0)}`));
      }
      const resultPlayer = state.game && state.game.result
        ? state.game.result.players.find((rp) => rp.id === p.id) : null;
      const animating = !!runoutState; // 演出中は勝敗を伏せる
      const won = resultPlayer && resultPlayer.won > 0;
      const place = state.places && state.places[p.id];
      if (animating) {
        // めくり演出中：オールイン札とライブ勝率だけ表示（勝者/順位は伏せる）
        if (gs && gs.allIn) info.appendChild(el('span', 'seat-tag tag-allin', 'ALL IN'));
      } else if (place && p.chips <= 0) {
        // トーナメント脱落：順位バッジ
        seat.classList.add('eliminated');
        info.appendChild(el('span', 'seat-tag tag-place', place + '位'));
      } else if (won) { seat.classList.add('winner'); info.appendChild(el('span', 'seat-tag tag-win', `+${fmt(resultPlayer.won)}`)); }
      else if (gs && gs.allIn) info.appendChild(el('span', 'seat-tag tag-allin', 'ALL IN'));
      else if (!gs && state.state !== 'lobby' && state.state !== 'finished') info.appendChild(el('span', 'seat-tag tag-off', p.sittingOut ? '見学' : (p.chips <= 0 ? 'チップ切れ' : '待機')));
      if (!p.connected) info.appendChild(el('span', 'seat-tag tag-out', 'オフライン'));
      const kos = state.koCounts && state.koCounts[p.id];
      if (!animating && kos > 0) info.appendChild(el('span', 'seat-tag tag-ko', `🎯${kos}`));
      // オールイン時の勝率（演出中はライブ更新、それ以外はショーダウン結果値）
      if (animating) {
        if (runoutState.eq && runoutState.eq[p.id] != null && resultPlayer && !resultPlayer.folded) {
          info.appendChild(el('span', 'seat-tag tag-eq', `🎲${runoutState.eq[p.id]}%`));
        }
      } else {
        const aeq = state.game && state.game.result && state.game.result.allinEquity;
        if (aeq && aeq.eq && aeq.eq[p.id] != null && resultPlayer && !resultPlayer.folded) {
          info.appendChild(el('span', 'seat-tag tag-eq', `🎲${aeq.eq[p.id]}%`));
        }
      }
      if (!animating && resultPlayer && resultPlayer.revealed && resultPlayer.hand) {
        info.appendChild(el('div', 'seat-hand', resultPlayer.hand.category));
      }
      seat.appendChild(info);

      // ベット額チップ
      if (gs && gs.streetBet > 0) {
        seat.appendChild(el('div', 'seat-bet', fmt(gs.streetBet)));
      }
      container.appendChild(seat);
    });
  }

  function renderBoard() {
    const lc = $('#lobby-center');
    const pot = $('#pot');
    const community = $('#community');
    const msg = $('#board-msg');

    // トーナメント決着：最終順位を中央に表示
    if (state.finished) {
      lc.hidden = false; pot.hidden = true; community.hidden = true; msg.hidden = true;
      renderFinalRanking();
      return;
    }
    // ロビー（開始前）は集合カードを中央に表示
    if (state.state === 'lobby') {
      lc.hidden = false; pot.hidden = true; community.hidden = true; msg.hidden = true;
      renderLobbyCenter();
      return;
    }
    lc.hidden = true; pot.hidden = false; community.hidden = false; msg.hidden = false;

    community.innerHTML = '';
    const g = state.game;
    // 演出中はめくり途中のボードを表示、それ以外は実際の場札
    const board = runoutState ? runoutState.board : (g && g.community ? g.community : []);
    board.forEach((c) => community.appendChild(cardEl(c)));

    if (g && g.totalPot > 0) pot.innerHTML = `POT <b>${fmt(g.totalPot)}</b>`;
    else pot.innerHTML = '';

    if (runoutState) msg.textContent = '🔥 オールイン勝負！';
    else if (!g) msg.textContent = '';
    else if (g.result) msg.textContent = resultMessage(g.result);
    else msg.textContent = streetName(g.street);
  }

  function renderLobbyCenter() {
    const lc = $('#lobby-center');
    const count = state.players.length;
    const need = Math.max(0, 2 - count);
    const isHost = state.hostId === state.youId;
    const quick = state.config && state.config.mode === 'quick';
    lc.innerHTML = `
      <div class="lc-badge">● メンバー集合中</div>
      <div class="lc-mode ${quick ? 'quick' : 'season'}">${quick ? '⚡ クイックマッチ（記録なし）' : '🏆 シーズン戦（記録あり）'}</div>
      <button id="lc-code" class="lc-code" type="button">
        <span class="lc-code-label">ROOM CODE</span>
        <span class="lc-code-val">${state.code}</span>
        <span class="lc-code-copy">⧉ タップで招待メッセージをコピー</span>
      </button>
      <div class="lc-count">👥 ${count}人が集合${need > 0 ? `　<span class="lc-need">あと${need}人でスタート可</span>` : ''}</div>
      ${!quick ? `<div class="lc-econ">🏦 持ち金 ${fmt(state.bankrollStart || 0)}　｜　🎫 バイイン ${fmt(state.buyIn || (state.config && state.config.startingChips) || 0)}／回</div>` : ''}
      <div class="lc-hint">${isHost ? '2人以上そろったら下の「ゲーム開始」を押そう' : 'ホストの開始を待っています…'}</div>
    `;
    const btn = lc.querySelector('#lc-code');
    if (btn) btn.addEventListener('click', shareRoom);
  }

  function renderFinalRanking() {
    const lc = $('#lobby-center');
    const r = state.finalRanking || [];
    const champ = r.find((x) => x.place === 1);
    const medal = (pl) => (pl === 1 ? '🥇' : pl === 2 ? '🥈' : pl === 3 ? '🥉' : pl + '位');
    lc.innerHTML = `
      <div class="fr-crown">🏆</div>
      <div class="fr-title">${champ ? esc(champ.name) + ' 優勝！' : 'トーナメント終了'}</div>
      <div class="fr-list">
        ${r.map((x) => {
          const gain = (x.prize || 0) + (x.bounty || 0); // このトーナメントの獲得（賞金＋バウンティ）
          return `
          <div class="fr-row${x.place === 1 ? ' champ' : ''}">
            <span class="fr-place">${medal(x.place)}</span>
            <span class="fr-av" style="border-color:${charById(x.char).color}"><img src="${charImg(x.char)}" alt=""></span>
            <span class="fr-name">${esc(x.name)}${x.id === state.youId ? ' <span class="you-badge">(あなた)</span>' : ''}${x.kos > 0 ? ` <span class="fr-ko">🎯${x.kos}</span>` : ''}</span>
            <span class="fr-money">
              <span class="fr-gain">${gain > 0 ? '💰+' + fmt(gain) : '—'}</span>
              <span class="fr-bank">🏦${fmt(x.bankroll || 0)}</span>
            </span>
          </div>`;
        }).join('')}
      </div>
      <div class="fr-note">💰=このトーナメントの獲得（賞金＋バウンティ）／🏦=持ち金（口座）</div>`;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  async function shareRoom() {
    const url = location.origin;
    const text = `🃏 ポーカーやろう！\nリンク: ${url}\nルームコード: ${state.code}\n（合い言葉も忘れずに伝えてね）`;
    if (navigator.share) {
      try { await navigator.share({ title: '仲間内ホールデム', text }); return; } catch (e) { /* キャンセル時など */ }
    }
    try { await navigator.clipboard.writeText(text); toast('招待メッセージをコピーしました'); }
    catch { toast('ルームコード: ' + state.code); }
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

    // --- トーナメント決着後 ---
    if (state.finished) {
      const wrap = el('div', 'lobby-bar');
      if (isHost) {
        const btn = el('button', 'btn btn-primary btn-block', '🏆 新しいトーナメント');
        btn.addEventListener('click', () => socket.emit('game:newtourney', {}, (res) => { if (!res.ok) toast(res.error, true); }));
        wrap.appendChild(btn);
      } else {
        wrap.appendChild(el('div', 'waiting-note', 'ホストが新しいトーナメントを始めるのを待っています…'));
      }
      bar.appendChild(wrap);
      return;
    }

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

  // ================= ブラインド時計 =================
  let clockInterval = null;
  function updateBlindClock() {
    const bc = $('#blind-clock');
    const hl = $('#hand-label');
    const active = state && state.levelSeconds > 0 && state.levelEndsAt;
    if (!active) { bc.hidden = true; hl.hidden = false; return; }
    hl.hidden = true; bc.hidden = false;
    const remain = Math.max(0, Math.round((state.levelEndsAt - Date.now()) / 1000));
    const mm = Math.floor(remain / 60), ss = String(remain % 60).padStart(2, '0');
    const warn = remain <= 15 ? ' bc-warn' : '';
    bc.innerHTML = `<b>Lv.${state.level + 1}</b> ${fmt(state.blinds.sb)}/${fmt(state.blinds.bb)} <span class="bc-time${warn}">⏱${mm}:${ss}</span>`;
    if (!clockInterval) clockInterval = setInterval(updateBlindClock, 1000);
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
      $('#tab-season').hidden = which !== 'season';
      $('#tab-graph').hidden = which !== 'graph';
      if (which === 'graph') renderChart();
      if (which === 'season') renderSeasonStandings();
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
    toast(Sound.isEnabled() ? '🔊 音・BGM: ON' : '🔇 音・BGM: OFF');
  });
  $('#btn-reset-stats').addEventListener('click', () => {
    if (state.hostId !== state.youId) return toast('リセットはホストのみ可能です', true);
    if (!confirm('勝敗推移をリセットしますか？以降の損益は現在のチップを基準に計算されます。')) return;
    socket.emit('stats:reset', {}, (res) => { if (res.ok) { toast('成績をリセットしました'); } else toast(res.error, true); });
  });

  function renderStats() {
    renderLeaderboard();
    if (!$('#tab-graph').hidden) renderChart();
    if (!$('#tab-season').hidden) renderSeasonStandings();
  }

  const SEASON_BOARDS = {
    points: { icon: '👑', label: '王者', key: 'points', unit: 'pt', fmtVal: (v) => fmt(v) },
    bounty: { icon: '💰', label: '賞金王', key: 'bankroll', unit: '', fmtVal: (v) => fmt(v) },
    kos: { icon: '🎯', label: 'ハンター', key: 'kos', unit: 'KO', fmtVal: (v) => String(v) },
  };

  function renderSeasonStandings() {
    const wrap = $('#season-list');
    wrap.innerHTML = '';
    if (state.config && state.config.mode === 'quick') {
      wrap.appendChild(el('div', 'chart-empty', '⚡ クイックマッチでは通算成績・対戦記録・スタイルは残りません。記録を残すには「シーズン戦」で部屋を作成してください。'));
      return;
    }
    const s = state.seasonStandings || [];
    if (!s.length) {
      wrap.appendChild(el('div', 'chart-empty', 'トーナメントが終わると、ここに通算成績（王者・賞金王・ハンター）が貯まります。'));
      return;
    }
    // 切替タブ（3本立て＋対戦）
    const tabs = el('div', 'ss-boards');
    Object.entries(SEASON_BOARDS).forEach(([id, b]) => {
      const t = el('button', 'ss-board-tab' + (seasonBoard === id ? ' active' : ''), `${b.icon}${b.label}`);
      t.addEventListener('click', () => { seasonBoard = id; renderSeasonStandings(); });
      tabs.appendChild(t);
    });
    const rt = el('button', 'ss-board-tab' + (seasonBoard === 'rivalry' ? ' active' : ''), '⚔️対戦');
    rt.addEventListener('click', () => { seasonBoard = 'rivalry'; renderSeasonStandings(); });
    tabs.appendChild(rt);
    const yt = el('button', 'ss-board-tab' + (seasonBoard === 'style' ? ' active' : ''), '📈スタイル');
    yt.addEventListener('click', () => { seasonBoard = 'style'; renderSeasonStandings(); });
    tabs.appendChild(yt);
    wrap.appendChild(tabs);

    if (seasonBoard === 'rivalry') {
      renderRivalry(wrap, s);
    } else if (seasonBoard === 'style') {
      renderPlayStyles(wrap);
    } else {
      const board = SEASON_BOARDS[seasonBoard] || SEASON_BOARDS.points;
      const ranked = [...s].sort((a, b) => (b[board.key] - a[board.key]) || (b.points - a.points) || (b.wins - a.wins));
      ranked.forEach((p, i) => {
        const row = el('div', 'ss-row' + (i === 0 ? ' top' : ''));
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);
        row.appendChild(el('div', 'lb-rank', medal));
        const av = el('span', 'ss-av'); av.style.borderColor = charById(p.char).color;
        const img = document.createElement('img'); img.src = charImg(p.char); img.alt = ''; av.appendChild(img);
        row.appendChild(av);
        const info = el('div', 'ss-info');
        info.appendChild(el('div', 'ss-name', esc(p.name) + (p.id === state.youId ? ' <span class="you-badge">(あなた)</span>' : '')));
        info.appendChild(el('div', 'ss-sub', `🏦${fmt(p.bankroll || 0)} ・ 👑${fmt(p.points)}pt ・ 🎯${p.kos} ・ 🏆${p.wins}回 ・ ${p.played}戦`));
        row.appendChild(info);
        const val = board.fmtVal(p[board.key] || 0);
        row.appendChild(el('div', 'ss-pts', val + (board.unit ? `<span>${board.unit}</span>` : '')));
        wrap.appendChild(row);
      });
    }
    if (state.hostId === state.youId) {
      const b = el('button', 'btn btn-danger btn-block', '通算成績をリセット');
      b.style.marginTop = '14px';
      b.addEventListener('click', () => {
        if (!confirm('通算成績（ポイント・賞金・対戦記録すべて）をリセットしますか？')) return;
        socket.emit('season:reset', {}, (r) => { if (r.ok) toast('通算成績をリセットしました'); else toast(r.error, true); });
      });
      wrap.appendChild(b);
    }
  }

  // 対戦相手別戦績（KO対戦表から 天敵/カモ を割り出す）
  function renderRivalry(wrap, standings) {
    const mtx = state.koMatrix || {};
    // id -> {name,char}（現メンバー優先、無ければ通算成績から）
    const meta = {};
    (state.players || []).forEach((p) => { meta[p.id] = { name: p.name, char: p.char }; });
    standings.forEach((p) => { if (!meta[p.id]) meta[p.id] = { name: p.name, char: p.char }; });
    const nameOf = (id) => (meta[id] ? meta[id].name : '?');
    const charOf = (id) => (meta[id] ? meta[id].char : 'haru');

    const anyKO = Object.values(mtx).some((row) => Object.keys(row || {}).length);
    if (!anyKO) {
      wrap.appendChild(el('div', 'chart-empty', 'まだKOがありません。トーナメントで誰かを飛ばすと、天敵・カモの記録が貯まります。'));
      return;
    }

    const you = state.youId;
    // あなたのカモ（あなたが最も飛ばした相手）
    const myKOs = mtx[you] || {};
    let preyId = null, preyN = 0;
    for (const [bid, n] of Object.entries(myKOs)) if (n > preyN) { preyN = n; preyId = bid; }
    // あなたの天敵（あなたを最も飛ばした相手）
    let nemId = null, nemN = 0;
    for (const [koer, row] of Object.entries(mtx)) {
      const n = (row && row[you]) || 0;
      if (n > nemN) { nemN = n; nemId = koer; }
    }
    const card = (cls, tag, id, n, verb) => {
      const c = el('div', 'rv-card ' + cls);
      if (id) {
        c.innerHTML = `<div class="rv-tag">${tag}</div>
          <div class="rv-face" style="border-color:${charById(charOf(id)).color}"><img src="${charImg(charOf(id))}" alt=""></div>
          <div class="rv-name">${esc(nameOf(id))}</div>
          <div class="rv-count">${verb} <b>${n}</b> 回</div>`;
      } else {
        c.innerHTML = `<div class="rv-tag">${tag}</div><div class="rv-none">まだいない</div>`;
      }
      return c;
    };
    const cards = el('div', 'rv-cards');
    cards.appendChild(card('nemesis', '😱 天敵', nemId, nemN, '飛ばされた'));
    cards.appendChild(card('prey', '🍖 カモ', preyId, preyN, '飛ばした'));
    wrap.appendChild(cards);

    // 全員のKO対戦表（行=飛ばした人／列=飛ばされた人）
    const ids = Array.from(new Set([
      ...Object.keys(mtx),
      ...Object.values(mtx).flatMap((r) => Object.keys(r || {})),
    ]));
    if (ids.length) {
      wrap.appendChild(el('div', 'rv-mtx-title', 'KO対戦表（横：飛ばした人 → 縦：飛ばされた人）'));
      const table = el('table', 'rv-mtx');
      const head = el('tr');
      head.appendChild(el('th', 'rv-corner', '＼'));
      ids.forEach((id) => head.appendChild(el('th', '', `<img src="${charImg(charOf(id))}" alt="${esc(nameOf(id))}" title="${esc(nameOf(id))}">`)));
      table.appendChild(head);
      ids.forEach((rowId) => {
        const tr = el('tr');
        tr.appendChild(el('th', 'rv-rowh', `<img src="${charImg(charOf(rowId))}" alt="${esc(nameOf(rowId))}" title="${esc(nameOf(rowId))}">`));
        ids.forEach((colId) => {
          const n = (mtx[rowId] && mtx[rowId][colId]) || 0;
          const td = el('td', n > 0 ? 'hit' : (rowId === colId ? 'diag' : ''), rowId === colId ? '—' : (n || ''));
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      wrap.appendChild(table);
    }
  }

  // プレイスタイル（VPIP/PFR%）。ルース/タイト・アグレ/パッシブを判定して表示。
  function styleTag(vpip, pfr) {
    const loose = vpip >= 40 ? 'ルース' : (vpip <= 22 ? 'タイト' : '標準');
    const aggr = vpip > 0 && pfr / vpip >= 0.6 ? 'アグレ' : 'パッシブ';
    if (vpip === 0) return { text: '鉄壁', cls: 'st-tight' };
    return { text: `${loose}・${aggr}`, cls: loose === 'ルース' ? 'st-loose' : (loose === 'タイト' ? 'st-tight' : 'st-mid') };
  }
  function renderPlayStyles(wrap) {
    const rows = state.playStyles || [];
    if (!rows.length || rows.every((r) => !r.hands)) {
      wrap.appendChild(el('div', 'chart-empty', 'ハンドを重ねると、各プレイヤーの傾向（VPIP＝参加率／PFR＝プリフロップレイズ率）が見えてきます。'));
      return;
    }
    wrap.appendChild(el('div', 'rv-mtx-title', 'VPIP＝プリフロップ参加率／PFR＝プリフロップレイズ率（高いほど積極的）'));
    rows.forEach((p) => {
      const row = el('div', 'st-row');
      const av = el('span', 'ss-av'); av.style.borderColor = charById(p.char).color;
      const img = document.createElement('img'); img.src = charImg(p.char); img.alt = ''; av.appendChild(img);
      row.appendChild(av);
      const info = el('div', 'st-info');
      const tag = styleTag(p.vpip, p.pfr);
      info.appendChild(el('div', 'st-name', `${esc(p.name)}${p.id === state.youId ? ' <span class="you-badge">(あなた)</span>' : ''} <span class="st-tag ${tag.cls}">${tag.text}</span>`));
      const bar = (label, val, cls) => `
        <div class="st-metric">
          <span class="st-lbl">${label}</span>
          <span class="st-track"><span class="st-fill ${cls}" style="width:${Math.min(100, val)}%"></span></span>
          <span class="st-val">${val}%</span>
        </div>`;
      const bars = el('div', 'st-bars');
      bars.innerHTML = bar('VPIP', p.vpip, 'vpip') + bar('PFR', p.pfr, 'pfr');
      info.appendChild(bars);
      info.appendChild(el('div', 'st-sub', `${p.hands}ハンド${p.hands < 15 ? '（サンプル少）' : ''}`));
      row.appendChild(info);
      wrap.appendChild(row);
    });
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
