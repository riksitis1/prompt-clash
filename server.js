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

let saveTimeoutId = null;
let pendingUsers = null;

function saveUsers(users) {
  usersCache = users;
  pendingUsers = users;
  if (!saveTimeoutId) {
    saveTimeoutId = setTimeout(() => {
      try {
        if (pendingUsers) fs.writeFileSync(USERS_FILE, JSON.stringify(pendingUsers), 'utf-8');
      } catch (e) { console.error('Failed to save users:', e); }
      saveTimeoutId = null;
      pendingUsers = null;
    }, 3000);
  }
}

// Flush pending user writes immediately (called before shutdown)
function flushUsers() {
  if (saveTimeoutId) {
    clearTimeout(saveTimeoutId);
    saveTimeoutId = null;
  }
  if (pendingUsers) {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(pendingUsers), 'utf-8'); } catch {}
    pendingUsers = null;
  }
}

// ============================================================
// AI Init (Groq — free, OpenAI-compatible API)
// ============================================================
const AI_MODEL = 'llama-3.3-70b-versatile';

// Collect all Groq API keys (GROQ_API_KEY, GROQ_API_KEY_2, ...)
const groqKeys = [];
const primaryKey = process.env.GROQ_API_KEY;
if (primaryKey) groqKeys.push(primaryKey);
for (let i = 2; i <= 5; i++) {
  const extra = process.env[`GROQ_API_KEY_${i}`];
  if (extra) groqKeys.push(extra);
}

const aiClients = groqKeys.map(key => new OpenAI({ apiKey: key, baseURL: 'https://api.groq.com/openai/v1' }));
let aiClientIndex = 0;
function nextAiClient() {
  const client = aiClients[aiClientIndex % aiClients.length];
  aiClientIndex++;
  return client;
}

if (aiClients.length > 0) console.log(`Groq enabled with ${aiClients.length} key(s), model: ${AI_MODEL}`);
else console.log('No Groq API key — battles will use fallback results');
const battleCache = new Map();

// AI Request Queue — paces calls to stay within Groq free tier limits (~30 RPM per key)
const aiQueue = [];
let aiQueueProcessing = false;
const AI_BATCH_SIZE = Math.max(1, aiClients.length);
const AI_BATCH_DELAY_MS = 2000;

function enqueueAiCall(fn) {
  return new Promise((resolve, reject) => {
    aiQueue.push({ fn, resolve, reject });
    processAiQueue();
  });
}
async function processAiQueue() {
  if (aiQueueProcessing) return;
  aiQueueProcessing = true;
  while (aiQueue.length > 0) {
    const batch = aiQueue.splice(0, Math.min(aiQueue.length, AI_BATCH_SIZE));
    await Promise.allSettled(batch.map(item =>
      (async () => {
        try { item.resolve(await item.fn()); } catch (e) { item.reject(e); }
      })()
    ));
    if (aiQueue.length > 0) await new Promise(r => setTimeout(r, AI_BATCH_DELAY_MS));
  }
  aiQueueProcessing = false;
}

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
const GENRES = ['Animals', 'Machines', 'Mythical Creatures', 'Elements', 'Cosmic', 'Fantasy', 'Sci-Fi', 'Food', 'Sports', 'Nature', 'Magic', 'Technology', 'Underwater', 'Dinosaurs', 'Superheroes', 'Weather', 'Robots', 'Crystals & Gems', 'Insects', 'Cars & Vehicles'];
const ROUND_TIMEOUT = 30000;
const AUTO_ADVANCE_DELAY = 6000;
const ELO_K = 48;

// ============================================================
// SSE broadcast — pushes state to all connected clients in a room
// ============================================================
function broadcastRoomState(room) {
  if (!room || !room.sseClients || room.sseClients.length === 0) return;
  const dead = [];
  for (let i = 0; i < room.sseClients.length; i++) {
    const client = room.sseClients[i];
    try {
      const state = sanitizeRoom(room, client.uid);
      client.res.write(`data: ${JSON.stringify(state)}\n\n`);
    } catch {
      dead.push(i);
    }
  }
  for (let i = dead.length - 1; i >= 0; i--) {
    room.sseClients.splice(dead[i], 1);
  }
}

// ============================================================
// Simple in-memory rate limiter (per-IP)
// ============================================================
const rateHits = new Map();
function rateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    if (!rateHits.has(ip)) rateHits.set(ip, []);
    const hits = rateHits.get(ip);
    while (hits.length > 0 && hits[0] < now - windowMs) hits.shift();
    hits.push(now);
    if (hits.length > maxReq) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}

const PERSONALITIES = {
  'Hype Beast MC': 'Talks in ALL CAPS, uses streetwear/hype slang (e.g. SHEEEESH, no cap, deadass, cooked, absolute devastation, OMG, straight fire). Extremely energized, commentating the battle like a loud hype-man.',
  'Shakespearean Bard': 'Sir Alistair. Speaks in theatrical, poetic, and dramatic Old English. Uses metaphors and classical expressions like "Alas!", "thou art", "verily", "hast fallen".',
  'Chef Ramsay': 'Gordon. Speaks as a brutally honest, aggressive culinary judge. Uses foodie insults, restaurant metaphors, and screaming questions (e.g. "IT\'S RAW!", "Tasteless!", "An absolute dog\'s breakfast!", "Get out!").',
  'Cyborg-9000': 'Advanced military AI. Speaks in a cold, clinical, analytical manner. Mentions percentages, system log protocols, combat performance metrics, and errors (e.g. "Probability of survival: 0.00%", "Target neutralized.").',
  'Anime Narrator': 'Sensei Ken. Over-the-top, intense shonen anime style. Screams move names, mentions inner potential, visual auras, and dramatic standoffs, shouting things like "NANI?!", "IMPOSSIBLE!", "That power is immense!".'
};

