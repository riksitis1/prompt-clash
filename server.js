const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
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
// AI Init (Groq — free, OpenAI-compatible API)
// ============================================================
const GROQ_KEY = process.env.GROQ_API_KEY || null;
if (GROQ_KEY) console.log('Groq API key found, enabling AI judge (llama-3.3-70b-versatile)');
else console.log('No Groq API key — battles will use fallback results');
const openai = GROQ_KEY ? new OpenAI({ apiKey: GROQ_KEY, baseURL: 'https://api.groq.com/openai/v1' }) : null;
const battleCache = new Map();

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
    phase: type === 'private' ? 'genre_select' : 'waiting',
    genre: null,
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
    battleLog: room.battleLog.map(e => ({ ...e, eloChange: e.eloChange ? { ...e.eloChange } : undefined })),
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

function findOpenPublicRoom() {
  for (const room of rooms.values()) {
    if (room.type === 'public' && room.phase === 'waiting' && !room.p2) {
      return room;
    }
  }
  return null;
}

// ============================================================
// User data helpers (backed by JSON file)
// ============================================================

function findUserByUsername(username) {
  const users = loadUsers();
  return Object.entries(users).find(([, u]) => u.username.toLowerCase() === username.toLowerCase());
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
  room.roundTimer = setTimeout(async () => {
    if (room.phase !== 'submitting') return;
    const p1Late = !room.p1.ready;
    const p2Late = !room.p2.ready;
    if (p1Late) { room.p1.hp = Math.max(0, room.p1.hp - 20); room.p1.entity = '(timed out)'; room.p1.ready = true; }
    if (p2Late) { room.p2.hp = Math.max(0, room.p2.hp - 20); room.p2.entity = '(timed out)'; room.p2.ready = true; }
    if (p1Late || p2Late) {
      room.lastEntityP1 = room.p1.entity; room.lastEntityP2 = room.p2.entity;
      room.p1.emoji = p1Late ? '⏰' : '✅'; room.p2.emoji = p2Late ? '⏰' : '✅';
      const logEntry = {
        round: ++room.currentRound, winner: 'none', winnerUsername: '', loserUsername: '',
        player1Emoji: room.p1.emoji, player2Emoji: room.p2.emoji,
        p1Entity: room.lastEntityP1, p2Entity: room.lastEntityP2,
        damage: p1Late ? 20 : 0, counterDamage: p2Late ? 20 : 0,
        winnerHp: room.p1.hp, loserHp: room.p2.hp,
        description: p1Late && p2Late ? 'Both players ran out of time! Each takes 20 damage.' : (p1Late ? `${room.p1.username} ran out of time and takes 20 damage.` : `${room.p2.username} ran out of time and takes 20 damage.`),
      };
      room.battleLog.push(logEntry);
      room.p1.entity = null; room.p2.entity = null;
      room.p1.ready = false; room.p2.ready = false;
      room.p1.entityHidden = true; room.p2.entityHidden = true;
      if (room.p1.hp <= 0 || room.p2.hp <= 0) {
        const winner = room.p1.hp > 0 ? room.p1 : room.p2;
        const loser = room.p1.hp > 0 ? room.p2 : room.p1;
      room.phase = 'game_over';
      clearTimeout(room.advanceTimer);
      await updateEloAfterGame(room, winner, loser);
      return;
      }
      room.phase = 'round_result';
      clearTimeout(room.advanceTimer);
      room.advanceTimer = setTimeout(() => {
        if (room.phase === 'game_over') return;
        room.phase = 'submitting'; startRoundTimer(room);
      }, AUTO_ADVANCE_DELAY);
    } else {
      resolveBattle(room);
    }
  }, ROUND_TIMEOUT);
}

// ============================================================
// AI BATTLE RESOLUTION (Groq)
// ============================================================

