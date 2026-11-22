// The queue: tokens wait in registration order, and the stall gives each player a free game.
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultData, gameState, queue, playingNow, canGive, startToken, startGame, endGame, isBusy, waitMinutes,
  checkChange, changeGame, markLeft, bringBack, closeStall, leftTokens, isLongGame, checkGamePick,
  computeStats, tokensToCsv, parseData,
} from "../rules.js";

// Minutes after 09:00 as an ISO time, so tests read as a timeline.
const at = (min) => new Date(Date.UTC(2026, 10, 28, 9, min)).toISOString();

function stall() {
  const d = defaultData();
  for (const name of ["Alice", "Bob", "Carol", "Dev"]) {
    d.players.push({ id: name, name, type: "student", cls: "", registeredAt: at(0) });
  }
  return d;
}
const names = (tokens) => tokens.map((t) => t.playerId);

test("a new token goes into the queue, even when its games are free", () => {
  const d = stall();
  const r = startToken(d, "Alice", ["g1", "g2"], at(0));
  assert.equal(r.place, 1);
  assert.equal(isBusy(r.token), false);
  assert.deepEqual(names(queue(d)), ["Alice"]);
  assert.deepEqual(playingNow(d), []);
});

test("the queue is in registration order, and a player leaves it while playing", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  startToken(d, "Bob", ["g1", "g3"], at(1));
  assert.equal(startToken(d, "Carol", ["g4", "g5"], at(2)).place, 3);
  startGame(a, 0, at(3));
  assert.deepEqual(names(queue(d)), ["Bob", "Carol"]);
  assert.deepEqual(names(playingNow(d)), ["Alice"]);
});

test("after the first game the player is back in the queue in their old place", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  startToken(d, "Bob", ["g3", "g4"], at(1));
  startGame(a, 0, at(2));
  endGame(a, 0, "won", at(10));
  assert.deepEqual(names(queue(d)), ["Alice", "Bob"]);
});

test("a game can only be given when it's free and the player isn't playing", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  const b = startToken(d, "Bob", ["g1", "g3"], at(1)).token;
  assert.equal(canGive(d, b, 0), true);
  startGame(a, 0, at(2));
  assert.equal(canGive(d, b, 0), false, "Alice has g1");
  assert.equal(canGive(d, b, 1), true, "g3 is free");
  assert.equal(canGive(d, a, 1), false, "Alice is busy on g1");
  endGame(a, 0, "lost", at(9));
  assert.equal(canGive(d, b, 0), true, "g1 is free again");
  assert.equal(canGive(d, a, 0), false, "Alice already played g1");
});

test("who is on a game, and who in the queue still wants it", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  const b = startToken(d, "Bob", ["g1", "g2"], at(1)).token;
  startToken(d, "Carol", ["g2", "g1"], at(2));
  startGame(b, 1, at(3));
  const s = gameState(d, "g2");
  assert.equal(s.playing.token, b);
  assert.deepEqual(s.wanted.map((x) => x.token.playerId), ["Alice", "Carol"]);
  assert.deepEqual(gameState(d, "g1").wanted.map((x) => x.token.playerId), ["Alice", "Carol"], "Bob is busy");
  startGame(a, 0, at(4));
  assert.deepEqual(gameState(d, "g1").wanted.map((x) => x.token.playerId), ["Carol"]);
});

test("cancelling a token frees its game and takes it out of the queue", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  const b = startToken(d, "Bob", ["g1", "g3"], at(1)).token;
  startGame(a, 0, at(2));
  d.tokens.splice(d.tokens.indexOf(a), 1);
  assert.equal(gameState(d, "g1").playing, null);
  assert.equal(canGive(d, b, 0), true);
  assert.deepEqual(names(queue(d)), ["Bob"]);
});

