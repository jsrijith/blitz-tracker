// The waiting line for games already on the table.
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultData, gameState, nextUp, startToken, startGame, endGame, sendToBack, isBusy, waitMinutes,
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
const who = (entry) => entry && entry.token.playerId;
const next = (d) => nextUp(d).map((x) => [x.gameId, x.token.playerId]);

test("a player whose games are both free starts the first one picked", () => {
  const d = stall();
  const r = startToken(d, "Alice", ["g1", "g2"], at(0));
  assert.equal(r.started, 0);
  assert.deepEqual(r.places, [null, 1]);
  assert.equal(who(gameState(d, "g1").playing), "Alice");
  assert.equal(gameState(d, "g2").playing, null);
  assert.deepEqual(next(d), [], "Alice is busy, so her free second game isn't offered to her");
});

test("one game busy: play the free one now, wait for the other", () => {
  const d = stall();
  startToken(d, "Alice", ["g1", "g3"], at(0));
  const bob = startToken(d, "Bob", ["g1", "g2"], at(1));
  assert.equal(bob.started, 1, "Bob plays g2 now");
  assert.deepEqual(bob.places, [1, null], "and is first in line for g1");

  endGame(d.tokens[0], 0, "won", at(10)); // Alice frees g1 while Bob is still on g2
  assert.deepEqual(next(d), [["g3", "Alice"]], "Bob keeps his place in g1's line but isn't called while busy");
  endGame(bob.token, 1, "lost", at(12));
  assert.deepEqual(next(d), [["g1", "Bob"], ["g3", "Alice"]]);
});

test("both games busy: the player waits in both lines", () => {
  const d = stall();
  startToken(d, "Alice", ["g1", "g3"], at(0));
  startToken(d, "Bob", ["g2", "g4"], at(0));
  const carol = startToken(d, "Carol", ["g1", "g2"], at(2));
  assert.equal(carol.started, null);
  assert.deepEqual(carol.places, [1, 1]);
  assert.equal(isBusy(carol.token), false);
});

test("the line is first come, first served, and a busy player is skipped for now", () => {
  const d = stall();
  startToken(d, "Alice", ["g1", "g5"], at(0));
  const bob = startToken(d, "Bob", ["g2", "g1"], at(1)); // plays g2, waits for g1
  startToken(d, "Carol", ["g1", "g3"], at(2)); // plays g3, waits for g1
  const dev = startToken(d, "Dev", ["g1", "g3"], at(3)); // waits for both
  assert.deepEqual(gameState(d, "g1").line.map(who), ["Bob", "Carol", "Dev"]);

  endGame(d.tokens[0], 0, "lost", at(10));
  assert.deepEqual(next(d), [["g1", "Dev"], ["g5", "Alice"]], "Bob and Carol are busy, so Dev");
  startGame(dev.token, 0, at(11));
  assert.deepEqual(gameState(d, "g1").line.map(who), ["Bob", "Carol"], "Bob and Carol kept their places");
  assert.deepEqual(next(d), [["g5", "Alice"]], "Dev was also waiting for g3, but he's busy now");
  assert.equal(gameState(d, "g2").playing.token, bob.token);
});

test("a game that is free but whose line is all busy can go to a newcomer", () => {
  const d = stall();
  startToken(d, "Alice", ["g1", "g2"], at(0)); // plays g1, waits for g2 (free)
  const bob = startToken(d, "Bob", ["g2", "g3"], at(1));
  assert.equal(bob.started, 0, "Alice can't use g2 yet, so Bob takes it");
});

test("Not here moves a player to the back of that line", () => {
  const d = stall();
  startToken(d, "Alice", ["g1", "g2"], at(0));
  startToken(d, "Bob", ["g3", "g4"], at(0));
  const carol = startToken(d, "Carol", ["g1", "g3"], at(1));
  startToken(d, "Dev", ["g1", "g3"], at(2));
  endGame(d.tokens[0], 0, "won", at(10));
  assert.equal(who(nextUp(d).find((x) => x.gameId === "g1")), "Carol");
  sendToBack(carol.token, 0, at(11));
  assert.deepEqual(gameState(d, "g1").line.map(who), ["Dev", "Carol"]);
  assert.equal(who(nextUp(d).find((x) => x.gameId === "g1")), "Dev");
});

test("cancelling a token frees its game and takes it out of every line", () => {
  const d = stall();
  startToken(d, "Alice", ["g1", "g2"], at(0));
  startToken(d, "Bob", ["g1", "g3"], at(1)); // plays g3, waits for g1
  const carol = startToken(d, "Carol", ["g1", "g4"], at(2)); // plays g4, waits for g1
  d.tokens.splice(0, 1); // Alice's token cancelled
  assert.equal(gameState(d, "g1").playing, null);
  assert.deepEqual(gameState(d, "g2").line, []);
  endGame(carol.token, 1, "won", at(5));
  assert.deepEqual(next(d), [["g1", "Carol"]], "Bob is still on g3, so Carol");
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
  const b = startToken(d, "Bob", ["g1", "g3"], at(0)).token; // plays g3
  endGame(a, 0, "won", at(10)); startGame(a, 1, at(10)); endGame(a, 1, "won", at(20));
  a.finishedAt = at(21);
  endGame(b, 1, "lost", at(5)); startGame(b, 0, at(12)); endGame(b, 0, "won", at(22));
  b.finishedAt = at(23);
  const s = computeStats(d);
  assert.equal(s.avgWait, 3.5); // Alice 0, Bob 7
  assert.deepEqual(s.longestWait, { name: "Bob", minutes: 7 });
  const rows = tokensToCsv(d).trim().split("\r\n");
  assert.ok(rows[0].endsWith(",waited_minutes"));
  assert.ok(rows[2].endsWith(",7.0"));
});

test("table times survive a backup, and a bad one is refused", () => {
  const d = stall();
  startToken(d, "Alice", ["g1", "g2"], at(0));
  const back = parseData(JSON.stringify(d));
  assert.equal(back.tokens[0].games[0].startedAt, at(0));
  assert.equal(who(gameState(back, "g1").playing), "Alice");
  back.tokens[0].games[1].lineAt = "soon";
  assert.throws(() => parseData(JSON.stringify(back)), /bad game time/);
});

test("a token saved before the line existed loads, and waits in line", () => {
  const d = stall();
  d.tokens.push({ id: "old", playerId: "Alice", startedAt: at(0), rewardId: null, finishedAt: null,
    games: [{ gameId: "g1", result: null }, { gameId: "g2", result: null }] });
  const back = parseData(JSON.stringify(d));
  assert.equal(back.tokens[0].games[0].startedAt, null);
  assert.deepEqual(next(back), [["g1", "Alice"], ["g2", "Alice"]]);
});
