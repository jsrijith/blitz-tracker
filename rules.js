// Rules and numbers for the stall. Nothing here touches the page or the browser's storage,
// so it can be tested with `node --test`.

export const DATA_VERSION = 1;
export const GAMES_PER_TOKEN = 2;
export const PLAYER_TYPES = ["student", "teacher"];
export const RESULTS = ["won", "lost"];
export const CLASS_KINDS = ["grade", "year"];
export const LONG_GAME_MINUTES = 20; // a game on longer than this may have been forgotten
export const MAX_LIMIT_MINUTES = 120; // the longest time limit a game can have
export const SOON_SECONDS = 60; // a timed game's last minute is shown as nearly up
export const LEFT_REASONS = ["left", "closed"]; // the player walked off, or the stall closed first // a student's class is a grade or a year, like Grade 5B

// "Grade 5B", "Year 5B", or just "5B" for a student saved before grade and year existed.
export function classLabel(p) {
  if (!p?.cls) return "";
  return p.clsKind ? `${p.clsKind.charAt(0).toUpperCase()}${p.clsKind.slice(1)} ${p.cls}` : p.cls;
}
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
    keepAwake: true,       // keep the phone's screen on while the app is open
    tokensCollected: null, // tokens counted in the box after the stall, to check against
  };
}

// ---- Tokens ---------------------------------------------------------------

