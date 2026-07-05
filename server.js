const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'prompt-clash-dev-secret-key-change-in-production';
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// ============================================================
// FILE STORE — persists user data to data/users.json
// ============================================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}', 'utf-8');

let usersCache = null;
function loadUsers() {
  if (usersCache) return usersCache;
  try { usersCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')); return usersCache; }
  catch { usersCache = {}; return usersCache; }
}

function saveUsers(users) {
  usersCache = users;
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

// ============================================================
// Gemini Init
// ============================================================
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;
const model = genAI ? genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' }) : null;

// ============================================================
// Express Setup
// ============================================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================================
// In-Memory State (rooms are ephemeral — not saved to disk)
// ============================================================
const rooms = new Map();
const matchQueue = [];
const matchedMap = {};
const GENRES = ['Animals', 'Machines', 'Mythical Creatures', 'Elements', 'Cosmic'];
const ROUND_TIMEOUT = 30000;
const AUTO_ADVANCE_DELAY = 6000;
const ELO_K = 48;

// ============================================================
// HELPERS
// ============================================================

function verifyToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try { return jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
  catch { return null; }
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function createRoom(type, p1Data) {
  const code = generateRoomCode();
  const room = {
    code, type,
    phase: type === 'private' ? 'genre_select' : 'submitting',
    genre: type === 'public' ? GENRES[Math.floor(Math.random() * GENRES.length)] : null,
    p1: { ...p1Data, hp: 100, entity: null, ready: false, entityHidden: true, emoji: null },
    p2: null,
    currentRound: 0,
    battleLog: [],
    roundTimer: null, advanceTimer: null,
    lastEntityP1: null, lastEntityP2: null,
    turnStartTime: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function avatarColor(str) {
  if (!str) return '#6366f1';
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 60%, 50%)`;
}

function sanitizeRoom(room, uid) {
  if (!room) return null;
  const isP1 = room.p1?.userId === uid;
  const isP2 = room.p2?.userId === uid;
  const mySide = isP1 ? 'p1' : isP2 ? 'p2' : null;
  const oppSide = isP1 ? 'p2' : isP2 ? 'p1' : null;
  const opponent = oppSide ? room[oppSide] : null;
  return {
    code: room.code, type: room.type, phase: room.phase, genre: room.genre,
    currentRound: room.currentRound,
    battleLog: room.battleLog.map(e => ({ ...e })),
    turnStartTime: room.turnStartTime,
    me: mySide ? {
      side: mySide, userId: room[mySide].userId, username: room[mySide].username,
      hp: room[mySide].hp, elo: room[mySide].elo, ready: room[mySide].ready,
      entityHidden: room[mySide].entityHidden, avatarColor: avatarColor(room[mySide].username),
    } : null,
    opponent: opponent ? {
      side: oppSide, userId: opponent.userId, username: opponent.username,
      hp: opponent.hp, elo: opponent.elo, ready: opponent.ready,
      entityHidden: opponent.entityHidden, avatarColor: avatarColor(opponent.username),
    } : null,
  };
}

function calculateElo(ratingA, ratingB, winA) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return {
    newA: Math.round(ratingA + ELO_K * ((winA ? 1 : 0) - expectedA)),
    newB: Math.round(ratingB + ELO_K * (((winA ? 0 : 1)) - (1 - expectedA))),
  };
}

function checkMatchmaking(userId) {
  let matched = null;
  while (matchQueue.length >= 2) {
    const p1 = matchQueue.shift();
    const p2 = matchQueue.shift();
    const room = createRoom('public', { userId: p1.userId, username: p1.username, elo: p1.elo });
    room.p2 = { userId: p2.userId, username: p2.username, elo: p2.elo, hp: 100, entity: null, ready: false, entityHidden: true, emoji: null };
    matchedMap[p1.userId] = room.code;
    matchedMap[p2.userId] = room.code;
    room.phase = 'submitting';
    startRoundTimer(room);
    if (p1.userId === userId || p2.userId === userId) matched = room;
  }
  return matched;
}

// ============================================================
// User data helpers (backed by JSON file)
// ============================================================

function findUserByUsername(username) {
  const users = loadUsers();
  return Object.entries(users).find(([, u]) => u.username === username);
}

function getUserById(uid) {
  const users = loadUsers();
  return users[uid] || null;
}

function createUser(uid, username, hash) {
  const users = loadUsers();
  users[uid] = { username, password: hash, elo: 1000, gamesPlayed: 0, gamesWon: 0 };
  saveUsers(users);
}

function updateUserElo(uid, eloDelta) {
  const users = loadUsers();
  if (users[uid]) {
    users[uid].elo = eloDelta.newElo;
    users[uid].gamesPlayed = (users[uid].gamesPlayed || 0) + 1;
    if (eloDelta.isWinner) users[uid].gamesWon = (users[uid].gamesWon || 0) + 1;
    saveUsers(users);
  }
}

async function getUserProfile(uid) {
  const user = getUserById(uid);
  if (!user) return null;
  const { password, ...safe } = user;
  return { uid, ...safe, avatarColor: avatarColor(safe.username) };
}

async function getUserData(uid) {
  const user = getUserById(uid);
  if (user) return { username: user.username, elo: user.elo || 1000 };
  return { username: 'Player', elo: 1000 };
}

// ============================================================
// TIMER
// ============================================================

function startRoundTimer(room) {
  clearTimeout(room.roundTimer);
  room.turnStartTime = Date.now();
  room.roundTimer = setTimeout(() => {
    if (room.phase !== 'submitting') return;
    if (!room.p1.ready) { room.p1.entity = '(disqualified - timeout)'; room.p1.ready = true; }
    if (!room.p2.ready) { room.p2.entity = '(disqualified - timeout)'; room.p2.ready = true; }
    resolveBattle(room);
  }, ROUND_TIMEOUT);
}

// ============================================================
// GEMINI BATTLE RESOLUTION
// ============================================================

async function resolveBattle(room) {
  room.phase = 'resolving';
  const genre = room.genre;
  const e1 = room.p1.entity;
  const e2 = room.p2.entity;

  const prompt = `You are an AI battle judge for the genre "${genre}".

Player 1 submitted: "${e1}"
Player 2 submitted: "${e2}"

Evaluate this conceptual battle. Return ONLY valid JSON (no markdown, no extra text):

{
  "winner": "player1" or "player2",
  "player1Emoji": "single emoji representing entity1",
  "player2Emoji": "single emoji representing entity2",
  "damage": <integer 10-40>,
  "counterDamage": <integer 0-20>,
  "description": "2-3 sentence vivid battle narration"
}

RULES:
- If an entity does NOT belong to the "${genre}" genre, DISQUALIFY that player: they lose, take 40 damage, deal 0 counter-damage, and the description should be humorously dismissive.
- "damage" is dealt TO the loser by the winner.
- "counterDamage" is dealt TO the winner by the loser (representing a last strike).
- Be creative and thematic.`;

  try {
    let data;
    if (model) {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      data = JSON.parse(cleaned);
    } else {
      data = { winner: Math.random() < 0.5 ? 'player1' : 'player2', player1Emoji: '⚔️', player2Emoji: '⚔️', damage: 20, counterDamage: 10, description: 'With no AI judge available, the battle is decided by fate.' };
    }

    const p1Wins = data.winner === 'player1';
    const loser = p1Wins ? room.p2 : room.p1;
    const winner = p1Wins ? room.p1 : room.p2;
    const damage = Math.min(40, Math.max(10, data.damage));
    const counterDamage = Math.min(20, Math.max(0, data.counterDamage));

    loser.hp -= damage;
    winner.hp -= counterDamage;
    if (loser.hp < 0) loser.hp = 0;
    if (winner.hp < 0) winner.hp = 0;

    room.p1.emoji = data.player1Emoji || '❓';
    room.p2.emoji = data.player2Emoji || '❓';
    room.lastEntityP1 = room.p1.entity;
    room.lastEntityP2 = room.p2.entity;

    const logEntry = {
      round: ++room.currentRound,
      winner: p1Wins ? 'player1' : 'player2',
      winnerUsername: winner.username, loserUsername: loser.username,
      player1Emoji: data.player1Emoji || '❓', player2Emoji: data.player2Emoji || '❓',
      p1Entity: room.lastEntityP1, p2Entity: room.lastEntityP2,
      damage, counterDamage, winnerHp: winner.hp, loserHp: loser.hp,
      description: data.description || 'An epic battle ensued!',
    };
    room.battleLog.push(logEntry);

    room.p1.entity = null; room.p2.entity = null;
    room.p1.ready = false; room.p2.ready = false;
    room.p1.entityHidden = true; room.p2.entityHidden = true;

    if (loser.hp <= 0) {
      room.phase = 'game_over';
      clearTimeout(room.roundTimer);
      clearTimeout(room.advanceTimer);
      await updateEloAfterGame(room, winner, loser);
      return;
    }

    room.phase = 'round_result';
    clearTimeout(room.advanceTimer);
    room.advanceTimer = setTimeout(() => {
      if (room.phase === 'game_over') return;
      room.phase = 'submitting';
      startRoundTimer(room);
    }, AUTO_ADVANCE_DELAY);
  } catch (err) {
    console.error('Gemini error:', err);
    const logEntry = {
      round: ++room.currentRound, winner: 'player1',
      winnerUsername: room.p1.username, loserUsername: room.p2.username,
      player1Emoji: '⚔️', player2Emoji: '⚔️',
      p1Entity: room.p1.entity, p2Entity: room.p2.entity,
      damage: 20, counterDamage: 10, winnerHp: room.p1.hp - 10, loserHp: room.p2.hp - 20,
      description: 'The AI judge encountered an error. Both sides exchange inconclusive blows.',
    };
    room.p1.hp -= 10; room.p2.hp -= 20;
    if (room.p1.hp < 0) room.p1.hp = 0;
    if (room.p2.hp < 0) room.p2.hp = 0;
    room.battleLog.push(logEntry);
    room.p1.entity = null; room.p2.entity = null;
    room.p1.ready = false; room.p2.ready = false;
    room.phase = 'round_result';
    clearTimeout(room.advanceTimer);
    room.advanceTimer = setTimeout(() => {
      if (room.phase === 'game_over') return;
      room.phase = 'submitting';
      startRoundTimer(room);
    }, AUTO_ADVANCE_DELAY);
  }
}

// ============================================================
// ELO UPDATE
// ============================================================

async function updateEloAfterGame(room, winner, loser) {
  try {
    const wUser = getUserById(winner.userId);
    const lUser = getUserById(loser.userId);
    const wElo = wUser ? wUser.elo : 1000;
    const lElo = lUser ? lUser.elo : 1000;
    const result = calculateElo(wElo, lElo, true);
    updateUserElo(winner.userId, { newElo: result.newA, isWinner: true });
    updateUserElo(loser.userId, { newElo: result.newB, isWinner: false });
    room.eloChange = {
      winner: { username: winner.username, oldElo: wElo, newElo: result.newA },
      loser: { username: loser.username, oldElo: lElo, newElo: result.newB },
    };
  } catch (e) { console.error('Elo update error:', e); }
}

// ============================================================
// ROUTES
// ============================================================

// --- Auth: Register ---
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  try {
    if (findUserByUsername(username)) return res.status(409).json({ error: 'Username already taken' });
    const uid = uuidv4();
    const hash = bcrypt.hashSync(password, 10);
    createUser(uid, username, hash);
    const token = jwt.sign({ uid, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, uid, username });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// --- Auth: Login ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const entry = findUserByUsername(username);
    if (!entry) return res.status(401).json({ error: 'Invalid username or password' });
    const [uid, userData] = entry;
    if (!bcrypt.compareSync(password, userData.password)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = jwt.sign({ uid, username: userData.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, uid, username: userData.username });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// --- Auth: Get Profile ---
app.get('/api/profile', async (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const profile = await getUserProfile(user.uid);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    res.json(profile);
  } catch (e) {
    console.error('Profile error:', e);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// --- Queue: Join ---
app.post('/api/join-queue', async (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { username, elo } = await getUserData(user.uid);
  if (matchQueue.find(u => u.userId === user.uid)) return res.json({ status: 'already_in_queue' });
  matchQueue.push({ userId: user.uid, username, elo, joinedAt: Date.now() });
  const room = checkMatchmaking(user.uid);
  if (room) return res.json({ status: 'matched', roomCode: room.code });
  res.json({ status: 'queued' });
});

// --- Queue: Leave ---
app.post('/api/leave-queue', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const idx = matchQueue.findIndex(u => u.userId === user.uid);
  if (idx >= 0) matchQueue.splice(idx, 1);
  delete matchedMap[user.uid];
  res.json({ success: true });
});

// --- Queue: Status ---
app.get('/api/queue-status', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (matchedMap[user.uid]) {
    const code = matchedMap[user.uid];
    delete matchedMap[user.uid];
    return res.json({ status: 'matched', roomCode: code });
  }
  const idx = matchQueue.findIndex(u => u.userId === user.uid);
  if (idx >= 0) return res.json({ status: 'queued', position: idx + 1 });
  res.json({ status: 'none' });
});

// --- Room: Create Private ---
app.post('/api/create-room', async (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { username, elo } = await getUserData(user.uid);
  const room = createRoom('private', { userId: user.uid, username, elo });
  res.json({ roomCode: room.code });
});

// --- Room: Join Private ---
app.post('/api/join-room', async (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });
  const room = rooms.get(code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.p2) return res.status(400).json({ error: 'Room is full' });
  if (room.p1.userId === user.uid) return res.status(400).json({ error: 'Cannot join your own room' });
  const { username, elo } = await getUserData(user.uid);
  room.p2 = { userId: user.uid, username, elo, hp: 100, entity: null, ready: false, entityHidden: true, emoji: null };
  room.phase = 'genre_select';
  res.json({ success: true });
});

// --- Room: My Active ---
app.get('/api/my-active-room', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (matchedMap[user.uid]) {
    const code = matchedMap[user.uid];
    delete matchedMap[user.uid];
    return res.json({ code });
  }
  for (const room of rooms.values()) {
    if (room.p1?.userId === user.uid || room.p2?.userId === user.uid) {
      return res.json({ code: room.code });
    }
  }
  res.status(404).json({ error: 'No active room' });
});

// --- Game: Lock Genre ---
app.post('/api/lock-genre', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code, genre } = req.body;
  const room = rooms.get(code?.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.p1.userId !== user.uid) return res.status(403).json({ error: 'Only the host can lock genre' });
  if (!GENRES.includes(genre)) return res.status(400).json({ error: 'Invalid genre' });
  room.genre = genre;
  room.phase = 'submitting';
  startRoundTimer(room);
  res.json({ success: true });
});

// --- Game: Random Genre ---
app.get('/api/random-genre', (req, res) => {
  res.json({ genre: GENRES[Math.floor(Math.random() * GENRES.length)] });
});

// --- Game: Submit Entity ---
app.post('/api/submit-entity', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code, entity } = req.body;
  if (!entity || !entity.trim()) return res.status(400).json({ error: 'Entity is required' });
  const room = rooms.get(code?.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.phase !== 'submitting') return res.status(400).json({ error: 'Not in submission phase' });
  const isP1 = room.p1.userId === user.uid;
  const isP2 = room.p2?.userId === user.uid;
  if (!isP1 && !isP2) return res.status(403).json({ error: 'Not in this room' });
  if (isP1) {
    if (room.p1.ready) return res.status(400).json({ error: 'Already submitted' });
    room.p1.entity = entity.trim(); room.p1.ready = true; room.p1.entityHidden = false;
  } else {
    if (room.p2.ready) return res.status(400).json({ error: 'Already submitted' });
    room.p2.entity = entity.trim(); room.p2.ready = true; room.p2.entityHidden = false;
  }
  if (room.p1.ready && room.p2.ready) { clearTimeout(room.roundTimer); resolveBattle(room); }
  res.json({ success: true });
});

// --- Game: Get State ---
app.get('/api/game-state/:code', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const room = rooms.get(req.params.code?.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isP1 = room.p1?.userId === user.uid;
  const isP2 = room.p2?.userId === user.uid;
  if (!isP1 && !isP2) return res.status(403).json({ error: 'Not in this room' });
  res.json(sanitizeRoom(room, user.uid));
});

// --- Health Check ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', gemini: !!model }));

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Prompt Clash server running on port ${PORT}`);
  console.log(`  Gemini: ${model ? 'configured' : 'NOT configured (set GEMINI_API_KEY)'}`);
  console.log(`  Users stored at: ${USERS_FILE}`);
});