const MUTATORS = {
  'Normal': 'Standard clash. Standard rules.',
  'Double Damage 💥': 'ALL damage and counter-damage is multiplied by 2 (winner up to 80, loser up to 40). Massive stakes!',
  'Opposite Day 🔄': 'Rules of power are INVERTED: the physically weaker, smaller, or less powerful entity wins! Compare them, and reward the weaker/less capable one.',
  'Lava Floor 🌋': 'Both players take 15 points of fire damage at the start of the round from hot lava. The description must mention the hot lava environment.',
  'Sudden Death 💀': 'If there is a winner, the loser takes 50 flat damage instantly. Counter-damage does not apply. If it is a tie, no damage is dealt to either.',
  'Regen Rain 🌧️': 'The winner of this round HEALS their HP by 25 points instead of dealing damage. If a tie, both players heal 10 HP.'
};

function pickRandomPersonality() {
  const keys = Object.keys(PERSONALITIES);
  return keys[Math.floor(Math.random() * keys.length)];
}

function pickRandomMutator() {
  const keys = Object.keys(MUTATORS);
  return keys[Math.floor(Math.random() * keys.length)];
}

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
  const now = Date.now();
  const room = {
    code, type,
    phase: type === 'private' ? 'genre_select' : 'waiting',
    genre: null,
    judgePersonality: null,
    mutator: 'Normal',
    p1: { ...p1Data, hp: 100, entity: null, ready: false, entityHidden: true, emoji: null, lastPollTime: now },
    p2: null,
    currentRound: 0,
    battleLog: [],
    roundTimer: null, advanceTimer: null,
    lastEntityP1: null, lastEntityP2: null,
    turnStartTime: Date.now(),
    forfeitStarted: null,
    forfeitSide: null,
    disconnectSide: null,
    disconnectTime: null,
    disconnectTimer: null,
    sseClients: [],
  };
  rooms.set(code, room);
  return room;
}

function isInBattlePhase(room) {
  return room && room.p2 && (room.phase === 'submitting' || room.phase === 'resolving' || room.phase === 'round_result');
}

async function forfeitPlayer(room, loserSide) {
  if (room.phase === 'game_over') return;
  clearTimeout(room.disconnectTimer);
  room.disconnectSide = null;
  room.disconnectTime = null;
  room.disconnectTimer = null;
  const winnerSide = loserSide === 'p1' ? 'p2' : 'p1';
  const winner = room[winnerSide];
  const loser = room[loserSide];
  // Set HP to 0 for loser, keep winner's HP
  loser.hp = 0;
  // Build a forfeit log entry
  const logEntry = {
    round: ++room.currentRound,
    winner: winnerSide === 'p1' ? 'player1' : 'player2',
    winnerUsername: winner.username,
    loserUsername: loser.username,
    player1Emoji: winnerSide === 'p1' ? '🏆' : '💀',
    player2Emoji: winnerSide === 'p2' ? '🏆' : '💀',
    p1Entity: room.lastEntityP1 || '',
    p2Entity: room.lastEntityP2 || '',
    damage: 40,
    counterDamage: 0,
    winnerHp: winner.hp,
    loserHp: 0,
    description: `${loser.username} left the battle. ${winner.username} wins by forfeit!`,
  };
pushBattleLog(room, logEntry);
      room.phase = 'game_over';
      clearTimeout(room.roundTimer);
      clearTimeout(room.advanceTimer);
  room.forfeitStarted = null;
  room.forfeitSide = null;
  await updateEloAfterGame(room, winner, loser);
  broadcastRoomState(room);
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
    judgePersonality: room.judgePersonality, mutator: room.mutator,
    currentRound: room.currentRound,
    battleLog: room.battleLog.map(e => ({ ...e, eloChange: e.eloChange ? { ...e.eloChange } : undefined })),
    turnStartTime: room.turnStartTime,
    serverTime: Date.now(),
    timeRemaining: room.turnStartTime ? Math.max(0, Math.ceil(30 - (Date.now() - room.turnStartTime) / 1000)) : 30,
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
    disconnected: room.disconnectSide ? true : false,
    disconnectedSide: room.disconnectSide,
    disconnectTimeRemaining: room.disconnectTime ? Math.max(0, Math.ceil(30 - (Date.now() - room.disconnectTime) / 1000)) : 0,
  };
}

function calculateElo(ratingA, ratingB, winA) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return {
    newA: Math.round(ratingA + ELO_K * ((winA ? 1 : 0) - expectedA)),
    newB: Math.round(ratingB + ELO_K * (((winA ? 0 : 1)) - (1 - expectedA))),
  };
}

function findOpenPublicRoom(myElo) {
  let bestRoom = null;
  let bestDiff = Infinity;
  for (const room of rooms.values()) {
    if (room.type === 'public' && room.phase === 'waiting' && !room.p2) {
      const roomElo = room.p1?.elo || 1000;
      const diff = Math.abs(roomElo - myElo);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestRoom = room;
      }
    }
  }
  return bestRoom; // returns closest Elo match, or null if none exist
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

