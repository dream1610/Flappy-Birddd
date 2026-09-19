import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const PORT = 3000;
const app = express();
app.use(express.json());

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface StoredUser {
  id: string;
  username: string;
  salt: string;
  hash: string;
  token?: string;
  highScore: number;
  coins: number;
  gamesPlayed: number;
  wins: number;
  dailyStreak: number;
  lastClaimDate: string | null;
  avatarColor: string;
  jetSkin: 'classic' | 'stealth' | 'golden' | 'crimson' | 'cyber';
  unlockedSkins: string[];
  createdAt: string;
}

interface DatabaseSchema {
  users: Record<string, StoredUser>;
  usernameToId: Record<string, string>;
  chatHistory: Array<{
    id: string;
    senderId: string;
    senderName: string;
    text: string;
    time: string;
    roomCode?: string;
  }>;
}

// Initial seed users for global leaderboard
function getDefaultDatabase(): DatabaseSchema {
  const seedUsers: DatabaseSchema = {
    users: {},
    usernameToId: {},
    chatHistory: [
      {
        id: 'msg_welcome',
        senderId: 'system',
        senderName: 'Hệ Thống',
        text: 'Chào mừng các cơ trưởng đến với Flappy Jet Alamabu! Hãy cẩn thận với các tòa cao ốc!',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }
    ],
  };

  const initialPilots = [
    { username: 'TopGun_Viet', score: 86, wins: 42, skin: 'golden', color: '#f59e0b' },
    { username: 'SkyAce_99', score: 72, wins: 28, skin: 'stealth', color: '#10b981' },
    { username: 'Alamabu_Master', score: 65, wins: 35, skin: 'crimson', color: '#ef4444' },
    { username: 'PhiCongSieuDang', score: 54, wins: 19, skin: 'cyber', color: '#06b6d4' },
    { username: 'BaoTapTrenKhong', score: 48, wins: 15, skin: 'classic', color: '#3b82f6' },
    { username: 'ChimSat_VN', score: 39, wins: 11, skin: 'classic', color: '#8b5cf6' },
    { username: 'TocDoAnhSang', score: 31, wins: 8, skin: 'stealth', color: '#ec4899' },
  ];

  for (const pilot of initialPilots) {
    const id = `pilot_${pilot.username.toLowerCase()}`;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword('123456', salt);
    seedUsers.users[id] = {
      id,
      username: pilot.username,
      salt,
      hash,
      highScore: pilot.score,
      coins: pilot.score * 50,
      gamesPlayed: pilot.wins * 3 + 10,
      wins: pilot.wins,
      dailyStreak: 3,
      lastClaimDate: new Date().toISOString(),
      avatarColor: pilot.color,
      jetSkin: pilot.skin as any,
      unlockedSkins: ['classic', pilot.skin],
      createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
    };
    seedUsers.usernameToId[pilot.username.toLowerCase()] = id;
  }

  return seedUsers;
}

// Load or initialize DB
let db: DatabaseSchema;
try {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } else {
    db = getDefaultDatabase();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
} catch (e) {
  db = getDefaultDatabase();
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('Failed to save DB:', err);
  }
}

// Password hashing helper
function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function sanitizeUser(u: StoredUser) {
  const { salt, hash, ...safe } = u;
  return safe;
}

function getLeaderboard() {
  return Object.values(db.users)
    .sort((a, b) => b.highScore - a.highScore || b.wins - a.wins)
    .slice(0, 50)
    .map((u, index) => ({
      rank: index + 1,
      username: u.username,
      highScore: u.highScore,
      wins: u.wins,
      gamesPlayed: u.gamesPlayed,
      jetSkin: u.jetSkin,
      avatarColor: u.avatarColor,
    }));
}

// REST API Endpoints

