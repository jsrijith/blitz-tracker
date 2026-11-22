// Rules and numbers for the stall. Nothing here touches the page or the browser's storage,
// so it can be tested with `node --test`.

export const DATA_VERSION = 1;
export const GAMES_PER_TOKEN = 2;
export const PLAYER_TYPES = ["student", "teacher"];
export const RESULTS = ["won", "lost"];
export const DEFAULT_TITLE = "Game Stall";

// randomUUID() only exists on secure pages (https or localhost). Testing over plain http at an IP
// address, such as a PC's address opened on a phone, falls back to random bytes in the same format.
export function newId() {
  const c = globalThis.crypto;
  if (c.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function defaultData() {
  return {
    version: DATA_VERSION,
    title: DEFAULT_TITLE,
    games: Array.from({ length: 8 }, (_, i) => ({ id: `g${i + 1}`, name: `Game ${i + 1}` })),
    rewards: [
      // stock: how many the stall started with, or null if nobody is counting.
      { id: "sticker", name: "Sticker", everyone: true, stock: null },
      { id: "pen", name: "Pen", everyone: false, stock: null },
      { id: "crayons", name: "Crayons", everyone: false, stock: null },
      { id: "keychain", name: "Keychain", everyone: false, stock: null },
    ],
    players: [],
    tokens: [],
    lastBackupTokens: 0,
  };
}

// ---- Tokens ---------------------------------------------------------------

// Returns an error message, or null if these games can start a token.
export function checkGamePick(data, gameIds) {
  if (gameIds.length !== GAMES_PER_TOKEN) return `Pick exactly ${GAMES_PER_TOKEN} games.`;
  if (gameIds[0] === gameIds[1]) return "Pick two different games.";
  for (const id of gameIds) {
    if (!data.games.some((g) => g.id === id)) return "Unknown game.";
  }
  return null;
}

export function wonAny(token) {
  return token.games.some((g) => g.result === "won");
}

export function resultsComplete(token) {
  return token.games.every((g) => RESULTS.includes(g.result));
}

// Returns an error message, or null if the token can be finished with this reward.
// rewardId is null when the player won nothing, or chose not to take a prize.
export function checkFinish(data, token, rewardId) {
  if (!resultsComplete(token)) return "Set the result of both games.";
  if (rewardId == null) return null;
  if (!wonAny(token)) return "A prize is only for a player who won a game.";
  const reward = data.rewards.find((r) => r.id === rewardId);
  if (!reward) return "Unknown prize.";
  if (reward.everyone) return "Everyone gets that one already.";
  return null;
}

export function openTokens(data) {
  return data.tokens.filter((t) => !t.finishedAt);
}

export function finishedTokens(data) {
  return data.tokens.filter((t) => t.finishedAt);
}

// ---- The queue and who is playing ------------------------------------------
// There is one copy of each game. Each game in a token is in one of three states:
//   waiting: no startedAt and no result
//   playing: startedAt set, no result yet
//   done:    result set (endedAt is when)
// A new token goes into the queue. The stall gives the player one of their games when it's free;
// after it, the player is back in the queue, in the same place, for their other game.

const isPlaying = (g) => g.startedAt != null && g.result == null;
const isWaiting = (g) => g.startedAt == null && g.result == null;
const byRegistration = (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);

export function isBusy(token) {
  return token.games.some(isPlaying);
}

// Who is on a game (or null), and which queued tokens still want it, earliest first.
export function gameState(data, gameId) {
  let playing = null;
  const wanted = [];
  for (const token of openTokens(data).sort(byRegistration)) {
    token.games.forEach((g, index) => {
      if (g.gameId !== gameId) return;
      if (isPlaying(g) && !playing) playing = { token, index };
      else if (isWaiting(g) && !isBusy(token)) wanted.push({ token, index });
    });
  }
  return { playing, wanted };
}

// Tokens waiting for their next game, in the order they registered.
export function queue(data) {
  return openTokens(data).filter((t) => !isBusy(t) && t.games.some(isWaiting)).sort(byRegistration);
}

// Tokens on a game now, the one that started first first.
export function playingNow(data) {
  const startOf = (t) => t.games.find(isPlaying).startedAt;
  return openTokens(data).filter(isBusy).sort((a, b) => startOf(a).localeCompare(startOf(b)));
}

// Can this token be given this game now?
export function canGive(data, token, index) {
  const g = token.games[index];
  return !token.finishedAt && isWaiting(g) && !isBusy(token) && !gameState(data, g.gameId).playing;
}

// A new token: into the queue. Returns the token (already added to data) and its place in the queue.
export function startToken(data, playerId, gameIds, now) {
  const token = {
    id: newId(), playerId, startedAt: now, rewardId: null, finishedAt: null,
    games: gameIds.map((gameId) => ({ gameId, result: null, startedAt: null, endedAt: null })),
  };
  data.tokens.push(token);
  return { token, place: queue(data).indexOf(token) + 1 };
}

// Returns an error message, or null if a queued player may swap this game for newGameId.
export function checkChange(data, token, index, newGameId) {
  const g = token.games[index];
  if (!g || !isWaiting(g)) return "Only a game they haven't started can be changed.";
  if (!data.games.some((x) => x.id === newGameId)) return "Unknown game.";
  if (token.games.some((x) => x.gameId === newGameId)) return "They already have that game.";
  return null;
}

// Swaps a game the player is still waiting for. Their place in the queue stays the same.
// registeredGameId keeps what they picked when they registered; it goes if they change back.
export function changeGame(token, index, newGameId) {
  const g = token.games[index];
  const first = g.registeredGameId ?? g.gameId;
  g.gameId = newGameId;
  if (newGameId === first) delete g.registeredGameId;
  else g.registeredGameId = first;
}

export function startGame(token, index, now) {
  const g = token.games[index];
  g.startedAt = now;
  g.endedAt = null;
  g.result = null;
}

export function endGame(token, index, result, now) {
  const g = token.games[index];
  g.result = result;
  g.endedAt = now;
}

// Minutes the player stood waiting: before their first game, and between the two.
// null when the token has no table times (tokens from before the line existed, or finished by hand).
export function waitMinutes(token) {
  const games = [...token.games].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  if (!games.every((g) => g.startedAt && g.endedAt)) return null;
  const ms = (a, b) => Math.max(0, Date.parse(b) - Date.parse(a));
  return (ms(token.startedAt, games[0].startedAt) + ms(games[0].endedAt, games[1].startedAt)) / 60000;
}

// ---- Prize stock ----------------------------------------------------------

// How many of a prize have gone out. Everyone's prize goes out once per finished token.
export function givenCount(data, reward) {
  const done = finishedTokens(data);
  return reward.everyone ? done.length : done.filter((t) => t.rewardId === reward.id).length;
}

// What's left of a prize, or null when no starting quantity was entered.
// Can go below zero if more were handed out than were counted in.
export function leftCount(data, reward) {
  return reward.stock == null ? null : reward.stock - givenCount(data, reward);
}

// Reads a quantity typed in Setup: a whole number from 0 up, or null for blank.
// Returns undefined for anything else, so the caller can refuse it.
export function parseStock(text) {
  const s = String(text ?? "").trim();
  if (s === "") return null;
  if (!/^\d{1,6}$/.test(s)) return undefined;
  return Number(s);
}

// ---- Stats ----------------------------------------------------------------

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

export function pairKey(gameIdA, gameIdB) {
  return [gameIdA, gameIdB].sort().join("+");
}

export const SLOT_MINUTES = 30; // the busy-times chart counts tokens in half hours
export const MIN_PLAYS_FOR_RATE = 3; // a game needs this many plays to be called hardest or easiest

// Every item tied for the highest (or lowest) value.
function leaders(items, valueOf, lowest = false) {
  if (!items.length) return [];
  const values = items.map(valueOf);
  const best = lowest ? Math.min(...values) : Math.max(...values);
  return items.filter((_, i) => values[i] === best);
}

const minuteOfDay = (iso) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

// The most tokens being played at the same moment, and when that first happened.
// Tokens still in play count as running until `now`.
function peakInPlay(tokens, now) {
  const events = [];
  for (const t of tokens) {
    const start = Date.parse(t.startedAt);
    const end = t.finishedAt ? Date.parse(t.finishedAt) : now.getTime();
    events.push([start, 1], [Math.max(start, end), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // a finish at the same moment goes first
  let count = 0;
  let peak = { count: 0, at: null };
  for (const [at, step] of events) {
    count += step;
    if (count > peak.count) peak = { count, at: new Date(at).toISOString() };
  }
  return peak;
}

export function computeStats(data, now = new Date()) {
  const done = finishedTokens(data);
  const playerById = new Map(data.players.map((p) => [p.id, p]));
  const gameName = (id) => data.games.find((g) => g.id === id)?.name ?? "?";
  const minutes = (t) => (Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 60000;
  const rate = (wins, plays) => (plays ? wins / plays : null);

  // Games ---------------------------------------------------------------
  const perGame = data.games.map((g) => {
    const plays = done.flatMap((t) => t.games.filter((x) => x.gameId === g.id));
    const wins = plays.filter((x) => x.result === "won").length;
    return { gameId: g.id, name: g.name, plays: plays.length, wins, winRate: rate(wins, plays.length) };
  });
  const rated = perGame.filter((g) => g.plays >= MIN_PLAYS_FOR_RATE);
  const games = done.length
    ? {
        mostPopular: leaders(perGame, (g) => g.plays),
        leastPopular: leaders(perGame, (g) => g.plays, true),
        neverPlayed: perGame.filter((g) => g.plays === 0),
        hardest: leaders(rated, (g) => g.winRate, true),
        easiest: leaders(rated, (g) => g.winRate),
      }
    : { mostPopular: [], leastPopular: [], neverPlayed: [], hardest: [], easiest: [] };

  const pairs = sortedEntries(countBy(done, (t) => pairKey(t.games[0].gameId, t.games[1].gameId))).map(
    ([key, count]) => ({ names: key.split("+").map(gameName), count }),
  );

  // Results -------------------------------------------------------------
  const winsIn = (t) => t.games.filter((g) => g.result === "won").length;
  const outcomes = {
    wonBoth: done.filter((t) => winsIn(t) === 2).length,
    wonOne: done.filter((t) => winsIn(t) === 1).length,
    lostBoth: done.filter((t) => winsIn(t) === 0).length,
  };
  const gameWins = done.reduce((n, t) => n + winsIn(t), 0);
  const gameLosses = done.length * GAMES_PER_TOKEN - gameWins;

  // Prizes --------------------------------------------------------------
  const rewards = data.rewards.map((r) => ({
    rewardId: r.id,
    name: r.name,
    count: givenCount(data, r),
    stock: r.stock ?? null,
    left: leftCount(data, r),
  }));
  const winners = done.filter(wonAny).length;
  const noPick = done.filter((t) => wonAny(t) && t.rewardId == null).length;
  const pickedPrizes = rewards.filter((r) => !data.rewards.find((x) => x.id === r.rewardId).everyone && r.count > 0);
  const topPrize = leaders(pickedPrizes, (r) => r.count);

  // Busy times ------------------------------------------------------------
  // Half-hour slots from the first token to the last, empty ones included, so quiet spells show.
  let slots = [];
  if (done.length) {
    const slotOf = (t) => Math.floor(minuteOfDay(t.startedAt) / SLOT_MINUTES) * SLOT_MINUTES;
    const counts = countBy(done, slotOf);
    const keys = [...counts.keys()];
    for (let m = Math.min(...keys); m <= Math.max(...keys); m += SLOT_MINUTES) {
      slots.push({ start: m, count: counts.get(m) || 0 });
    }
  }
  const busiest = leaders(slots, (s) => s.count);
  const quietest = slots.length > 2 ? leaders(slots, (s) => s.count, true) : [];
  const starts = done.map((t) => t.startedAt).sort();
  const finishes = done.map((t) => t.finishedAt).sort();
  const firstStart = starts[0] ?? null;
  const lastFinish = finishes.at(-1) ?? null;
  const openHours = firstStart ? (Date.parse(lastFinish) - Date.parse(firstStart)) / 3600000 : null;
  const peak = peakInPlay(data.tokens, now);

  // Time per token ----------------------------------------------------------
  const timed = done.filter((t) => minutes(t) >= 0);
  const avgMinutes = timed.length ? timed.reduce((n, t) => n + minutes(t), 0) / timed.length : null;
  const longest = leaders(timed, minutes)[0];
  const quickest = leaders(timed, minutes, true)[0];
  const tokenTime = (t) => t && { name: playerById.get(t.playerId)?.name ?? "?", minutes: minutes(t) };

  // Waiting for a game ----------------------------------------------------------
  const waited = done.filter((t) => waitMinutes(t) != null);
  const avgWait = waited.length ? waited.reduce((n, t) => n + waitMinutes(t), 0) / waited.length : null;
  const longestWaitToken = leaders(waited, waitMinutes)[0];
  const longestWait = longestWaitToken && { name: playerById.get(longestWaitToken.playerId)?.name ?? "?", minutes: waitMinutes(longestWaitToken) };

  // Players ---------------------------------------------------------------
  const tokensOf = new Map();
  for (const t of done) tokensOf.set(t.playerId, [...(tokensOf.get(t.playerId) || []), t]);
  const playing = [...tokensOf.keys()].map((id) => playerById.get(id)).filter(Boolean);
  const winsOf = (p) => tokensOf.get(p.id).reduce((n, t) => n + winsIn(t), 0);
  const playersWon = playing.filter((p) => winsOf(p) > 0).length;

  const byType = sortedEntries(countBy(playing, (p) => p.type)).map(([type, count]) => ({ type, count }));
  const byClass = sortedEntries(countBy(playing.filter((p) => p.cls), (p) => p.cls)).map(([cls, count]) => ({ cls, count }));

  // Results for a group of players: students, teachers, or one class.
  const group = (members) => {
    const tokens = members.flatMap((p) => tokensOf.get(p.id));
    const plays = tokens.flatMap((t) => t.games);
    const wins = plays.filter((g) => g.result === "won").length;
    const favourite = leaders(sortedEntries(countBy(plays, (g) => g.gameId)), ([, n]) => n).map(([id]) => gameName(id));
    return { players: members.length, tokens: tokens.length, wins, plays: plays.length, winRate: rate(wins, plays.length), favourite };
  };
  const typeStats = byType.map(({ type }) => ({ type, ...group(playing.filter((p) => p.type === type)) }));
  const classStats = byClass
    .map(({ cls }) => ({ cls, ...group(playing.filter((p) => p.cls === cls)) }))
    .sort((a, b) => b.tokens - a.tokens || a.cls.localeCompare(b.cls));

  const topPlayers = sortedEntries(countBy(done, (t) => t.playerId))
    .slice(0, 5)
    .map(([id, tokens]) => ({ name: playerById.get(id)?.name ?? "?", tokens }));
  const topWinners = playing
    .map((p) => ({ name: p.name, wins: winsOf(p), plays: tokensOf.get(p.id).length * GAMES_PER_TOKEN }))
    .filter((p) => p.wins > 0)
    .sort((a, b) => b.wins - a.wins || a.plays - b.plays || a.name.localeCompare(b.name))
    .slice(0, 5);
  const returning = playing.filter((p) => tokensOf.get(p.id).length >= 2).length;

  return {
    tokens: done.length,
    inPlay: openTokens(data).length,
    plays: done.length * GAMES_PER_TOKEN,
    uniquePlayers: playing.length,
    winners,
    noPick,
    outcomes,
    gameWins,
    gameLosses,
    playersWon,
    playersNeverWon: playing.length - playersWon,
    returning,
    perGame,
    games,
    pairs,
    rewards,
    topPrize,
    slots,
    busiest,
    quietest,
    peak,
    firstStart,
    lastFinish,
    tokensPerHour: openHours >= 0.5 ? done.length / openHours : null,
    avgMinutes,
    longest: tokenTime(longest),
    quickest: tokenTime(quickest),
    avgWait,
    longestWait,
    byType,
    byClass,
    typeStats,
    classStats,
    topPlayers,
    topWinners,
  };
}

// ---- Export and backup ----------------------------------------------------

export function csvField(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function tokensToCsv(data) {
  const playerById = new Map(data.players.map((p) => [p.id, p]));
  const gameName = (id) => data.games.find((g) => g.id === id)?.name ?? "";
  const rewardName = (id) => data.rewards.find((r) => r.id === id)?.name ?? "";
  const everyone = data.rewards.filter((r) => r.everyone).map((r) => r.name).join(" + ");

  const header = [
    "token_id", "player", "player_type", "class", "registered_at",
    "game_1", "result_1", "game_2", "result_2",
    "won_any", "prize", "everyone_got", "started_at", "finished_at", "minutes", "waited_minutes",
  ];
  const rows = finishedTokens(data).map((t) => {
    const p = playerById.get(t.playerId) || {};
    const minutes = (Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 60000;
    return [
      t.id, p.name, p.type, p.cls, p.registeredAt,
      gameName(t.games[0].gameId), t.games[0].result, gameName(t.games[1].gameId), t.games[1].result,
      wonAny(t) ? "yes" : "no", rewardName(t.rewardId), everyone, t.startedAt, t.finishedAt,
      Number.isFinite(minutes) ? minutes.toFixed(1) : "",
      waitMinutes(t)?.toFixed(1) ?? "",
    ];
  });
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// Checks a backup or stored copy, and returns it if every part makes sense.
// Throws an Error with a readable message otherwise, so nothing half-loaded replaces good data.
export function parseData(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a backup (not JSON).");
  }
  const fail = (why) => {
    throw new Error(`That backup can't be used: ${why}.`);
  };
  const isStr = (v) => typeof v === "string" && v.length > 0;
  const isTime = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

  if (!d || typeof d !== "object") fail("it is empty");
  if (d.version !== DATA_VERSION) fail(`unknown version ${d.version}`);
  for (const key of ["games", "rewards", "players", "tokens"]) {
    if (!Array.isArray(d[key])) fail(`${key} is missing`);
  }
  if (!d.games.every((g) => isStr(g.id) && isStr(g.name))) fail("a game has no name");
  if (!d.rewards.every((r) => isStr(r.id) && isStr(r.name) && typeof r.everyone === "boolean")) fail("a prize is broken");
  for (const r of d.rewards) {
    if (r.stock === undefined) r.stock = null; // saved before quantities existed
    if (r.stock !== null && !(Number.isInteger(r.stock) && r.stock >= 0)) fail("a prize quantity is broken");
  }
  if (d.title === undefined) d.title = DEFAULT_TITLE; // saved before the title existed
  if (!isStr(d.title)) fail("the title is broken");

  const playerIds = new Set();
  for (const p of d.players) {
    if (!isStr(p.id) || !isStr(p.name) || !PLAYER_TYPES.includes(p.type) || !isTime(p.registeredAt)) fail("a player is broken");
    if (p.cls != null && typeof p.cls !== "string") fail("a player's class is broken");
    playerIds.add(p.id);
  }
  const gameIds = new Set(d.games.map((g) => g.id));
  const rewardIds = new Set(d.rewards.map((r) => r.id));
  for (const t of d.tokens) {
    if (!isStr(t.id) || !playerIds.has(t.playerId) || !isTime(t.startedAt)) fail("a token is broken");
    if (!Array.isArray(t.games) || t.games.length !== GAMES_PER_TOKEN) fail("a token doesn't have 2 games");
    for (const g of t.games) {
      if (!gameIds.has(g.gameId)) fail("a token names an unknown game");
      if (g.registeredGameId != null && !gameIds.has(g.registeredGameId)) fail("a token names an unknown game");
      if (g.result != null && !RESULTS.includes(g.result)) fail("a token has an unknown result");
      for (const key of ["startedAt", "endedAt"]) {
        if (g[key] === undefined) g[key] = null; // saved before the queue existed
        if (g[key] !== null && !isTime(g[key])) fail("a token has a bad game time");
      }
    }
    if (t.rewardId != null && !rewardIds.has(t.rewardId)) fail("a token names an unknown prize");
    if (t.finishedAt != null && !isTime(t.finishedAt)) fail("a token has a bad finish time");
  }
  if (typeof d.lastBackupTokens !== "number") d.lastBackupTokens = 0;
  return d;
}