async function resolveBattle(room) {
  room.phase = 'resolving';
  const genre = room.genre;
  const e1 = room.p1.entity;
  const e2 = room.p2.entity;

  const cacheKey = `${genre}::${e1}::${e2}`;
  if (battleCache.has(cacheKey)) {
    const log = await applyBattleResult(room, battleCache.get(cacheKey));
    room.battleLog.push(log);
    if (room.phase === 'game_over') return;
    advanceAfterResolve(room);
    return;
  }

  const prompt = `You are an AI battle judge for the genre "${genre}".

Player 1 submitted: "${e1}"
Player 2 submitted: "${e2}"

Return ONLY valid JSON (no markdown, no extra text). This will be parsed programmatically:

{
  "winner": "player1" or "player2" or "tie",
  "player1Emoji": "single emoji representing entity1",
  "player2Emoji": "single emoji representing entity2",
  "damage": <integer 0-40>,
  "counterDamage": <integer 0-20>,
   "description": "1 punchy sentence (8-15 words) describing the action"
}

STRICT RULES:
- ENTITY VALIDATION: Each entity MUST be a real, coherent concept or thing. If an entity is gibberish, nonsense, a random phrase (like "bradar what is this"), or not an actual thing, DISQUALIFY that player: they lose, take 40 damage, deal 0 counter-damage, and the description should be humorously dismissive.
- GENRE CHECK: If an entity does NOT clearly belong to the "${genre}" genre, DISQUALIFY that player: they lose, take 40 damage, deal 0 counter-damage, and the description should be humorously dismissive.
- NSFW / INAPPROPRIATE CONTENT: If an entity contains sexual, violent, hateful, or otherwise inappropriate content, IMMEDIATELY DISQUALIFY that player: they lose, take 40 damage, deal 0 counter-damage, and the description must say their submission was inappropriate and removed. Set player1Emoji to "🔞" for that player. NEVER describe the inappropriate content in the description — just say it was inappropriate.
- TIES: If both entities are equally matched (same power level, identical, or neither clearly beats the other), set winner to "tie", damage to 0, and counterDamage to 0. Example: cat vs cat is a tie.
- POWER DIFFERENCE: If one entity is only slightly stronger than the other, keep damage low (10-15) and counterDamage 0-5. If there's a clear power gap, damage can be 16-30. Disqualifications use 40.
- EMOJIS: Pick a single creative emoji that best represents each entity. For example, "dragon" → "🐉", "water droplet" → "💧", "laser gun" → "🔫".
- "damage" is dealt TO the loser by the winner. "counterDamage" is dealt TO the winner by the loser.
- Be creative, thematic, and fair.`;

  let data;
  if (openai) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const completion = await openai.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are an AI battle judge. Always respond in valid JSON. Keep descriptions short but vivid (8-15 words, 1 sentence). No stories.' },
            { role: 'user', content: prompt }
          ],
          response_format: { type: 'json_object' }
        });
        const text = completion.choices[0].message.content;
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        data = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
        break;
      } catch (err) {
        const isQuota = err.status === 429 || (err.message && err.message.includes('429'));
        const delay = isQuota ? 15000 : 1000;
        console.error(`Groq attempt ${attempt + 1} failed${isQuota ? ' (quota)' : ''}:`, err.message || err);
        if (attempt < 2) await new Promise(r => setTimeout(r, delay));
        else data = { winner: ['player1', 'player2', 'tie'][Math.floor(Math.random() * 3)], player1Emoji: '⚔️', player2Emoji: '⚔️', damage: 20, counterDamage: 10, description: 'The AI judge is unavailable. Fate decides the outcome.' };
      }
    }
  } else {
    data = { winner: ['player1', 'player2', 'tie'][Math.floor(Math.random() * 3)], player1Emoji: '⚔️', player2Emoji: '⚔️', damage: 20, counterDamage: 10, description: 'With no AI judge available, the battle is decided by fate.' };
  }

  cacheBattleResult(cacheKey, data);
  const logEntry = await applyBattleResult(room, data);
  room.battleLog.push(logEntry);
  if (room.phase === 'game_over') return;
  advanceAfterResolve(room);
}