// 1. Auth Register
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Tên người dùng và mật khẩu là bắt buộc.' });
  }

  const cleanName = String(username).trim();
  if (cleanName.length < 3 || cleanName.length > 20) {
    return res.status(400).json({ error: 'Tên người dùng phải từ 3 đến 20 ký tự.' });
  }

  if (!/^[a-zA-Z0-9_]+$/.test(cleanName)) {
    return res.status(400).json({ error: 'Tên chỉ chứa chữ cái, số và dấu gạch dưới (_).' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự.' });
  }

  const lowerName = cleanName.toLowerCase();
  if (db.usernameToId[lowerName]) {
    return res.status(409).json({ error: 'Tên người dùng này đã tồn tại, vui lòng chọn tên khác.' });
  }

  const id = `user_${crypto.randomUUID()}`;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const token = crypto.randomBytes(32).toString('hex');

  const avatarColors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];
  const avatarColor = avatarColors[Math.floor(Math.random() * avatarColors.length)];

  const newUser: StoredUser = {
    id,
    username: cleanName,
    salt,
    hash,
    token,
    highScore: 0,
    coins: 200, // Welcome gift
    gamesPlayed: 0,
    wins: 0,
    dailyStreak: 0,
    lastClaimDate: null,
    avatarColor,
    jetSkin: 'classic',
    unlockedSkins: ['classic'],
    createdAt: new Date().toISOString(),
  };

  db.users[id] = newUser;
  db.usernameToId[lowerName] = id;
  saveDb();

  res.json({
    user: sanitizeUser(newUser),
    token,
  });
});

// 2. Auth Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu.' });
  }

  const lowerName = String(username).trim().toLowerCase();
  const userId = db.usernameToId[lowerName];
  if (!userId || !db.users[userId]) {
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
  }

  const user = db.users[userId];
  const testHash = hashPassword(password, user.salt);
  if (testHash !== user.hash) {
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
  }

  // Create new session token
  const token = crypto.randomBytes(32).toString('hex');
  user.token = token;
  saveDb();

  res.json({
    user: sanitizeUser(user),
    token,
  });
});

// 3. Auth Me
app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }

  const user = Object.values(db.users).find((u) => u.token === token);
  if (!user) {
    return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn' });
  }

  res.json({ user: sanitizeUser(user) });
});

// 4. Daily Reward Claim
app.post('/api/daily-reward/claim', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  const user = Object.values(db.users).find((u) => u.token === token);
  if (!user) {
    return res.status(401).json({ error: 'Chưa xác thực' });
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  if (user.lastClaimDate) {
    const lastClaimStr = new Date(user.lastClaimDate).toISOString().slice(0, 10);
    if (lastClaimStr === todayStr) {
      return res.status(400).json({ error: 'Bạn đã nhận quà hôm nay rồi! Hãy quay lại vào ngày mai nhé.' });
    }

    const diffHours = (now.getTime() - new Date(user.lastClaimDate).getTime()) / (1000 * 60 * 60);
    if (diffHours < 48) {
      user.dailyStreak = (user.dailyStreak % 7) + 1;
    } else {
      user.dailyStreak = 1;
    }
  } else {
    user.dailyStreak = 1;
  }

  user.lastClaimDate = now.toISOString();

  // Tier rewards
  const tierCoins = [100, 250, 400, 600, 900, 1500, 3000];
  const rewardCoins = tierCoins[(user.dailyStreak - 1) % 7] || 200;
  user.coins += rewardCoins;

  let unlockedSkin: string | null = null;
  if (user.dailyStreak === 3 && !user.unlockedSkins.includes('stealth')) {
    user.unlockedSkins.push('stealth');
    unlockedSkin = 'stealth';
  } else if (user.dailyStreak === 5 && !user.unlockedSkins.includes('crimson')) {
    user.unlockedSkins.push('crimson');
    unlockedSkin = 'crimson';
  } else if (user.dailyStreak === 7 && !user.unlockedSkins.includes('golden')) {
    user.unlockedSkins.push('golden');
    unlockedSkin = 'golden';
  }

  saveDb();

  res.json({
    success: true,
    user: sanitizeUser(user),
    reward: {
      streak: user.dailyStreak,
      coins: rewardCoins,
      unlockedSkin,
    },
  });
});