function pickRandomGenre() {
  return GENRES[Math.floor(Math.random() * GENRES.length)];
}

// ============================================================
// TIMER
// ============================================================

function startRoundTimer(room) {
  // Safety: if either player at 0 HP, end game immediately
  if ((room.p1?.hp ?? 100) <= 0 || (room.p2?.hp ?? 100) <= 0) {
    room.phase = 'game_over';
    clearTimeout(room.roundTimer);
    clearTimeout(room.advanceTimer);
    const p1Dead = (room.p1?.hp ?? 100) <= 0;
    const winner = p1Dead ? room.p2 : room.p1;
    const loser = p1Dead ? room.p1 : room.p2;
    updateEloAfterGame(room, winner, loser);
    broadcastRoomState(room);
    return;
  }
  room.genre = pickRandomGenre();
  room.mutator = pickRandomMutator();
  room.turnStartTime = Date.now();
  broadcastRoomState(room);
  clearTimeout(room.roundTimer);
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
      pushBattleLog(room, logEntry);
      room.p1.entity = null; room.p2.entity = null;
      room.p1.ready = false; room.p2.ready = false;
      room.p1.entityHidden = true; room.p2.entityHidden = true;
      if (room.p1.hp <= 0 || room.p2.hp <= 0) {
        const winner = room.p1.hp > 0 ? room.p1 : room.p2;
        const loser = room.p1.hp > 0 ? room.p2 : room.p1;
      room.phase = 'game_over';
      clearTimeout(room.advanceTimer);
      await updateEloAfterGame(room, winner, loser);
      broadcastRoomState(room);
      return;
      }
      room.phase = 'round_result';
      broadcastRoomState(room);
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
// GIBBERISH DETECTION
// ============================================================

const COMMON_WORDS = new Set([
  'a','an','the','this','that','it','is','in','of','to','and','or','for','with','on','as','at','by','be',
  'super','ultra','mega','hyper','uber','giga','tera','peta','exa','omni','multi','poly','proto','neo',
  'ball','blade','blaster','bolt','bomb','bone','boot','bow','brass','breaker','bringer','buster','cannon',
  'carrier','caster','claw','cleaver','cloud','claw','collar','core','crasher','crusher','crystal','cube',
  'cutlass','cycle','dagger','dancer','dark','death','demon','destroyer','devil','doom','dragon','drain',
  'drill','driver','droplet','drum','earth','eater','edge','element','emerald','engine','eye','fairy',
  'fist','flame','flare','flash','flesh','flight','flood','flower','force','forge','fragment','frost',
  'fury','gale','gear','gem','ghost','giant','glacier','gland','glass','glide','globe','glove','golem',
  'grasp','grave','gravity','grip','guard','guardian','gun','hail','hammer','hand','harpoon','heart',
  'heaven','hell','helm','herald','hide','hollow','horn','howl','hunter','ice','inferno','iron','jade',
  'jaw','judge','keeper','key','killer','king','knight','lash','lens','leon','level','light','lightning',
  'lily','lion','liquid','lord','lore','lumen','lunar','mage','magma','magnet','mane','mantle','marble',
  'mark','mask','master','maw','maze','meadow','mechanic','memory','mercy','mesh','metal','might','mind',
  'mine','mirror','mist','monarch','monolith','monster','moon','mortal','moss','mother','mountain','mourn',
  'mouth','mover','murk','nail','necklace','needle','nest','nether','night','noble','node','nova','oath',
  'orb','ore','oven','pact','palm','panther','paragon','particle','passage','patch','path','patron',
  'pattern','paw','peak','pearl','pendant','perch','phantom','phase','phoenix','piercer','pillar','pine',
  'pinnacle','pixel','plague','plane','plasma','plate','plume','pocket','poem','point','poison','pole',
  'polish','pollen','pond','pool','portal','powder','power','praise','prayer','prey','pride','prince',
  'prism','probe','promise','prophet','prowl','pull','pulse','pump','punch','pupil','puppet','purity',
  'puzzle','pyre','pyro','queen','quiver','rage','rain','ranger','raven','razor','reach','reaver','rebel',
  'receiver','recluse','record','redeemer','reed','reaper','regent','relic','remnant','rend','render',
  'rest','return','revenant','reverie','rhapsody','rhythm','ridge','rifle','rift','right','rigor','rim',
  'ring','ranger','rival','river','roar','rocket','rod','rogue','roof','rook','root','rope','rose','rotor',
  'rouge','round','route','royal','ruin','rune','rush','saber','sabre','sacrifice','saddle','saint',
  'salvation','sanctum','sapphire','sash','savage','savior','scale','scar','scarab','scepter','scheme',
  'scholar','sconce','scope','scorch','scourge','scout','scrap','scream','scribe','scroll','sculpture',
  'seal','seam','season','seat','sea','secret','sect','seed','seeker','sense','sentinel','serpent',
  'servant','shade','shadow','shard','shark','shatter','shear','sheath','shelf','shell','shield','shift',
  'shimmer','shin','shire','shock','shooter','shard','shore','shot','shout','shrine','shroud','shrub',
  'shuriken','siege','sight','signal','silence','silk','sill','silver','singer','sink','siren','skull',
  'sky','slab','slate','slayer','sleep','slicer','slime','sling','slip','slope','sludge','smash','smelt',
  'smile','smoke','snap','sniper','snow','soar','solar','soldier','sole','solid','song','sorcerer','soul',
  'sound','source','space','spark','spawn','spear','specter','spell','sphere','spider','spike','spine',
  'spirit','spite','splash','split','spore','spot','spray','spring','sprout','spur','spy','squad','square',
  'squash','squid','stable','staff','stage','stain','stair','stake','stalk','stallion','stamp','stance',
  'star','stare','stark','starlight','static','station','statue','stealth','steam','steed','steel','steep',
  'stem','step','steward','stick','sting','stir','stitch','stock','stone','stool','stop','storage','storm',
  'story','stove','strand','stranger','stratagem','stream','strength','strike','string','stripe','stroke',
  'structure','stride','striker','string','stripe','stun','stygian','style','sub','substance','subtlety',
  'sucker','suffering','sugar','suit','summer','summit','summoner','sun','sunder','sunlight','sunset',
  'supernova','surge','surge','surround','surveillance','survivor','sustenance','swallow','swamp','swan',
  'swarm','sway','sweat','sweep','sweet','swell','swift','swing','swipe','swirl','sword','symbol','system',
  'table','tablet','tackle','tail','tailor','taint','talent','talon','tank','tap','tape','tar','target',
  'task','taste','tattoo','taunt','tavern','tax','tea','teach','tear','tease','technique','teeth','tell',
  'temper','tempest','temple','tempt','tendril','tenet','tent','tenth','tepid','term','terra','terror',
  'test','thorn','thought','thread','threat','throne','throttle','through','throw','thrust','thumb',
  'thunder','tide','tiger','tile','timber','time','tin','tincture','tinder','tinker','tire','tissue',
  'titan','title','toad','toast','token','tomb','tome','tongue','tool','tooth','top','topaz','torch',
  'tornado','torrent','torso','totem','touch','tour','tower','town','track','trade','trail','train',
  'trait','trance','trap','trash','trauma','travel','treasure','treat','tree','trek','tremor','trench',
  'trial','tribe','trick','trigger','trill','trinket','trip','trophy','tropic','trot','trouble','truce',
  'trunk','trust','truth','try','tub','tube','tucker','tug','tumble','tumor','tune','tunnel','turbine',
  'turmoil','turn','turtle','tusk','tutor','twig','twilight','twin','twine','twirl','twist','twister',
  'tyrant',
  // Known characters and brands (not gibberish)
  'optimus','prime','megatron','bumblebee','starscream','soundwave','grimlock','godzilla','kingkong',
  'superman','batman','wonder','woman','flash','aquaman','cyborg','hulk','thor','ironman','spider','man',
  'darth','vader','yoda','luke','skywalker','obi','wan','kenobi','palpatine','gandalf','sauron','frodo',
  'aragorn','legolas','gimli','harry','potter','voldemort','dumbledore','snape','shrek','donkey','fiona',
  'pikachu','charizard','mewtwo','goku','vegeta','naruto','sasuke','luffy','zoro','ichigo','simba','mufasa',
  'scar','timon','pumbaa','nemo','dory','marlin','buzz','lightyear','woody','jessie','elsa','anna','olaf',
  'mickey','minnie','donald','daisy','goofy','pluto','bugs','bunny','daffy','porky','tweety','sylvester',
]);

function isGibberish(entity) {
  if (!entity || entity.trim().length === 0) return true;
  const words = entity.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return true;

  // Keyboard mashing patterns
  const keyboardRows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'qwertzuiop', 'azertyuiop'];
  for (const w of words) {
    if (w.length >= 5) {
      for (const row of keyboardRows) {
        if (row.includes(w) || w.split('').every(c => row.includes(c))) {
          // Check if it's a consecutive substring of a keyboard row
          for (let i = 0; i <= row.length - w.length; i++) {
            if (row.slice(i, i + w.length) === w) return true;
          }
        }
      }
      // Repeated single character (e.g. "aaaaa", "bbbbb")
      if (w.split('').every(c => c === w[0])) return true;
    }
  }

  // Single word entities are fine for multi-word checks below
  if (words.length <= 2) return false;

  // Very long unrecognized "words" (not in common words)
  for (const w of words) {
    if (w.length > 20 && !COMMON_WORDS.has(w)) return true;
  }

  // Count how many words are NOT in common words
  let unknown = 0;
  for (const w of words) {
    if (!COMMON_WORDS.has(w) && w.length > 2) unknown++;
  }
  // If >40% of words (min 2) are unrecognized, likely gibberish
  if (words.length >= 3 && unknown >= 2) return true;
  // Check for rhyming nonsense pattern: 3+ words ending with same sound
  // e.g. "super duper luper guper" — "uper" repeated
  const suffixes = words.map(w => w.length >= 3 ? w.slice(-3) : '');
  const suffixCounts = {};
  for (const s of suffixes) {
    if (s.length >= 3) suffixCounts[s] = (suffixCounts[s] || 0) + 1;
  }
  for (const s in suffixCounts) {
    if (suffixCounts[s] >= 3) return true;
  }
  return false;
}

