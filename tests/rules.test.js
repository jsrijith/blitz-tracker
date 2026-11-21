import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultData, checkGamePick, checkFinish, wonAny, resultsComplete, computeStats,
  csvField, tokensToCsv, parseData, pairKey, givenCount, leftCount, parseStock, DEFAULT_TITLE,
} from "../rules.js";

function sample() {
  const d = defaultData();
  d.players.push(
    { id: "p1", name: "Asha", type: "student", cls: "5B", registeredAt: "2026-11-28T09:00:00.000Z" },
    { id: "p2", name: 'Mr "Ravi", Kumar', type: "teacher", cls: "", registeredAt: "2026-11-28T09:05:00.000Z" },
    { id: "p3", name: "Ben", type: "student", cls: "3A", registeredAt: "2026-11-28T10:00:00.000Z" },
  );
  const tok = (id, playerId, a, ra, b, rb, rewardId, start, end) => ({
    id, playerId, startedAt: start, finishedAt: end, rewardId,
    games: [{ gameId: a, result: ra }, { gameId: b, result: rb }],
  });
  d.tokens.push(
    tok("t1", "p1", "g1", "won", "g2", "lost", "pen", "2026-11-28T09:00:00.000Z", "2026-11-28T09:10:00.000Z"),
    tok("t2", "p1", "g2", "lost", "g1", "lost", null, "2026-11-28T09:20:00.000Z", "2026-11-28T09:40:00.000Z"),
    tok("t3", "p2", "g3", "lost", "g1", "won", "keychain", "2026-11-28T10:00:00.000Z", "2026-11-28T10:15:00.000Z"),
    tok("t4", "p3", "g1", "won", "g4", "won", null, "2026-11-28T10:30:00.000Z", "2026-11-28T10:45:00.000Z"),
    tok("t5", "p3", "g5", null, "g6", null, null, "2026-11-28T11:00:00.000Z", null), // still in play
  );
  return d;
}

test("a token needs exactly two different known games", () => {
  const d = defaultData();
  assert.equal(checkGamePick(d, ["g1", "g2"]), null);
  assert.match(checkGamePick(d, ["g1"]), /exactly 2/);
  assert.match(checkGamePick(d, ["g1", "g2", "g3"]), /exactly 2/);
  assert.match(checkGamePick(d, ["g1", "g1"]), /different/);
  assert.match(checkGamePick(d, ["g1", "g99"]), /Unknown/);
});

test("finishing needs both results, and a prize only after a win", () => {
  const d = defaultData();
  const t = { games: [{ gameId: "g1", result: "won" }, { gameId: "g2", result: null }] };
  assert.equal(resultsComplete(t), false);
  assert.match(checkFinish(d, t, null), /both games/);

  t.games[1].result = "lost";
  assert.equal(wonAny(t), true);
  assert.equal(checkFinish(d, t, "pen"), null);
  assert.equal(checkFinish(d, t, null), null, "a winner may take no prize");
  assert.match(checkFinish(d, t, "sticker"), /Everyone/);
  assert.match(checkFinish(d, t, "nope"), /Unknown/);

  t.games[0].result = "lost";
  assert.equal(wonAny(t), false);
  assert.match(checkFinish(d, t, "pen"), /only for a player who won/);
  assert.equal(checkFinish(d, t, null), null);
});

test("stats count finished tokens only", () => {
  const s = computeStats(sample());
  assert.equal(s.tokens, 4);
  assert.equal(s.inPlay, 1);
  assert.equal(s.plays, 8);
  assert.equal(s.uniquePlayers, 3);
  assert.equal(s.winners, 3);
  assert.equal(s.noPick, 1, "Ben won but took nothing");
});

test("plays and win rate per game", () => {
  const s = computeStats(sample());
  const g = (id) => s.perGame.find((x) => x.gameId === id);
  assert.deepEqual([g("g1").plays, g("g1").wins], [4, 3]);
  assert.equal(g("g1").winRate, 0.75);
  assert.deepEqual([g("g2").plays, g("g2").wins], [2, 0]);
  assert.equal(g("g5").plays, 0, "the open token doesn't count");
  assert.equal(g("g5").winRate, null);
});

test("prize tally: the sticker once per token, others per pick", () => {
  const s = computeStats(sample());
  const r = Object.fromEntries(s.rewards.map((x) => [x.rewardId, x.count]));
  assert.deepEqual(r, { sticker: 4, pen: 1, crayons: 0, keychain: 1 });
});

test("game pairs ignore the order the games were picked in", () => {
  assert.equal(pairKey("g2", "g1"), pairKey("g1", "g2"));
  const s = computeStats(sample());
  assert.deepEqual(s.pairs[0], { names: ["Game 1", "Game 2"], count: 2 });
});

