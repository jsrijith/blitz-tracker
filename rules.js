// Rules and numbers for the stall. Nothing here touches the page or the browser's storage,
// so it can be tested with `node --test`.

export const DATA_VERSION = 1;
export const GAMES_PER_TOKEN = 2;
export const PLAYER_TYPES = ["student", "teacher"];
export const RESULTS = ["won", "lost"];
export const DEFAULT_TITLE = "Game Stall";

export function newId() {
  return globalThis.crypto.randomUUID();
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

export function computeStats(data) {
  const done = finishedTokens(data);
  const playerById = new Map(data.players.map((p) => [p.id, p]));
  const gameName = (id) => data.games.find((g) => g.id === id)?.name ?? "?";

  const perGame = data.games.map((g) => {
    const plays = done.flatMap((t) => t.games.filter((x) => x.gameId === g.id));
    const wins = plays.filter((x) => x.result === "won").length;
    return {
      gameId: g.id,
      name: g.name,
      plays: plays.length,
      wins,
      winRate: plays.length ? wins / plays.length : null,
    };
  });

  const pairs = sortedEntries(countBy(done, (t) => pairKey(t.games[0].gameId, t.games[1].gameId))).map(
    ([key, count]) => ({ names: key.split("+").map(gameName), count }),
  );

  const rewards = data.rewards.map((r) => ({
    rewardId: r.id,
    name: r.name,
    count: givenCount(data, r),
    stock: r.stock ?? null,
    left: leftCount(data, r),
  }));
  const winners = done.filter(wonAny).length;
  const noPick = done.filter((t) => wonAny(t) && t.rewardId == null).length;

  const perHour = sortedEntries(countBy(done, (t) => new Date(t.startedAt).getHours()))
    .map(([hour, count]) => ({ hour: Number(hour), count }))
    .sort((a, b) => a.hour - b.hour);

  const durations = done.map((t) => Date.parse(t.finishedAt) - Date.parse(t.startedAt)).filter((ms) => ms >= 0);
  const avgMinutes = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length / 60000 : null;

  const tokenPlayers = done.map((t) => playerById.get(t.playerId)).filter(Boolean);
  const uniquePlayers = new Set(tokenPlayers.map((p) => p.id));
  const uniqueList = [...uniquePlayers].map((id) => playerById.get(id));
  const byType = sortedEntries(countBy(uniqueList, (p) => p.type)).map(([type, count]) => ({ type, count }));
  const byClass = sortedEntries(countBy(uniqueList.filter((p) => p.cls), (p) => p.cls)).map(([cls, count]) => ({ cls, count }));

  const topPlayers = sortedEntries(countBy(done, (t) => t.playerId))
    .slice(0, 5)
    .map(([id, tokens]) => ({ name: playerById.get(id)?.name ?? "?", tokens }));

  return {
    tokens: done.length,
    inPlay: openTokens(data).length,
    plays: done.length * GAMES_PER_TOKEN,
    uniquePlayers: uniquePlayers.size,
    winners,
    noPick,
    perGame,
    pairs,
    rewards,
    perHour,
    avgMinutes,
    byType,
    byClass,
    topPlayers,
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
    "won_any", "prize", "everyone_got", "started_at", "finished_at", "minutes",
  ];
  const rows = finishedTokens(data).map((t) => {
    const p = playerById.get(t.playerId) || {};
    const minutes = (Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 60000;
    return [
      t.id, p.name, p.type, p.cls, p.registeredAt,
      gameName(t.games[0].gameId), t.games[0].result, gameName(t.games[1].gameId), t.games[1].result,
      wonAny(t) ? "yes" : "no", rewardName(t.rewardId), everyone, t.startedAt, t.finishedAt,
      Number.isFinite(minutes) ? minutes.toFixed(1) : "",
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
      if (g.result != null && !RESULTS.includes(g.result)) fail("a token has an unknown result");
    }
    if (t.rewardId != null && !rewardIds.has(t.rewardId)) fail("a token names an unknown prize");
    if (t.finishedAt != null && !isTime(t.finishedAt)) fail("a token has a bad finish time");
  }
  if (typeof d.lastBackupTokens !== "number") d.lastBackupTokens = 0;
  return d;
}