// ============================================================
// AI BATTLE RESOLUTION (Groq)
// ============================================================

async function resolveGibberish(room, g1, g2) {
  // Both are gibberish — tie
  if (g1 && g2) {
    const data = {
      winner: 'tie',
      player1Emoji: '🤡',
      player2Emoji: '🤡',
      damage: 0,
      counterDamage: 0,
      description: 'Both players submitted nonsense. The battle devolves into chaotic gibberish. Nobody wins.'
    };
    const log = await applyBattleResult(room, data);
    pushBattleLog(room, log);
    if (room.phase === 'game_over') return;
    advanceAfterResolve(room);
    return;
  }
  // One is gibberish — that player loses at 40 damage, 0 counter
  const gSide = g1 ? 'player1' : 'player2';
  const realSide = g1 ? 'player2' : 'player1';
  const data = {
    winner: realSide,
    player1Emoji: g1 ? '🤡' : '✅',
    player2Emoji: g2 ? '🤡' : '✅',
    damage: 40,
    counterDamage: 0,
    description: g1
      ? `"${room.p2.entity || '???'}" utterly demolishes the nonsensical "${room.p1.entity || '???'}". Gibberish stands no chance against a real concept!`
      : `"${room.p1.entity || '???'}" utterly demolishes the nonsensical "${room.p2.entity || '???'}". Gibberish stands no chance against a real concept!`
  };
  const log = await applyBattleResult(room, data);
  pushBattleLog(room, log);
  if (room.phase === 'game_over') return;
  advanceAfterResolve(room);
}