test("players by type and class, average minutes", () => {
  const s = computeStats(sample());
  assert.deepEqual(s.byType, [{ type: "student", count: 2 }, { type: "teacher", count: 1 }]);
  assert.deepEqual(s.byClass.map((c) => c.cls).sort(), ["3A", "5B"]);
  assert.equal(s.avgMinutes, 15);
  assert.deepEqual(s.topPlayers[0], { name: "Asha", tokens: 2 });
});

test("CSV fields with commas, quotes and newlines are quoted", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("two\nlines"), '"two\nlines"');
  assert.equal(csvField(null), "");
});

test("CSV has a header and one row per finished token", () => {
  const lines = tokensToCsv(sample()).trimEnd().split("\r\n");
  assert.equal(lines.length, 1 + 4);
  assert.match(lines[0], /^token_id,player,player_type,class/);
  const ravi = lines.find((l) => l.startsWith("t3,"));
  assert.ok(ravi.includes('"Mr ""Ravi"", Kumar",teacher'));
  assert.ok(ravi.includes("Game 3,lost,Game 1,won,yes,Keychain,Sticker"));
  assert.ok(ravi.endsWith(",15.0"));
});

test("a backup round-trips", () => {
  const d = sample();
  assert.deepEqual(parseData(JSON.stringify(d)), d);
});

test("broken backups are refused with a reason", () => {
  assert.throws(() => parseData("not json"), /not JSON/);
  assert.throws(() => parseData("null"), /empty/);
  const bad = (change) => {
    const d = sample();
    change(d);
    return () => parseData(JSON.stringify(d));
  };
  assert.throws(bad((d) => { d.version = 9; }), /version/);
  assert.throws(bad((d) => { delete d.tokens; }), /tokens is missing/);
  assert.throws(bad((d) => { d.players[0].type = "alien"; }), /player is broken/);
  assert.throws(bad((d) => { d.tokens[0].playerId = "ghost"; }), /token is broken/);
  assert.throws(bad((d) => { d.tokens[0].games.pop(); }), /2 games/);
  assert.throws(bad((d) => { d.tokens[0].games[0].gameId = "g42"; }), /unknown game/);
  assert.throws(bad((d) => { d.tokens[0].games[0].result = "maybe"; }), /unknown result/);
  assert.throws(bad((d) => { d.tokens[0].games[0].result = "draw"; }), /unknown result/, "no draws at this stall");
  assert.throws(bad((d) => { d.players[1].type = "parent"; }), /player is broken/, "only students and teachers");
  assert.throws(bad((d) => { d.tokens[0].rewardId = "gold"; }), /unknown prize/);
});

test("prizes left: starting quantity minus what finished tokens took", () => {
  const d = sample();
  const r = (id) => d.rewards.find((x) => x.id === id);
  assert.equal(leftCount(d, r("pen")), null, "not counted until a quantity is entered");
  r("pen").stock = 10;
  r("sticker").stock = 50;
  r("keychain").stock = 0;
  assert.equal(givenCount(d, r("pen")), 1);
  assert.equal(leftCount(d, r("pen")), 9);
  assert.equal(leftCount(d, r("sticker")), 46, "one sticker per finished token; the open one hasn't had one");
  assert.equal(leftCount(d, r("keychain")), -1, "handing out more than counted goes negative");
  const s = computeStats(d);
  assert.deepEqual(s.rewards.find((x) => x.rewardId === "pen"), { rewardId: "pen", name: "Pen", count: 1, stock: 10, left: 9 });
});

test("quantities typed in Setup", () => {
  assert.equal(parseStock(""), null);
  assert.equal(parseStock("  "), null);
  assert.equal(parseStock("25"), 25);
  assert.equal(parseStock(" 0 "), 0);
  assert.equal(parseStock("-3"), undefined);
  assert.equal(parseStock("2.5"), undefined);
  assert.equal(parseStock("ten"), undefined);
});

test("data saved before titles and quantities still loads", () => {
  const d = sample();
  delete d.title;
  for (const r of d.rewards) delete r.stock;
  const loaded = parseData(JSON.stringify(d));
  assert.equal(loaded.title, DEFAULT_TITLE);
  assert.ok(loaded.rewards.every((r) => r.stock === null));
});

test("a title and quantities survive a backup, and bad ones are refused", () => {
  const d = sample();
  d.title = "Class 5 Game Corner";
  d.rewards[1].stock = 30;
  const loaded = parseData(JSON.stringify(d));
  assert.equal(loaded.title, "Class 5 Game Corner");
  assert.equal(loaded.rewards[1].stock, 30);
  const bad = (change) => () => { const x = sample(); change(x); parseData(JSON.stringify(x)); };
  assert.throws(bad((x) => { x.rewards[1].stock = -1; }), /quantity/);
  assert.throws(bad((x) => { x.rewards[1].stock = "5"; }), /quantity/);
  assert.throws(bad((x) => { x.title = ""; }), /title/);
});
