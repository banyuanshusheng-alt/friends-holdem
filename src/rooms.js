// ルームの生成・検索・掃除
import { Room } from './room.js';

const rooms = new Map(); // code -> Room
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(I,O,0,1)を除外

function genCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

export function createRoom(config) {
  const code = genCode();
  const room = new Room(code, config);
  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get((code || '').toUpperCase());
}

// 一定時間アクティビティのない空/放置部屋を掃除
export function cleanupRooms() {
  const now = Date.now();
  const TTL = 1000 * 60 * 60 * 6; // 6時間
  for (const [code, room] of rooms) {
    const noone = room.players.every((p) => !p.connected);
    if (noone && now - room.lastActivity > 1000 * 60 * 30) {
      rooms.delete(code); // 全員切断30分で削除
    } else if (now - room.lastActivity > TTL) {
      rooms.delete(code);
    }
  }
}

export function roomCount() { return rooms.size; }