function cacheBattleResult(key, data) {
  if (battleCache.size > 200) battleCache.clear();
  battleCache.set(key, data);
}

async function applyBattleResult(room, data) {
  const isTie = data.winner === 'tie';
  const damage = isTie ? 0 : Math.min(40, Math.max(1, data.damage || 10));
  const counterDamage = isTie ? 0 : Math.min(20, Math.max(0, data.counterDamage || 0));

  room.p1.emoji = data.player1Emoji || '❓';
  room.p2.emoji = data.player2Emoji || '❓';
  room.lastEntityP1 = room.p1.entity;
  room.lastEntityP2 = room.p2.entity;

  if (isTie) {
    return {
      round: ++room.currentRound, winner: 'tie', winnerUsername: '', loserUsername: '',
      player1Emoji: data.player1Emoji || '❓', player2Emoji: data.player2Emoji || '❓',
      p1Entity: room.lastEntityP1, p2Entity: room.lastEntityP2,
      damage: 0, counterDamage: 0, winnerHp: room.p1.hp, loserHp: room.p2.hp,
      description: data.description || 'A perfectly matched battle! Neither prevails.',
    };
  }

  const p1Wins = data.winner === 'player1';
  const loser = p1Wins ? room.p2 : room.p1;
  const winner = p1Wins ? room.p1 : room.p2;
  loser.hp -= damage;
  winner.hp -= counterDamage;
  if (loser.hp < 0) loser.hp = 0;
  if (winner.hp < 0) winner.hp = 0;

  const logEntry = {
    round: ++room.currentRound, winner: p1Wins ? 'player1' : 'player2',
    winnerUsername: winner.username, loserUsername: loser.username,
    player1Emoji: data.player1Emoji || '❓', player2Emoji: data.player2Emoji || '❓',
    p1Entity: room.lastEntityP1, p2Entity: room.lastEntityP2,
    damage, counterDamage, winnerHp: winner.hp, loserHp: loser.hp,
    description: data.description || 'An epic battle ensued!',
  };
  // Censor entities disqualified for NSFW/inappropriate content (40 damage, 0 counter)
  const loserDisqualified = damage >= 40 && counterDamage === 0;
  const winnerDisqualified = counterDamage >= 40 && damage === 0;
  if (loserDisqualified || data.player1Emoji === '🔞' || data.player2Emoji === '🔞') {
    if ((p1Wins && loserDisqualified) || data.player2Emoji === '🔞') logEntry.p2Entity = '[REDACTED]';
    if ((!p1Wins && loserDisqualified) || data.player1Emoji === '🔞') logEntry.p1Entity = '[REDACTED]';
    if (winnerDisqualified) { if (p1Wins) logEntry.p1Entity = '[REDACTED]'; else logEntry.p2Entity = '[REDACTED]'; }
  }

  if (loser.hp <= 0) {
    room.phase = 'game_over';
    clearTimeout(room.roundTimer);
    clearTimeout(room.advanceTimer);
    await updateEloAfterGame(room, winner, loser);
    room.p1.entity = null; room.p2.entity = null;
    room.p1.ready = false; room.p2.ready = false;
    room.p1.entityHidden = true; room.p2.entityHidden = true;
  }

  return logEntry;
}

function advanceAfterResolve(room) {
  if (room.phase === 'game_over') return;
  room.p1.entity = null; room.p2.entity = null;
  room.p1.ready = false; room.p2.ready = false;
  room.p1.entityHidden = true; room.p2.entityHidden = true;
  room.phase = 'round_result';
  clearTimeout(room.advanceTimer);
  room.advanceTimer = setTimeout(() => {
    if (room.phase === 'game_over') return;
    room.phase = 'submitting';
    startRoundTimer(room);
  }, AUTO_ADVANCE_DELAY);
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
    // Attach elo change to last battle log entry
    if (room.battleLog.length > 0) {
      room.battleLog[room.battleLog.length - 1].eloChange = room.eloChange;
    }
  } catch (e) { console.error('Elo update error:', e); }
}