// 5. Update Skin
app.post('/api/user/skin', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  const user = Object.values(db.users).find((u) => u.token === token);
  if (!user) return res.status(401).json({ error: 'Chưa xác thực' });

  const { skin } = req.body;
  if (!user.unlockedSkins.includes(skin)) {
    return res.status(403).json({ error: 'Bạn chưa mở khóa skin này!' });
  }

  user.jetSkin = skin;
  saveDb();
  res.json({ success: true, user: sanitizeUser(user) });
});

// 6. Leaderboard GET
app.get('/api/leaderboard', (req, res) => {
  res.json({ leaderboard: getLeaderboard() });
});

// 7. Save Offline Score
app.post('/api/game/offline-score', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  const user = Object.values(db.users).find((u) => u.token === token);
  if (!user) return res.status(401).json({ error: 'Chưa xác thực' });

  const { score } = req.body;
  const parsedScore = Math.max(0, parseInt(score, 10) || 0);

  user.gamesPlayed += 1;
  const isNewRecord = parsedScore > user.highScore;
  if (isNewRecord) {
    user.highScore = parsedScore;
  }
  user.coins += Math.floor(parsedScore * 2); // 2 coins per building passed

  saveDb();

  // Broadcast updated leaderboard
  broadcastAll('leaderboard:update', { leaderboard: getLeaderboard() });

  res.json({
    success: true,
    isNewRecord,
    user: sanitizeUser(user),
  });
});

// HTTP Server setup
const httpServer = http.createServer(app);

// WebSocket Server setup
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

interface ConnectedClient {
  ws: WebSocket;
  userId?: string;
  roomCode?: string;
}

const clients = new Map<WebSocket, ConnectedClient>();

// Online Game Rooms State
interface RoomPlayerState {
  userId: string;
  username: string;
  jetSkin: string;
  avatarColor: string;
  isReady: boolean;
  isHost: boolean;
  score: number;
  isDead: boolean;
  deathCause?: string;
  y: number;
  tilt: number;
}

interface ActiveRoom {
  code: string;
  hostId: string;
  mode: 'custom' | 'matchmaking';
  status: 'waiting' | 'starting' | 'playing' | 'finished';
  players: Record<string, RoomPlayerState>;
  maxPlayers: number;
  seed: number;
  countdown: number;
  countdownTimer?: any;
  winner?: { username: string; score: number } | null;
}

const rooms = new Map<string, ActiveRoom>();
const matchmakingQueue: string[] = []; // userIds waiting for 1v1 match

