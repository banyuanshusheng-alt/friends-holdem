import { io } from 'socket.io-client';
const CODE = process.argv[2] || 'U3RG';
const NAME = process.argv[3] || 'ボブ';
const PID = 'bot_' + Math.random().toString(36).slice(2, 8);
const s = io(process.env.URL || 'http://localhost:3000', { transports: ['websocket'] });
s.on('connect', () => s.emit('room:join', { playerId: PID, name: NAME, code: CODE }, (r) => console.log('join', JSON.stringify(r))));
s.on('room:state', (st) => {
  const g = st.game;
  if (!g || st.state !== 'playing' || g.toActId !== PID) return;
  const legal = g.legal;
  if (!legal || !legal.actions) return;
  const action = legal.actions.includes('check') ? 'check' : (legal.actions.includes('call') ? 'call' : 'fold');
  setTimeout(() => s.emit('game:action', { action }, () => {}), 500);
});
console.log('bot', NAME, PID, '->', CODE);
