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
const GENRES = ['Animals', 'Machines', 'Mythical Creatures', 'Elements', 'Cosmic', 'Fantasy', 'Sci-Fi', 'Food', 'Sports', 'Nature', 'Magic', 'Technology', 'Underwater', 'Dinosaurs', 'Superheroes', 'Weather', 'Robots', 'Crystals & Gems', 'Insects', 'Cars & Vehicles'];
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
  const now = Date.now();
  const room = {
    code, type,
    phase: type === 'private' ? 'genre_select' : 'waiting',
    genre: null,
    p1: { ...p1Data, hp: 100, entity: null, ready: false, entityHidden: true, emoji: null, lastPollTime: now },
    p2: null,
    currentRound: 0,
    battleLog: [],
    roundTimer: null, advanceTimer: null,
    lastEntityP1: null, lastEntityP2: null,
    turnStartTime: Date.now(),
    forfeitStarted: null, // timestamp when forfeit countdown began
    forfeitSide: null,    // which side is being forfeited
  };
  rooms.set(code, room);
  return room;
}

function isInBattlePhase(room) {
  return room && room.p2 && (room.phase === 'submitting' || room.phase === 'resolving' || room.phase === 'round_result');
}

async function forfeitPlayer(room, loserSide) {
  if (room.phase === 'game_over') return;
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
  room.battleLog.push(logEntry);
  room.phase = 'game_over';
  clearTimeout(room.roundTimer);
  clearTimeout(room.advanceTimer);
  room.forfeitStarted = null;
  room.forfeitSide = null;
  await updateEloAfterGame(room, winner, loser);
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
  // Safety: if either player at 0 HP, end game immediately
  if ((room.p1?.hp ?? 100) <= 0 || (room.p2?.hp ?? 100) <= 0) {
    room.phase = 'game_over';
    clearTimeout(room.roundTimer);
    clearTimeout(room.advanceTimer);
    const p1Dead = (room.p1?.hp ?? 100) <= 0;
    const winner = p1Dead ? room.p2 : room.p1;
    const loser = p1Dead ? room.p1 : room.p2;
    updateEloAfterGame(room, winner, loser);
    return;
  }
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
  const words = entity.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return true;
  // Single word entities are fine
  if (words.length <= 2) return false;
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
    room.battleLog.push(log);
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
  room.battleLog.push(log);
  if (room.phase === 'game_over') return;
  advanceAfterResolve(room);
}

async function resolveBattle(room) {
  room.phase = 'resolving';
  const genre = room.genre;
  const e1 = room.p1.entity;
  const e2 = room.p2.entity;

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
- ENTITY VALIDATION: Each entity MUST be a real, coherent concept or thing. Gibberish includes made-up nonsense words strung together like "super duper luper guper gem", "blargle fargle shnargle", "zorp glorp florp snorp", "wibbly wobbly floob", "dooper snooper trooper gooper" — any phrase with 3+ made-up rhyming or silly words is GIBBERISH. If an entity is gibberish, nonsense, a random phrase (like "bradar what is this"), or not an actual thing, DISQUALIFY that player: they lose, take 40 damage, deal 0 counter-damage, and the description should be humorously dismissive. Even if the entity contains ONE real word (like "gem"), if the rest is nonsense, it's STILL gibberish.
- GENRE CHECK: If an entity does NOT clearly belong to the "${genre}" genre, DISQUALIFY that player: they lose, take 40 damage, deal 0 counter-damage, and the description should be humorously dismissive.
- NSFW / INAPPROPRIATE CONTENT: If an entity contains sexual, violent, hateful, or otherwise inappropriate content, IMMEDIATELY DISQUALIFY that player: they lose, take 40 damage, deal 0 counter-damage, and the description must say their submission was inappropriate and removed. Set player1Emoji to "🔞" for that player. NEVER describe the inappropriate content in the description — just say it was inappropriate.
- TIES: If both entities are equally matched (same power level, identical, or neither clearly beats the other), set winner to "tie", damage to 0, and counterDamage to 0. Example: cat vs cat is a tie.
- POWER COMPARISON: Compare entities using real-world logic, size, destructive capability, weapons, armor, and genre context. Named characters/famous entities (e.g. "Optimus Prime", "Godzilla", "Superman", "Darth Vader") should be evaluated at their ESTABLISHED power level from their source material — a 28-foot transforming robot warrior with plasma cannons and super strength is vastly more powerful than a car. "Super X" or "Mega X" or "Ultra X" tacked onto a normal thing (e.g. "super lamborghini", "mega bicycle", "ultra spoon") does NOT make it significantly more powerful — it's still just a fast car, a bike, or a spoon. A larger/more powerful entity (e.g. "T-Rex") should beat a smaller/weaker one (e.g. "Chicken"). A weapon (e.g. "Laser Cannon") beats an unarmored creature (e.g. "Deer"). A god-level entity (e.g. "Zeus") beats a mortal one (e.g. "Soldier"), but a clever mortal could slightly damage a god (counterDamage ~5). Always think step by step: which one would realistically win in a fight, and by how much?
- POWER DIFFERENCE: If one entity is only slightly stronger than the other, keep damage low (10-15) and counterDamage 5-10. If there's a clear power gap (e.g. tank vs bicycle), damage 20-30 and counterDamage 0-5. If one utterly dominates (e.g. nuclear bomb vs ant, Optimus Prime vs sports car, T-Rex vs house cat), damage 35-40 and counterDamage 0. Disqualifications use 40. The loser should still get SOME counter-damage unless they are completely helpless.
- EMOJIS: Pick a single creative emoji that best represents each entity. For example, "dragon" → "🐉", "water droplet" → "💧", "laser gun" → "🔫".
- "damage" is dealt TO the loser by the winner. "counterDamage" is dealt TO the winner by the loser.
- Be creative, thematic, and fair. Think about which entity is naturally stronger and by how much.`;

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
app.post('/api/leave-room', async (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  for (const [code, room] of rooms.entries()) {
    if (room.p1?.userId === user.uid || room.p2?.userId === user.uid) {
      // If in active battle, forfeit instead of silently deleting
      if (isInBattlePhase(room)) {
        const loserSide = room.p1.userId === user.uid ? 'p1' : 'p2';
        await forfeitPlayer(room, loserSide);
      } else {
        clearTimeout(room.roundTimer);
        clearTimeout(room.advanceTimer);
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

  // If in active battle, check if opponent disconnected
  if (isInBattlePhase(room)) {
    const oppSide = isP1 ? 'p2' : 'p1';
    const now = Date.now();
    const oppLastPoll = room[oppSide].lastPollTime || 0;

    if (now - oppLastPoll > 20000) {
      // Opponent has been gone >20s — they forfeit
      await forfeitPlayer(room, oppSide);
    } else if (now - oppLastPoll > 5000) {
      // Opponent has been gone >5s but <20s — show a warning in the state
      // We can add an optional field, but it's optional on the client
    }
  }

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