test("time spent waiting, before the first game and between the two", () => {
  const t = {
    startedAt: at(0),
    games: [
      { gameId: "g1", result: "won", startedAt: at(25), endedAt: at(35) },
      { gameId: "g2", result: "lost", startedAt: at(5), endedAt: at(20) },
    ],
  };
  assert.equal(waitMinutes(t), 5 + 5);
  assert.equal(waitMinutes({ startedAt: at(0), games: [{ gameId: "g1", result: "won" }, { gameId: "g2", result: "won" }] }), null);
});

test("wait stats and the CSV column", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  const b = startToken(d, "Bob", ["g1", "g3"], at(0)).token;
  startGame(a, 0, at(0)); endGame(a, 0, "won", at(10)); startGame(a, 1, at(10)); endGame(a, 1, "won", at(20));
  a.finishedAt = at(21);
  startGame(b, 1, at(0)); endGame(b, 1, "lost", at(5)); startGame(b, 0, at(12)); endGame(b, 0, "won", at(22));
  b.finishedAt = at(23);
  const s = computeStats(d);
  assert.equal(s.avgWait, 3.5); // Alice 0, Bob 7
  assert.deepEqual(s.longestWait, { name: "Bob", minutes: 7 });
  const rows = tokensToCsv(d).trim().split("\r\n");
  assert.ok(rows[0].endsWith(",waited_minutes,status"));
  assert.ok(rows[2].endsWith(",7.0,finished"));
});

test("game times survive a backup, and a bad one is refused", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  startGame(a, 0, at(1));
  const back = parseData(JSON.stringify(d));
  assert.equal(back.tokens[0].games[0].startedAt, at(1));
  assert.equal(gameState(back, "g1").playing.token.playerId, "Alice");
  back.tokens[0].games[1].endedAt = "soon";
  assert.throws(() => parseData(JSON.stringify(back)), /bad game time/);
});

test("a token saved before the queue existed loads, and is in the queue", () => {
  const d = stall();
  d.tokens.push({ id: "old", playerId: "Alice", startedAt: at(0), rewardId: null, finishedAt: null,
    games: [{ gameId: "g1", result: null }, { gameId: "g2", result: null }] });
  const back = parseData(JSON.stringify(d));
  assert.equal(back.tokens[0].games[0].startedAt, null);
  assert.deepEqual(names(queue(back)), ["Alice"]);
});

test("a player in the queue can change a game they haven't started, and keeps their place", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  const b = startToken(d, "Bob", ["g1", "g3"], at(1)).token;
  startGame(a, 0, at(2));
  assert.equal(canGive(d, b, 0), false, "Alice has g1");

  assert.equal(checkChange(d, b, 0, "g4"), null);
  changeGame(b, 0, "g4");
  assert.equal(b.games[0].gameId, "g4");
  assert.equal(canGive(d, b, 0), true, "g4 is free");

  startToken(d, "Carol", ["g5", "g6"], at(3));
  assert.deepEqual(names(queue(d)), ["Bob", "Carol"], "Bob kept his place");
});

test("a change is refused for the same game twice, a game started or played, or an unknown game", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  assert.match(checkChange(d, a, 0, "g2"), /already have/);
  assert.match(checkChange(d, a, 0, "g1"), /already have/);
  assert.match(checkChange(d, a, 0, "g99"), /Unknown/);
  startGame(a, 0, at(1));
  assert.match(checkChange(d, a, 0, "g3"), /haven't started/);
  endGame(a, 0, "won", at(5));
  assert.match(checkChange(d, a, 0, "g3"), /haven't started/);
  assert.equal(checkChange(d, a, 1, "g3"), null, "the second game can still change");
});

test("a change remembers the game picked at registration, and forgets it on changing back", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  changeGame(a, 0, "g3");
  changeGame(a, 0, "g4");
  assert.deepEqual([a.games[0].gameId, a.games[0].registeredGameId], ["g4", "g1"]);
  assert.equal(parseData(JSON.stringify(d)).tokens[0].games[0].registeredGameId, "g1");
  changeGame(a, 0, "g1");
  assert.equal(a.games[0].gameId, "g1");
  assert.equal("registeredGameId" in a.games[0], false);
});