function broadcastAll(type: string, payload: any) {
  const message = JSON.stringify({ type, payload });
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

function broadcastToRoom(roomCode: string, type: string, payload: any) {
  const message = JSON.stringify({ type, payload });
  for (const [ws, client] of clients) {
    if (client.roomCode === roomCode && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

function sendToUser(userId: string, type: string, payload: any) {
  const message = JSON.stringify({ type, payload });
  for (const [ws, client] of clients) {
    if (client.userId === userId && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function cleanRoom(roomCode: string) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.countdownTimer) {
    clearInterval(room.countdownTimer);
  }
  rooms.delete(roomCode);
}

function checkAndStartMatchmaking() {
  if (matchmakingQueue.length >= 2) {
    const p1Id = matchmakingQueue.shift()!;
    const p2Id = matchmakingQueue.shift()!;

    const p1 = db.users[p1Id];
    const p2 = db.users[p2Id];

    if (!p1 || !p2) {
      return;
    }

    const roomCode = `1V1-${Math.floor(1000 + Math.random() * 9000)}`;
    const newRoom: ActiveRoom = {
      code: roomCode,
      hostId: p1Id,
      mode: 'matchmaking',
      status: 'starting',
      maxPlayers: 2,
      seed: Math.floor(Math.random() * 1000000),
      countdown: 3,
      players: {
        [p1Id]: {
          userId: p1Id,
          username: p1.username,
          jetSkin: p1.jetSkin,
          avatarColor: p1.avatarColor,
          isReady: true,
          isHost: true,
          score: 0,
          isDead: false,
          y: 250,
          tilt: 0,
        },
        [p2Id]: {
          userId: p2Id,
          username: p2.username,
          jetSkin: p2.jetSkin,
          avatarColor: p2.avatarColor,
          isReady: true,
          isHost: false,
          score: 0,
          isDead: false,
          y: 250,
          tilt: 0,
        },
      },
    };

    rooms.set(roomCode, newRoom);

    // Assign clients room code
    for (const [, client] of clients) {
      if (client.userId === p1Id || client.userId === p2Id) {
        client.roomCode = roomCode;
      }
    }

    // Notify matched players
    sendToUser(p1Id, 'matchmaking:matched', { room: newRoom, opponent: p2.username });
    sendToUser(p2Id, 'matchmaking:matched', { room: newRoom, opponent: p1.username });

    // Send push notification
    sendToUser(p1Id, 'notification:push', {
      title: 'Đã tìm thấy trận đối kháng 1v1!',
      message: `Đối thủ: ${p2.username}. Trận đấu sẽ bắt đầu ngay bây giờ!`,
      type: 'match',
    });
    sendToUser(p2Id, 'notification:push', {
      title: 'Đã tìm thấy trận đối kháng 1v1!',
      message: `Đối thủ: ${p1.username}. Trận đấu sẽ bắt đầu ngay bây giờ!`,
      type: 'match',
    });

    // Start 3-second countdown
    let count = 3;
    newRoom.countdownTimer = setInterval(() => {
      count -= 1;
      newRoom.countdown = count;
      broadcastToRoom(roomCode, 'room:countdown', { count });
      if (count <= 0) {
        clearInterval(newRoom.countdownTimer);
        newRoom.status = 'playing';
        broadcastToRoom(roomCode, 'room:start_game', { seed: newRoom.seed });
      }
    }, 1000);
  }
}

wss.on('connection', (ws) => {
  clients.set(ws, { ws });

  // Send initial chat & leaderboard
  ws.send(JSON.stringify({
    type: 'init:state',
    payload: {
      leaderboard: getLeaderboard(),
      chatHistory: db.chatHistory.slice(-30),
    },
  }));

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const { type, payload } = data;
      const client = clients.get(ws);
      if (!client) return;

      switch (type) {
        // Authenticate socket session
        case 'auth:token': {
          const user = Object.values(db.users).find((u) => u.token === payload.token);
          if (user) {
            client.userId = user.id;
            ws.send(JSON.stringify({
              type: 'auth:success',
              payload: { user: sanitizeUser(user) },
            }));
          }
          break;
        }

        // Room Creation
        case 'room:create': {
          if (!client.userId) return;
          const user = db.users[client.userId];
          if (!user) return;

          const roomCode = generateRoomCode();
          const room: ActiveRoom = {
            code: roomCode,
            hostId: user.id,
            mode: 'custom',
            status: 'waiting',
            maxPlayers: payload.maxPlayers || 6,
            seed: Math.floor(Math.random() * 1000000),
            countdown: 3,
            players: {
              [user.id]: {
                userId: user.id,
                username: user.username,
                jetSkin: user.jetSkin,
                avatarColor: user.avatarColor,
                isReady: true,
                isHost: true,
                score: 0,
                isDead: false,
                y: 250,
                tilt: 0,
              },
            },
          };

          rooms.set(roomCode, room);
          client.roomCode = roomCode;

          ws.send(JSON.stringify({
            type: 'room:created',
            payload: { room },
          }));
          break;
        }

        // Room Join
        case 'room:join': {
          if (!client.userId) return;
          const user = db.users[client.userId];
          if (!user) return;

          const code = String(payload.code || '').trim().toUpperCase();
          const room = rooms.get(code);

          if (!room) {
            ws.send(JSON.stringify({ type: 'room:error', payload: { message: 'Không tìm thấy phòng với mã này!' } }));
            return;
          }

          if (room.status === 'playing') {
            ws.send(JSON.stringify({ type: 'room:error', payload: { message: 'Trận đấu đang diễn ra, không thể tham gia!' } }));
            return;
          }

          if (Object.keys(room.players).length >= room.maxPlayers) {
            ws.send(JSON.stringify({ type: 'room:error', payload: { message: 'Phòng đã đầy người chơi!' } }));
            return;
          }

          room.players[user.id] = {
            userId: user.id,
            username: user.username,
            jetSkin: user.jetSkin,
            avatarColor: user.avatarColor,
            isReady: false,
            isHost: false,
            score: 0,
            isDead: false,
            y: 250,
            tilt: 0,
          };

          client.roomCode = code;

          // Notify all in room
          broadcastToRoom(code, 'room:player_joined', { room, newPlayer: user.username });
          broadcastToRoom(code, 'notification:push', {
            title: 'Người chơi mới đã vào phòng!',
            message: `${user.username} vừa tham gia phòng chờ!`,
            type: 'match',
          });
          break;
        }

        // Room Toggle Ready
        case 'room:ready': {
          if (!client.roomCode || !client.userId) return;
          const room = rooms.get(client.roomCode);
          if (!room || !room.players[client.userId]) return;

          room.players[client.userId].isReady = !room.players[client.userId].isReady;
          broadcastToRoom(client.roomCode, 'room:update', { room });
          break;
        }

        // Room Host Starts Game
        case 'room:start': {
          if (!client.roomCode || !client.userId) return;
          const room = rooms.get(client.roomCode);
          if (!room || room.hostId !== client.userId) return;

          room.status = 'starting';
          room.seed = Math.floor(Math.random() * 1000000);
          room.winner = null;

          // Reset all players status
          Object.values(room.players).forEach((p) => {
            p.isDead = false;
            p.score = 0;
            p.y = 250;
            p.tilt = 0;
          });

          broadcastToRoom(client.roomCode, 'room:countdown', { count: 3 });

          let count = 3;
          room.countdownTimer = setInterval(() => {
            count -= 1;
            room.countdown = count;
            broadcastToRoom(room.code, 'room:countdown', { count });

            if (count <= 0) {
              clearInterval(room.countdownTimer);
              room.status = 'playing';
              broadcastToRoom(room.code, 'room:start_game', { seed: room.seed, room });
            }
          }, 1000);
          break;
        }

        // Room Leave
        case 'room:leave': {
          if (!client.roomCode || !client.userId) return;
          const room = rooms.get(client.roomCode);
          if (!room) return;

          delete room.players[client.userId];
          const remainingIds = Object.keys(room.players);

          if (remainingIds.length === 0) {
            cleanRoom(client.roomCode);
          } else {
            if (room.hostId === client.userId) {
              room.hostId = remainingIds[0];
              room.players[remainingIds[0]].isHost = true;
              room.players[remainingIds[0]].isReady = true;
            }
            broadcastToRoom(client.roomCode, 'room:player_left', { room });
          }

          client.roomCode = undefined;
          ws.send(JSON.stringify({ type: 'room:left' }));
          break;
        }

        // Live Flight Position Sync
        case 'game:sync_pos': {
          if (!client.roomCode || !client.userId) return;
          const room = rooms.get(client.roomCode);
          if (!room || !room.players[client.userId]) return;

          const player = room.players[client.userId];
          player.y = payload.y;
          player.tilt = payload.tilt;
          player.score = payload.score;

          // Broadcast to other players in room
          for (const [otherWs, otherClient] of clients) {
            if (otherClient.roomCode === client.roomCode && otherClient.userId !== client.userId && otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify({
                type: 'game:opponent_pos',
                payload: {
                  userId: client.userId,
                  y: payload.y,
                  tilt: payload.tilt,
                  score: payload.score,
                },
              }));
            }
          }
          break;
        }

        // Plane Crashed (ALAMABU!)
        case 'game:crash': {
          if (!client.roomCode || !client.userId) return;
          const room = rooms.get(client.roomCode);
          if (!room || !room.players[client.userId]) return;

          const player = room.players[client.userId];
          player.isDead = true;
          player.score = payload.score || player.score;
          player.deathCause = payload.cause || 'Đâm vào cao ốc';

          const user = db.users[client.userId];
          if (user) {
            user.gamesPlayed += 1;
            if (player.score > user.highScore) {
              user.highScore = player.score;
            }
            user.coins += Math.floor(player.score * 2);
            saveDb();
          }

          // Broadcast player explosion to all in room
          broadcastToRoom(client.roomCode, 'game:player_crashed', {
            userId: client.userId,
            username: player.username,
            score: player.score,
          });

          // Check if match should end
          const activePlayers = Object.values(room.players).filter((p) => !p.isDead);
          const totalPlayers = Object.values(room.players);

          if (activePlayers.length <= 1 && totalPlayers.length > 1) {
            // We have a winner or all crashed
            const winner = activePlayers[0] || totalPlayers.sort((a, b) => b.score - a.score)[0];
            room.status = 'finished';
            room.winner = { username: winner.username, score: winner.score };

            // Award winner
            const winnerUser = db.users[winner.userId];
            if (winnerUser) {
              winnerUser.wins += 1;
              winnerUser.coins += 150; // Bonus for victory
              saveDb();
            }

            broadcastToRoom(client.roomCode, 'game:match_over', {
              winner: room.winner,
              room,
            });

            broadcastAll('leaderboard:update', { leaderboard: getLeaderboard() });
          } else if (totalPlayers.length === 1 && player.isDead) {
            // Solo online test
            room.status = 'finished';
            broadcastToRoom(client.roomCode, 'game:match_over', {
              winner: { username: player.username, score: player.score },
              room,
            });
          }
          break;
        }

        // Matchmaking Queue
        case 'matchmaking:join': {
          if (!client.userId) return;
          if (!matchmakingQueue.includes(client.userId)) {
            matchmakingQueue.push(client.userId);
          }
          ws.send(JSON.stringify({ type: 'matchmaking:queued' }));
          checkAndStartMatchmaking();
          break;
        }

        case 'matchmaking:cancel': {
          if (!client.userId) return;
          const idx = matchmakingQueue.indexOf(client.userId);
          if (idx !== -1) {
            matchmakingQueue.splice(idx, 1);
          }
          ws.send(JSON.stringify({ type: 'matchmaking:cancelled' }));
          break;
        }

        // Chat Message
        case 'chat:send': {
          if (!client.userId) return;
          const user = db.users[client.userId];
          if (!user) return;

          const text = String(payload.text || '').trim();
          if (!text) return;

          const msg = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            senderId: user.id,
            senderName: user.username,
            text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            roomCode: client.roomCode,
          };

          if (client.roomCode) {
            // Send to room only
            broadcastToRoom(client.roomCode, 'chat:message', msg);
          } else {
            // Global chat
            db.chatHistory.push(msg);
            if (db.chatHistory.length > 50) {
              db.chatHistory.shift();
            }
            broadcastAll('chat:message', msg);
          }
          break;
        }
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      // Remove from matchmaking queue
      if (client.userId) {
        const qIdx = matchmakingQueue.indexOf(client.userId);
        if (qIdx !== -1) matchmakingQueue.splice(qIdx, 1);
      }

      // Handle room departure
      if (client.roomCode && client.userId) {
        const room = rooms.get(client.roomCode);
        if (room) {
          delete room.players[client.userId];
          const rem = Object.keys(room.players);
          if (rem.length === 0) {
            cleanRoom(client.roomCode);
          } else {
            if (room.hostId === client.userId) {
              room.hostId = rem[0];
              room.players[rem[0]].isHost = true;
            }
            broadcastToRoom(client.roomCode, 'room:player_left', { room });
          }
        }
      }
      clients.delete(ws);
    }
  });
});

// Vite / Static Files Middleware
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Flappy Jet Alamabu Server running on port ${PORT}`);
  });
}

start();