// Returns an error message, or null if these games can start a token.
export function checkGamePick(data, gameIds) {
  if (gameIds.length !== GAMES_PER_TOKEN) return `Pick exactly ${GAMES_PER_TOKEN} games.`;
  if (gameIds[0] === gameIds[1]) return "Pick two different games.";
  for (const id of gameIds) {
    const g = data.games.find((x) => x.id === id);
    if (!g) return "Unknown game.";
    if (g.off) return `${g.name} isn't available right now.`;
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

// Tokens still going: not finished, and the player hasn't left.
export function openTokens(data) {
  return data.tokens.filter((t) => !t.finishedAt && !t.leftAt);
}

// Tokens whose player left before finishing, or that were still going when the stall closed.
export function leftTokens(data) {
  return data.tokens.filter((t) => t.leftAt);
}

// The player walked off (reason "left"), or the stall closed (reason "closed").
// A game they were on is stopped, so it's free for the next player.
export function markLeft(token, reason, now) {
  token.leftAt = now;
  token.leftReason = reason;
  for (const g of token.games) if (g.startedAt && !g.result) g.endedAt = now;
}

// Undoes markLeft: back in the queue, in their old place. A game stopped part way is played again.
export function bringBack(token) {
  delete token.leftAt;
  delete token.leftReason;
  for (const g of token.games) {
    if (g.startedAt && !g.result) {
      g.startedAt = null;
      g.endedAt = null;
    }
  }
}

// End of the day: every token still going is marked as not finished. Returns those tokens.
export function closeStall(data, now) {
  const open = openTokens(data);
  for (const t of open) markLeft(t, "closed", now);
  return open;
}

// True when a game has been on longer than LONG_GAME_MINUTES, so the stall should check on it.
export function isLongGame(g, now) {
  return g.startedAt != null && g.result == null && (now - Date.parse(g.startedAt)) / 60000 > LONG_GAME_MINUTES;
}

// ---- Time limits ----------------------------------------------------------
// A game can have a time limit, set in Setup. Its clock starts when the game is given out.

// A time limit typed in Setup: null when blank (no limit), whole minutes from 1 to
// MAX_LIMIT_MINUTES, or undefined when it isn't one.
export function parseLimit(text) {
  const s = String(text ?? "").trim();
  if (s === "") return null;
  if (!/^\d{1,3}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= MAX_LIMIT_MINUTES ? n : undefined;
}

// Seconds left on a game being played: 0 or less once time's up, null if its game has no limit.
export function secondsLeft(data, g, now) {
  const limit = data.games.find((x) => x.id === g.gameId)?.limit;
  if (!limit || g.startedAt == null || g.result != null) return null;
  return limit * 60 - Math.floor((now - Date.parse(g.startedAt)) / 1000);
}

// Games being played whose time is up, the one furthest over first.
export function timesUp(data, now) {
  return playingNow(data)
    .map((token) => {
      const index = token.games.findIndex(isPlaying);
      return { token, index, left: secondsLeft(data, token.games[index], now) };
    })
    .filter((x) => x.left != null && x.left <= 0)
    .sort((a, b) => a.left - b.left);
}

// 192 seconds as "3:12". A negative number (time over) is shown the same way.
export function countdownText(seconds) {
  const s = Math.abs(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
  return !token.finishedAt && !token.leftAt && isWaiting(g) && !isBusy(token)
    && !data.games.find((x) => x.id === g.gameId)?.off && !gameState(data, g.gameId).playing;
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
  const target = data.games.find((x) => x.id === newGameId);
  if (!target) return "Unknown game.";
  if (target.off) return `${target.name} isn't available right now.`;
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
export const QUIET_MINUTES = 10; // a gap with no game played at least this long is a quiet spell
export const QUICKEST_WIN_MIN_SECONDS = 60; // a win quicker than this was probably a mis-tap

// A student's grade or year without the section: "Grade 5" for Grade 5B, "5" for an old class like 5B.
// A class with no number at the start, like "KG", is its own grade.
export function gradeLabel(p) {
  if (!p?.cls) return "";
  const grade = p.cls.match(/^\s*(\d+)/)?.[1] ?? p.cls.trim();
  return p.clsKind ? `${p.clsKind.charAt(0).toUpperCase()}${p.clsKind.slice(1)} ${grade}` : grade;
}

// Grades in order: by kind, then by number, so Grade 3 comes before Grade 10.
function gradeOrder(a, b) {
  const split = (g) => [g.replace(/\d+$/, "").trim(), Number(g.match(/\d+$/)?.[0] ?? Infinity)];
  const [ka, na] = split(a);
  const [kb, nb] = split(b);
  return ka.localeCompare(kb) || na - nb || a.localeCompare(b);
}

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
    const endAt = t.finishedAt ?? t.leftAt;
    const end = endAt ? Date.parse(endAt) : now.getTime();
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
  const byClass = sortedEntries(countBy(playing.filter((p) => p.cls), classLabel)).map(([cls, count]) => ({ cls, count }));

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
    .map(({ cls }) => ({ cls, ...group(playing.filter((p) => p.cls && classLabel(p) === cls)) }))
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

  // Each game: how long a play takes, how busy it kept the stall, the wait before it, its best run ------
  const ms = (a, b) => Date.parse(b) - Date.parse(a);
  const isTimed = (g) => g.startedAt && g.endedAt && ms(g.startedAt, g.endedAt) >= 0;
  const openMinutes = firstStart ? ms(firstStart, lastFinish) / 60000 : 0;
  // The wait before a game: from joining the queue for the first game played, from the end of it for the second.
  const waitsBefore = (t) => {
    if (!t.games.every(isTimed)) return [];
    const [a, b] = [...t.games].sort((x, y) => x.startedAt.localeCompare(y.startedAt));
    return [
      { gameId: a.gameId, minutes: Math.max(0, ms(t.startedAt, a.startedAt)) / 60000 },
      { gameId: b.gameId, minutes: Math.max(0, ms(a.endedAt, b.startedAt)) / 60000 },
    ];
  };
  const allWaits = done.flatMap(waitsBefore);
  const average = (xs) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);
  // Plays in the order they ended, each with who played; a token finished by hand ends when it finished.
  const playsInOrder = done
    .flatMap((t) => t.games.map((g) => ({ ...g, playerId: t.playerId, endedAt: g.endedAt ?? t.finishedAt })))
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  for (const g of perGame) {
    const timed = done.flatMap((t) => t.games.filter((x) => x.gameId === g.gameId && isTimed(x)));
    const playMinutes = timed.map((x) => ms(x.startedAt, x.endedAt) / 60000);
    g.avgPlayMinutes = average(playMinutes);
    g.busyShare = timed.length && openMinutes > 0 ? Math.min(1, playMinutes.reduce((n, m) => n + m, 0) / openMinutes) : null;
    g.avgWait = average(allWaits.filter((w) => w.gameId === g.gameId).map((w) => w.minutes));
    let run = 0;
    g.bestRun = 0;
    for (const p of playsInOrder) {
      if (p.gameId !== g.gameId) continue;
      run = p.result === "lost" ? run + 1 : 0;
      g.bestRun = Math.max(g.bestRun, run);
    }
  }
  const withWaits = perGame.filter((g) => g.avgWait != null && allWaits.filter((w) => w.gameId === g.gameId).length >= MIN_PLAYS_FOR_RATE);
  const longestQueue = leaders(withWaits, (g) => g.avgWait).filter((g) => g.avgWait >= 1);
  const toughest = leaders(perGame, (g) => g.bestRun).filter((g) => g.bestRun >= 2);

  // Most players waiting at once: a token waits from joining the queue to its first game, and between games.
  // A token still waiting counts until `now`; one finished without starting its next game doesn't count.
  const waitEvents = [];
  const addWait = (from, to) => {
    if (from && to && ms(from, to) > 0) waitEvents.push([Date.parse(from), 1], [Date.parse(to), -1]);
  };
  for (const t of data.tokens) {
    const started = t.games.filter((g) => g.startedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const stillOpen = !t.finishedAt && !t.leftAt;
    const nowIso = now.toISOString();
    addWait(t.startedAt, started[0]?.startedAt ?? (stillOpen ? nowIso : null));
    if (started[0]?.endedAt) addWait(started[0].endedAt, started[1]?.startedAt ?? (stillOpen && !started[1] ? nowIso : null));
  }
  waitEvents.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let waiting = 0;
  let peakWaiting = { count: 0, at: null };
  for (const [at, step] of waitEvents) {
    waiting += step;
    if (waiting > peakWaiting.count) peakWaiting = { count: waiting, at: new Date(at).toISOString() };
  }

  // Quiet spells: stretches of the day with no game being played.
  const playSpans = data.tokens
    .flatMap((t) => t.games.filter(isTimed))
    .map((g) => [Date.parse(g.startedAt), Date.parse(g.endedAt)])
    .sort((a, b) => a[0] - b[0]);
  const quietSpells = [];
  let busyUntil = null;
  for (const [start, end] of playSpans) {
    if (busyUntil != null && start - busyUntil >= QUIET_MINUTES * 60000) {
      quietSpells.push({ from: new Date(busyUntil).toISOString(), to: new Date(start).toISOString(), minutes: (start - busyUntil) / 60000 });
    }
    busyUntil = Math.max(busyUntil ?? end, end);
  }

  // Quickest win: the shortest timed play that was won. Plays under a minute are probably a mis-tap.
  const wins = done.flatMap((t) => t.games
    .filter((g) => g.result === "won" && isTimed(g) && ms(g.startedAt, g.endedAt) >= QUICKEST_WIN_MIN_SECONDS * 1000)
    .map((g) => ({ playerId: t.playerId, gameId: g.gameId, minutes: ms(g.startedAt, g.endedAt) / 60000 })));
  const quickWin = leaders(wins, (w) => w.minutes, true)[0];
  const quickestWin = quickWin && { name: playerById.get(quickWin.playerId)?.name ?? "?", game: gameName(quickWin.gameId), minutes: quickWin.minutes };

  // Comebacks: lost the first game played in a token, then won the second. Needs the order, so timed tokens only.
  const comebackTokens = done.filter((t) => {
    if (!t.games.every((g) => g.endedAt)) return false;
    const [a, b] = [...t.games].sort((x, y) => x.endedAt.localeCompare(y.endedAt));
    return a.result === "lost" && b.result === "won";
  });
  const comebacks = sortedEntries(countBy(comebackTokens, (t) => t.playerId))
    .map(([id, count]) => ({ name: playerById.get(id)?.name ?? "?", count }));

  // Perfect record: two or more tokens, and every game won.
  const perfect = playing
    .filter((p) => tokensOf.get(p.id).length >= 2 && winsOf(p) === tokensOf.get(p.id).length * GAMES_PER_TOKEN)
    .map((p) => ({ name: p.name, tokens: tokensOf.get(p.id).length, wins: winsOf(p) }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  // Grades: classes put together by grade or year, so 5A and 5B count as Grade 5.
  const gradeStats = sortedEntries(countBy(playing.filter((p) => p.cls), gradeLabel))
    .map(([grade]) => ({ grade, ...group(playing.filter((p) => p.cls && gradeLabel(p) === grade)) }))
    .sort((a, b) => gradeOrder(a.grade, b.grade));

  // Checking the count -------------------------------------------------------
  const left = leftTokens(data);
  const count = {
    recorded: data.tokens.length,
    finished: done.length,
    left: left.filter((t) => t.leftReason === "left").length,
    closed: left.filter((t) => t.leftReason === "closed").length,
    open: openTokens(data).length,
    collected: data.tokensCollected ?? null,
  };
  count.difference = count.collected == null ? null : count.collected - count.recorded;

  return {
    count,
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
    longestQueue,
    toughest,
    peakWaiting,
    quietSpells,
    quickestWin,
    comebacks,
    perfect,
    gradeStats,
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
    "token_id", "player", "player_type", "class", "class_type", "registered_at",
    "game_1", "result_1", "game_2", "result_2",
    "won_any", "prize", "everyone_got", "started_at", "finished_at", "minutes", "waited_minutes", "status",
  ];
  const status = (t) => (t.finishedAt ? "finished" : t.leftReason === "closed" ? "stall closed" : "left");
  const rows = data.tokens.filter((t) => t.finishedAt || t.leftAt).map((t) => {
    const p = playerById.get(t.playerId) || {};
    const end = t.finishedAt ?? t.leftAt;
    const minutes = (Date.parse(end) - Date.parse(t.startedAt)) / 60000;
    return [
      t.id, p.name, p.type, p.cls, p.cls ? p.clsKind ?? "" : "", p.registeredAt,
      gameName(t.games[0].gameId), t.games[0].result, gameName(t.games[1].gameId), t.games[1].result,
      wonAny(t) ? "yes" : "no", rewardName(t.rewardId), t.finishedAt ? everyone : "", t.startedAt, end,
      Number.isFinite(minutes) ? minutes.toFixed(1) : "",
      waitMinutes(t)?.toFixed(1) ?? "",
      status(t),
    ];
  });
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// A length of time in words: "45 seconds", "1 minute 15 seconds", "75 minutes". Minutes never turn into hours.
export function durationText(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return "";
  const total = Math.max(0, Math.round(minutes * 60));
  const unit = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (total < 60) return unit(total, "second");
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${unit(m, "minute")} ${unit(s, "second")}` : unit(m, "minute");
}

// A time of day as 24-hour hh:mm in local time, from an ISO time or a minute of the day.
function clockText(value) {
  if (value == null) return "";
  const m = typeof value === "number" ? value : minuteOfDay(value);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const percent = (rate) => (rate == null ? "" : `${Math.round(rate * 100)}%`);

// The day's totals as a few small tables one under another, for a spreadsheet.
// Only finished tokens count, as on the Stats screen.
export function statsToCsv(data, now = new Date()) {
  const s = computeStats(data, now);
  const typeCount = (type) => s.byType.find((x) => x.type === type)?.count ?? 0;
  const prizesPicked = finishedTokens(data).filter((t) => t.rewardId != null).length;
  const named = (x) => x && `${x.name} (${durationText(x.minutes)})`;
  const busiest = s.busiest.filter((b) => b.count > 0).map((b) => clockText(b.start)).join(", ");

  const rows = [
    ["SUMMARY"],
    ["Players", s.uniquePlayers],
    ["Students", typeCount("student")],
    ["Teachers", typeCount("teacher")],
    ["Players who came back for another token", s.returning],
    ["Tokens", s.tokens],
    ["Games played", s.plays],
    ["Games won", s.gameWins],
    ["Games lost", s.gameLosses],
    ["Tokens with both games won", s.outcomes.wonBoth],
    ["Tokens with one game won", s.outcomes.wonOne],
    ["Tokens with both games lost", s.outcomes.lostBoth],
    ["Prizes picked", prizesPicked],
    ["First token started", clockText(s.firstStart)],
    ["Last token finished", clockText(s.lastFinish)],
    ["Busiest half hour", busiest],
    ["Average time per token", durationText(s.avgMinutes)],
    ["Longest token", named(s.longest) ?? ""],
    ["Quickest token", named(s.quickest) ?? ""],
    ["Average wait for a game", durationText(s.avgWait)],
    ["Longest wait", named(s.longestWait) ?? ""],
    ["Most players waiting at once", s.peakWaiting.count ? `${s.peakWaiting.count} at ${clockText(s.peakWaiting.at)}` : ""],
    ["Longest queue", s.longestQueue.map((g) => `${g.name} (${durationText(g.avgWait)} average wait)`).join(", ")],
    ["Toughest game", s.toughest.map((g) => `${g.name} (beat ${g.bestRun} players in a row)`).join(", ")],
    ["Quickest win", s.quickestWin ? `${s.quickestWin.name}, ${s.quickestWin.game} (${durationText(s.quickestWin.minutes)})` : ""],
    ["Perfect records", s.perfect.length],
    ["Comeback tokens (lost the first game, won the second)", s.comebacks.reduce((n, c) => n + c.count, 0)],
    [],
    ["GAMES"],
    ["Game", "Times played", "Won", "Lost", "Win rate", "Average length", "Busy (share of the day)", "Average wait before it", "Most players beaten in a row"],
    ...s.perGame.map((g) => [
      g.name, g.plays, g.wins, g.plays - g.wins, percent(g.winRate),
      durationText(g.avgPlayMinutes), percent(g.busyShare), durationText(g.avgWait), g.plays ? g.bestRun : "",
    ]),
    [],
    ["CLASSES"],
    ["Class", "Players", "Tokens", "Games won", "Games lost", "Win rate", "Favourite game"],
    ...s.classStats.map((c) => [c.cls, c.players, c.tokens, c.wins, c.plays - c.wins, percent(c.winRate), c.favourite.join(" / ")]),
    ...s.typeStats.map((t) => [
      t.type === "teacher" ? "All teachers" : "All students", t.players, t.tokens, t.wins, t.plays - t.wins,
      percent(t.winRate), t.favourite.join(" / "),
    ]),
    [],
    ["GRADES (sections put together)"],
    ["Grade", "Players", "Tokens", "Games won", "Games lost", "Win rate", "Favourite game"],
    ...s.gradeStats.map((g) => [g.grade, g.players, g.tokens, g.wins, g.plays - g.wins, percent(g.winRate), g.favourite.join(" / ")]),
    [],
    ["PRIZES"],
    ["Prize", "Given", "Started with", "Left"],
    ...s.rewards.map((r) => [r.name, r.count, r.stock ?? "", r.stock == null ? "" : r.left]),
    [],
    ["TOKENS STARTED PER HALF HOUR"],
    ["From", "Tokens"],
    ...s.slots.map((slot) => [clockText(slot.start), slot.count]),
    [],
    [`QUIET SPELLS (${QUIET_MINUTES} minutes or more with no game played)`],
    ["From", "To", "Length"],
    ...s.quietSpells.map((q) => [clockText(q.from), clockText(q.to), durationText(q.minutes)]),
    [],
    ["PERFECT RECORDS (two or more tokens, every game won)"],
    ["Player", "Tokens", "Games won"],
    ...s.perfect.map((p) => [p.name, p.tokens, p.wins]),
    [],
    ["COMEBACKS (lost the first game of a token, then won the second)"],
    ["Player", "Tokens"],
    ...s.comebacks.map((c) => [c.name, c.count]),
  ];
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
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
  if (!d.games.every((g) => g.off === undefined || typeof g.off === "boolean")) fail("a game's availability is broken");
  const okLimit = (v) => v == null || (Number.isInteger(v) && v >= 1 && v <= MAX_LIMIT_MINUTES);
  if (!d.games.every((g) => okLimit(g.limit))) fail("a game's time limit is broken");
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
    if (p.clsKind != null && !CLASS_KINDS.includes(p.clsKind)) fail("a player's grade or year is broken");
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
    if (t.leftAt != null && (!isTime(t.leftAt) || !LEFT_REASONS.includes(t.leftReason))) fail("a token has a bad leaving time");
  }
  if (typeof d.lastBackupTokens !== "number") d.lastBackupTokens = 0;
  if (d.keepAwake === undefined) d.keepAwake = true; // saved before the setting existed
  if (typeof d.keepAwake !== "boolean") fail("the screen setting is broken");
  if (d.tokensCollected === undefined) d.tokensCollected = null;
  if (d.tokensCollected !== null && !(Number.isInteger(d.tokensCollected) && d.tokensCollected >= 0)) fail("the token count is broken");
  return d;
}