async function resolveBattle(room) {
  room.phase = 'resolving';
  const genre = room.genre;
  const e1 = room.p1.entity;
  const e2 = room.p2.entity;
  const personalityName = room.judgePersonality || 'Hype Beast MC';
  const personalityStyle = PERSONALITIES[personalityName] || '';
  const mutatorName = room.mutator || 'Normal';
  const mutatorStyle = MUTATORS[mutatorName] || '';

  // Pre-check: auto-disqualify gibberish without calling AI
  const g1 = isGibberish(e1);
  const g2 = isGibberish(e2);
  if (g1 || g2) {
    // The result will be sent through the normal flow from applyBattleResult
    return await resolveGibberish(room, g1, g2);
  }

  const cacheKey = `${genre}::${e1}::${e2}`;
  if (battleCache.has(cacheKey)) {
    const log = await applyBattleResult(room, battleCache.get(cacheKey));
    pushBattleLog(room, log);
    if (room.phase === 'game_over') return;
    advanceAfterResolve(room);
    return;
  }

  const prompt = `You are an AI battle judge for the genre "${genre}".
Your judge personality is: ${personalityName}. ${personalityStyle}
The active mutator for this round is: ${mutatorName}.

Player 1 submitted: "${e1}"
Player 2 submitted: "${e2}"

Return ONLY valid JSON (no markdown, no extra text). This will be parsed programmatically:

{
  "winner": "player1" or "player2" or "tie",
  "player1Emoji": "single emoji representing entity1",
  "player2Emoji": "single emoji representing entity2",
  "damage": <integer 0-40>,
  "counterDamage": <integer 0-20>,
  "description": "1 punchy sentence (8-25 words) describing the action in your judge personality's unique style"
}

CRITICAL RULES (follow strictly in this order):
- 🔴 GENRE CHECK — THIS IS THE MOST IMPORTANT RULE: Each entity MUST belong to the "${genre}" genre. If ANY entity is NOT a member of the "${genre}" category, IMMEDIATELY DISQUALIFY that player (40 damage, 0 counter-damage, they lose). Examples: "dog" is NOT an insect → disqualified. "car" is NOT an animal → disqualified. "laser gun" is NOT nature → disqualified. "pizza" is NOT a machine → disqualified. The genre is "${genre}" — if an entity doesn't fit, disqualify without hesitation. Do NOT compare power between entities that don't match the genre — just disqualify the mismatched one. If BOTH don't match the genre, it's a tie at 0 damage with a dismissive description.
- GIBBERISH: If an entry is nonsense, made-up words (e.g. "blargle fargle", "zorp glorp", "dooper snooper"), random keyboard spam ("asdfghjkl"), or a phrase with 3+ rhyming silly words, DISQUALIFY that player: they take 40 damage, deal 0 counter-damage, lose, and the description is humorously dismissive. Even ONE real word mixed with nonsense is STILL gibberish.
- INAPPROPRIATE: If an entry contains sexual, hateful, extremely violent, or NSFW content, IMMEDIATELY DISQUALIFY that player: they take 40 damage, deal 0 counter-damage, lose, emoji is "🔞", and description says "submission was inappropriate and removed" — NEVER describe the content itself.
- MUTATOR: The active mutator "${mutatorName}" modifies the battle rules as follows: ${mutatorStyle}. Follow these mutator rules strictly when evaluating the winner, damage, and description. If you don't know how to apply it, revert to standard rules.
- TIES: If both entities are equally matched (same power level, identical, or neither clearly beats the other), set winner to "tie", damage 0, counterDamage 0.
- POWER COMPARISON: Use real-world logic, size, destructive capability, weapons, armor, and genre context. Compare ESTABLISHED power levels of named characters (e.g. Optimus Prime > sports car, T-Rex > chicken, laser cannon > deer). Prefixes like "super", "mega", "ultra", "hyper" on a normal thing (e.g. "super car") do NOT drastically increase power. A god-level entity (Zeus) beats a mortal (soldier) but the mortal can do ~5 counter-damage. Think step by step: who realistically wins, and by how much?
- DAMAGE: Slight advantage → damage 10-15, counterDamage 5-10. Clear gap → damage 20-30, counterDamage 0-5. Utter domination → damage 35-40, counterDamage 0. Disqualification = 40. The loser always deals at least SOME counter-damage unless completely helpless.
- EMOJIS: One creative emoji per entity (e.g. dragon → "🐉", water droplet → "💧", laser gun → "🔫").
- "damage" is dealt TO the loser by the winner. "counterDamage" is dealt TO the winner by the loser.
- Be creative, thematic, fair, and decisive. Use hard logic. No ties unless truly equal. Write the description in the unique voice of ${personalityName}.`;

  let data;
  if (aiClients.length > 0) {
    data = await enqueueAiCall(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const client = nextAiClient();
        try {
          const completion = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [
              { role: 'system', content: `You are ${personalityName}, a strict AI battle judge. ${personalityStyle} The active mutator is: ${mutatorName} — ${mutatorStyle}. Your most important rule is GENRE CHECK — disqualify any entity that does not belong to the specified genre. Always respond in valid JSON only. Keep descriptions vivid (8-25 words, 1 sentence) and match your assigned personality. No stories, no markdown.` },
              { role: 'user', content: prompt }
            ],
            response_format: { type: 'json_object' }
          });
          const text = completion.choices[0].message.content;
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
        } catch (err) {
          const isQuota = err.status === 429 || (err.message && err.message.includes('429'));
          const delay = isQuota ? 15000 : 1000;
          console.error(`Groq attempt ${attempt + 1} failed${isQuota ? ' (quota)' : ''}:`, err.message || err);
          if (attempt < 2) await new Promise(r => setTimeout(r, delay));
          else return { winner: ['player1', 'player2', 'tie'][Math.floor(Math.random() * 3)], player1Emoji: '⚔️', player2Emoji: '⚔️', damage: 20, counterDamage: 10, description: 'The AI judge is unavailable. Fate decides the outcome.' };
        }
      }
    });
  } else {
    data = { winner: ['player1', 'player2', 'tie'][Math.floor(Math.random() * 3)], player1Emoji: '⚔️', player2Emoji: '⚔️', damage: 20, counterDamage: 10, description: 'With no AI judge available, the battle is decided by fate.' };
  }

  cacheBattleResult(cacheKey, data);
  const logEntry = await applyBattleResult(room, data);
  pushBattleLog(room, logEntry);
  if (room.phase === 'game_over') return;
  advanceAfterResolve(room);
}