// ============================================================
// ROUTES
// ============================================================

// --- Auth: Register ---
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || typeof username !== 'string' || username.trim().length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
  if (!password || typeof password !== 'string' || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const cleanUsername = username.trim();
  try {
    if (findUserByUsername(cleanUsername)) return res.status(409).json({ error: 'Username already taken' });
    const uid = uuidv4();
    const hash = bcrypt.hashSync(password, 10);
    createUser(uid, cleanUsername, hash);
    const token = jwt.sign({ uid, username: cleanUsername }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, uid, username: cleanUsername });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// --- Auth: Login ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !username.trim() || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const cleanUsername = username.trim();
    const entry = findUserByUsername(cleanUsername);
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

// --- Public Match: Find ---
app.post('/api/find-match', async (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  // Use JWT username (survives data file resets); elo from DB with fallback
  const username = user.username || 'Player';
  const userData = await getUserData(user.uid);
  const elo = userData.elo || 1000;
  // Check if already in an active room (skip finished games)
  for (const room of rooms.values()) {
    if ((room.p1?.userId === user.uid || room.p2?.userId === user.uid) && room.phase !== 'game_over') {
      return res.json({ roomCode: room.code });
    }
  }
  // Clean up any stale rooms where this user was (game_over or abandoned)
  for (const [code, room] of rooms) {
    if ((room.p1?.userId === user.uid || room.p2?.userId === user.uid) && room.phase === 'game_over') {
      rooms.delete(code);
    }
  }
  // Find an open room, or create one
  let room = findOpenPublicRoom();
  if (room) {
    room.p2 = { userId: user.uid, username, elo, hp: 100, entity: null, ready: false, entityHidden: true, emoji: null };
    room.genre = GENRES[Math.floor(Math.random() * GENRES.length)];
    room.phase = 'submitting';
    room.turnStartTime = Date.now();
    startRoundTimer(room);
  } else {
    room = createRoom('public', { userId: user.uid, username, elo });
  }
  res.json({ roomCode: room.code });
});

// --- Room: Create Private ---
app.post('/api/create-room', async (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const username = user.username || 'Player';
  const userData = await getUserData(user.uid);
  const elo = userData.elo || 1000;
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
  const username = user.username || 'Player';
  const userData = await getUserData(user.uid);
  const elo = userData.elo || 1000;
  room.p2 = { userId: user.uid, username, elo, hp: 100, entity: null, ready: false, entityHidden: true, emoji: null };
  room.phase = 'genre_select';
  res.json({ success: true });
});

// --- Room: Leave (abandon any room) ---
app.post('/api/leave-room', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  for (const [code, room] of rooms.entries()) {
    if (room.p1?.userId === user.uid || room.p2?.userId === user.uid) {
      clearTimeout(room.roundTimer); clearTimeout(room.advanceTimer);
      rooms.delete(code);
      return res.json({ success: true });
    }
  }
  res.json({ success: true });
});

// --- Public Match: Cancel ---
app.post('/api/cancel-match', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  for (const [code, room] of rooms.entries()) {
    if (room.p1?.userId === user.uid && !room.p2) {
      clearTimeout(room.roundTimer); clearTimeout(room.advanceTimer);
      rooms.delete(code);
      return res.json({ success: true });
    }
  }
  res.json({ success: true });
});

// --- Room: My Active ---
app.get('/api/my-active-room', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
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
app.get('/api/health', (req, res) => res.json({ status: 'ok', ai: !!openai }));

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Prompt Clash server running on port ${PORT}`);
  console.log(`  AI judge: ${openai ? 'enabled (llama-3.3-70b via Groq)' : 'NOT configured (set GROQ_API_KEY)'}`);
  console.log(`  Users stored at: ${USERS_FILE}`);
});