test("a player who leaves is out of the queue, and their game is free", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  const b = startToken(d, "Bob", ["g1", "g3"], at(1)).token;
  startGame(a, 0, at(2));
  markLeft(a, "left", at(5));
  assert.deepEqual(names(playingNow(d)), []);
  assert.equal(canGive(d, b, 0), true, "g1 is free again");
  assert.deepEqual(names(leftTokens(d)), ["Alice"]);
  assert.equal(canGive(d, a, 1), false, "nothing is given to a player who left");

  markLeft(b, "left", at(6));
  assert.deepEqual(names(queue(d)), []);
});

test("bringing a player back puts them in their old place, and a stopped game is played again", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  startToken(d, "Bob", ["g3", "g4"], at(1));
  startGame(a, 0, at(2));
  markLeft(a, "left", at(5));
  bringBack(a);
  assert.equal("leftAt" in a, false);
  assert.deepEqual(names(queue(d)), ["Alice", "Bob"]);
  assert.equal(a.games[0].startedAt, null);
  assert.equal(canGive(d, a, 0), true);
});

test("closing the stall marks every unfinished token, and the stats count them", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  startGame(a, 0, at(0)); endGame(a, 0, "won", at(5)); startGame(a, 1, at(5)); endGame(a, 1, "lost", at(9));
  a.finishedAt = at(10);
  const b = startToken(d, "Bob", ["g1", "g3"], at(1)).token;
  markLeft(b, "left", at(3));
  const c = startToken(d, "Carol", ["g4", "g5"], at(2)).token;
  startGame(c, 0, at(4));
  startToken(d, "Dev", ["g6", "g7"], at(3));

  assert.deepEqual(names(closeStall(d, at(30))), ["Carol", "Dev"]);
  assert.deepEqual(queue(d), []);
  assert.deepEqual(playingNow(d), []);
  d.tokensCollected = 5;
  const s = computeStats(d);
  assert.deepEqual(s.count, { recorded: 4, finished: 1, left: 1, closed: 2, open: 0, collected: 5, difference: 1 });
  assert.equal(s.tokens, 1, "the other stats are about finished tokens");

  const rows = tokensToCsv(d).trim().split("\r\n");
  assert.equal(rows.length, 1 + 4);
  assert.ok(rows.find((r) => r.includes(",Bob,")).endsWith(",left"));
  assert.ok(rows.find((r) => r.includes(",Dev,")).endsWith(",stall closed"));

  const back = parseData(JSON.stringify(d));
  assert.equal(back.tokens[3].leftReason, "closed");
  assert.equal(back.tokensCollected, 5);
  back.tokens[3].leftReason = "bored";
  assert.throws(() => parseData(JSON.stringify(back)), /leaving/);
});

test("a game that isn't available can't be picked, given or changed to", () => {
  const d = stall();
  const a = startToken(d, "Alice", ["g1", "g2"], at(0)).token;
  d.games[0].off = true;
  assert.match(checkGamePick(d, ["g1", "g3"]), /Game 1 isn't available/);
  assert.equal(canGive(d, a, 0), false);
  assert.equal(canGive(d, a, 1), true);
  assert.match(checkChange(d, a, 1, "g1"), /isn't available/);
  d.games[0].off = false;
  assert.equal(canGive(d, a, 0), true);
});

test("a game on too long is flagged", () => {
  const g = { startedAt: at(0), result: null };
  assert.equal(isLongGame(g, Date.parse(at(20))), false);
  assert.equal(isLongGame(g, Date.parse(at(21))), true);
  assert.equal(isLongGame({ ...g, result: "won" }, Date.parse(at(60))), false);
});

test("settings saved before keep-awake and the token count still load", () => {
  const d = stall();
  delete d.keepAwake;
  delete d.tokensCollected;
  const back = parseData(JSON.stringify(d));
  assert.equal(back.keepAwake, true);
  assert.equal(back.tokensCollected, null);
});