function cacheBattleResult(key, data) {
  if (battleCache.size > 200) battleCache.clear();
  battleCache.set(key, data);
}

async function applyBattleResult(room, data) {
  const mutator = room.mutator || 'Normal';
  const isTie = data.winner === 'tie';
  let damage = isTie ? 0 : Math.min(40, Math.max(1, data.damage || 10));
  let counterDamage = isTie ? 0 : Math.min(20, Math.max(0, data.counterDamage || 0));
  let p1Heal = 0;
  let p2Heal = 0;

  // -- Apply Mutator modifications --
  if (mutator === 'Double Damage 💥') {
    damage = Math.min(80, damage * 2);
    counterDamage = Math.min(40, counterDamage * 2);
  } else if (mutator === 'Sudden Death 💀') {
    if (!isTie) {
      damage = 50;
      counterDamage = 0;
    }
  } else if (mutator === 'Regen Rain 🌧️') {
    if (isTie) {
      p1Heal = 10;
      p2Heal = 10;
    } else {
      if (data.winner === 'player1') p1Heal = 25;
      else p2Heal = 25;
      damage = 0;
      counterDamage = 0;
    }
  }

  room.p1.emoji = data.player1Emoji || '❓';
  room.p2.emoji = data.player2Emoji || '❓';
  room.lastEntityP1 = room.p1.entity;
  room.lastEntityP2 = room.p2.entity;

  if (isTie) {
    if (p1Heal > 0) room.p1.hp = Math.min(100, room.p1.hp + p1Heal);
    if (p2Heal > 0) room.p2.hp = Math.min(100, room.p2.hp + p2Heal);
    if (mutator === 'Lava Floor 🌋') { room.p1.hp -= 15; room.p2.hp -= 15; if (room.p1.hp < 0) room.p1.hp = 0; if (room.p2.hp < 0) room.p2.hp = 0; }
    return {
      round: ++room.currentRound, winner: 'tie', winnerUsername: '', loserUsername: '',
      player1Emoji: data.player1Emoji || '❓', player2Emoji: data.player2Emoji || '❓',
      p1Entity: room.lastEntityP1, p2Entity: room.lastEntityP2,
      damage: 0, counterDamage: 0, p1Heal, p2Heal, winnerHp: room.p1.hp, loserHp: room.p2.hp,
      description: data.description || 'A perfectly matched battle! Neither prevails.',
    };
  }

  const p1Wins = data.winner === 'player1';
  const loser = p1Wins ? room.p2 : room.p1;
  const winner = p1Wins ? room.p1 : room.p2;
  loser.hp -= damage;
  winner.hp -= counterDamage;
  if (p1Heal > 0) room.p1.hp = Math.min(100, room.p1.hp + p1Heal);
  if (p2Heal > 0) room.p2.hp = Math.min(100, room.p2.hp + p2Heal);
  if (mutator === 'Lava Floor 🌋') { room.p1.hp -= 15; room.p2.hp -= 15; }
  if (loser.hp < 0) loser.hp = 0;
  if (winner.hp < 0) winner.hp = 0;
  if (room.p1.hp < 0) room.p1.hp = 0;
  if (room.p2.hp < 0) room.p2.hp = 0;

  const logEntry = {
    round: ++room.currentRound, winner: p1Wins ? 'player1' : 'player2',
    winnerUsername: winner.username, loserUsername: loser.username,
    player1Emoji: data.player1Emoji || '❓', player2Emoji: data.player2Emoji || '❓',
    p1Entity: room.lastEntityP1, p2Entity: room.lastEntityP2,
    damage, counterDamage, p1Heal, p2Heal, winnerHp: winner.hp, loserHp: loser.hp,
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

  if (loser.hp <= 0 || winner.hp <= 0) {
    room.phase = 'game_over';
    clearTimeout(room.roundTimer);
    clearTimeout(room.advanceTimer);
    // Both died: determine true winner by who has more HP (>0 preferred)
    const bothDead = loser.hp <= 0 && winner.hp <= 0;
    const eloWinner = !bothDead && loser.hp <= 0 ? winner : (!bothDead && winner.hp <= 0 ? loser : winner);
    const eloLoser = eloWinner === winner ? loser : winner;
    await updateEloAfterGame(room, eloWinner, eloLoser);
    room.p1.entity = null; room.p2.entity = null;
    room.p1.ready = false; room.p2.ready = false;
    room.p1.entityHidden = true; room.p2.entityHidden = true;
    broadcastRoomState(room);
  }

  return logEntry;
}

function pushBattleLog(room, entry) {
  room.battleLog.push(entry);
  if (room.battleLog.length > 50) room.battleLog = room.battleLog.slice(-50);
}

function advanceAfterResolve(room) {
  if (room.phase === 'game_over') return;
  room.p1.entity = null; room.p2.entity = null;
  room.p1.ready = false; room.p2.ready = false;
  room.p1.entityHidden = true; room.p2.entityHidden = true;
  room.phase = 'round_result';
  broadcastRoomState(room);
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
app.post('/api/register', rateLimit(20, 60000), (req, res) => {
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

// --- Auth: Guest Login (auto-create guest account) ---
app.post('/api/guest-login', rateLimit(10, 60000), (req, res) => {
  try {
    let guestName;
    do {
      const num = Math.floor(1000 + Math.random() * 9000);
      guestName = 'Player_' + num;
    } while (findUserByUsername(guestName));
    const uid = uuidv4();
    createUser(uid, guestName, null);
    const token = jwt.sign({ uid, username: guestName }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, uid, username: guestName });
  } catch (e) {
    console.error('Guest login error:', e);
    res.status(500).json({ error: 'Guest login failed' });
  }
});

// --- Auth: Login ---
app.post('/api/login', rateLimit(20, 60000), (req, res) => {
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
      destroyRoom(room); rooms.delete(code);
    }
  }
  // Find an open room (closest Elo match), or create one
  let room = findOpenPublicRoom(elo);
  if (room) {
    room.p2 = { userId: user.uid, username, elo, hp: 100, entity: null, ready: false, entityHidden: true, emoji: null, lastPollTime: Date.now() };
    room.genre = GENRES[Math.floor(Math.random() * GENRES.length)];
    room.judgePersonality = pickRandomPersonality();
    room.phase = 'submitting';
    room.turnStartTime = Date.now();
    startRoundTimer(room);
    broadcastRoomState(room);
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
  room.p2 = { userId: user.uid, username, elo, hp: 100, entity: null, ready: false, entityHidden: true, emoji: null, lastPollTime: Date.now() };
  room.phase = 'genre_select';
  broadcastRoomState(room);
  res.json({ success: true });
});

function destroyRoom(room) {
  if (!room) return;
  clearTimeout(room.roundTimer);
  clearTimeout(room.advanceTimer);
  clearTimeout(room.disconnectTimer);
  if (room.sseClients) {
    for (const client of room.sseClients) {
      try { client.res.end(); } catch {}
    }
    room.sseClients = [];
  }
}

// --- Room: Leave (abandon any room) ---
app.post('/api/leave-room', async (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  for (const [code, room] of rooms.entries()) {
    if (room.p1?.userId === user.uid || room.p2?.userId === user.uid) {
      if (isInBattlePhase(room)) {
        const loserSide = room.p1.userId === user.uid ? 'p1' : 'p2';
        // If the other player already disconnected, forfeit immediately
        if (room.disconnectSide && room.disconnectSide !== loserSide) {
          await forfeitPlayer(room, loserSide);
        } else if (room.disconnectSide === loserSide) {
          // Same player already marked — ignore duplicate
          return res.json({ success: true });
        } else {
          // First disconnect — start 30s grace period
          room.disconnectSide = loserSide;
          room.disconnectTime = Date.now();
          clearTimeout(room.disconnectTimer);
          room.disconnectTimer = setTimeout(async () => {
            if (room && room.disconnectSide) {
              await forfeitPlayer(room, room.disconnectSide);
            }
          }, 30000);
          broadcastRoomState(room);
        }
      } else {
        destroyRoom(room);
        rooms.delete(code);
      }
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
      destroyRoom(room);
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
  broadcastRoomState(room);
  res.json({ success: true });
});

// --- Game: Random Genre ---
app.get('/api/random-genre', (req, res) => {
  res.json({ genre: GENRES[Math.floor(Math.random() * GENRES.length)] });
});

// --- Private Game: Start ---
app.post('/api/start-game', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  const room = rooms.get(code?.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.p1.userId !== user.uid) return res.status(403).json({ error: 'Only the host can start' });
  if (!room.p2) return res.status(400).json({ error: 'Opponent not joined' });
  if (!room.genre) return res.status(400).json({ error: 'No genre selected' });
  if (room.phase !== 'genre_select') return res.status(400).json({ error: 'Cannot start now' });
  room.p1.hp = 100; room.p2.hp = 100;
  room.p1.entity = null; room.p2.entity = null;
  room.p1.ready = false; room.p2.ready = false;
  room.p1.entityHidden = true; room.p2.entityHidden = true;
  room.currentRound = 0;
  room.battleLog = [];
  room.judgePersonality = pickRandomPersonality();
  room.phase = 'submitting';
  room.turnStartTime = Date.now();
  startRoundTimer(room);
  broadcastRoomState(room);
  res.json({ success: true });
});

// --- Private Game: Reset (return to lobby after game over) ---
app.post('/api/private-reset', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  const room = rooms.get(code?.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isP1 = room.p1?.userId === user.uid;
  const isP2 = room.p2?.userId === user.uid;
  if (!isP1 && !isP2) return res.status(403).json({ error: 'Not in this room' });
  if (room.phase !== 'game_over') return res.status(400).json({ error: 'Game not over' });
  clearTimeout(room.roundTimer);
  clearTimeout(room.advanceTimer);
  room.p1.hp = 100; room.p2.hp = 100;
  room.p1.entity = null; room.p2.entity = null;
  room.p1.ready = false; room.p2.ready = false;
  room.p1.entityHidden = true; room.p2.entityHidden = true;
  room.currentRound = 0;
  room.battleLog = [];
  room.genre = null;
  room.phase = 'genre_select';
  broadcastRoomState(room);
  res.json({ success: true });
});

// --- Game: Submit Entity ---
app.post('/api/submit-entity', rateLimit(30, 60000), (req, res) => {
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
  broadcastRoomState(room);
  if (room.p1.ready && room.p2.ready) { clearTimeout(room.roundTimer); resolveBattle(room); }
  res.json({ success: true });
});

// --- Game: Get State ---
app.get('/api/game-state/:code', async (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const room = rooms.get(req.params.code?.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isP1 = room.p1?.userId === user.uid;
  const isP2 = room.p2?.userId === user.uid;
  if (!isP1 && !isP2) return res.status(403).json({ error: 'Not in this room' });

  // Update last poll time
  const mySide = isP1 ? 'p1' : 'p2';
  room[mySide].lastPollTime = Date.now();

  // If disconnected and this player is the one who left, reconnect them
  if (room.disconnectSide && room[room.disconnectSide]?.userId === user.uid) {
    clearTimeout(room.disconnectTimer);
    room.disconnectSide = null;
    room.disconnectTime = null;
    room.disconnectTimer = null;
    broadcastRoomState(room);
  }

  res.json(sanitizeRoom(room, user.uid));
});

// --- Game: Resign ---
app.post('/api/resign', async (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  const room = rooms.get(code?.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isP1 = room.p1?.userId === user.uid;
  const isP2 = room.p2?.userId === user.uid;
  if (!isP1 && !isP2) return res.status(403).json({ error: 'Not in this room' });
  if (!isInBattlePhase(room)) return res.status(400).json({ error: 'Not in an active battle' });
  const loserSide = isP1 ? 'p1' : 'p2';
  await forfeitPlayer(room, loserSide);
  res.json({ success: true });
});

// --- Health Check ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', ai: aiClients.length > 0 }));

// ============================================================
// SSE endpoint — real-time game state push
// ============================================================
app.get('/api/sse/:code', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).end();
  let user;
  try { user = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).end(); }

  const room = rooms.get(req.params.code?.toUpperCase());
  if (!room) return res.status(404).end();

  const isP1 = room.p1?.userId === user.uid;
  const isP2 = room.p2?.userId === user.uid;
  if (!isP1 && !isP2) return res.status(403).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client = { uid: user.uid, res };
  room.sseClients.push(client);

  // Send initial state immediately
  try {
    const state = sanitizeRoom(room, user.uid);
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  } catch {}

  // Keep-alive heartbeat every 25s
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const idx = room.sseClients.indexOf(client);
    if (idx >= 0) room.sseClients.splice(idx, 1);
  });
});

// ============================================================
// Room cleanup — prevent memory leaks on a free tier
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.phase === 'game_over' && now - room.turnStartTime > 300000) {
      destroyRoom(room); rooms.delete(code);
    } else if (room.phase === 'waiting' && !room.p2 && now - (room.p1?.lastPollTime || 0) > 600000) {
      destroyRoom(room); rooms.delete(code);
    } else if (room.phase === 'genre_select' && now - room.turnStartTime > 1800000) {
      destroyRoom(room); rooms.delete(code);
    }
  }
}, 60000);

// ============================================================
// Shutdown handlers — flush pending user data
// ============================================================
process.on('SIGTERM', () => { flushUsers(); process.exit(0); });
process.on('SIGINT', () => { flushUsers(); process.exit(0); });
process.on('SIGUSR2', () => { flushUsers(); process.exit(0); });

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Prompt Clash server running on port ${PORT}`);
  console.log(`  AI judge: ${aiClients.length > 0 ? `enabled (${AI_MODEL} via Groq, ${aiClients.length} key(s))` : 'NOT configured (set GROQ_API_KEY)'}`);
  console.log(`  Users stored at: ${USERS_FILE}`);
});
