import {
  PLAYER_TYPES, RESULTS, newId, defaultData, checkGamePick, checkFinish, wonAny, resultsComplete,
  openTokens, finishedTokens, computeStats, tokensToCsv, statsToCsv, parseData, CLASS_KINDS, classLabel,
  leftTokens, markLeft, bringBack, closeStall, isLongGame, LONG_GAME_MINUTES,
  parseLimit, secondsLeft, timesUp, countdownText, SOON_SECONDS,
  DEFAULT_TITLE, givenCount, leftCount, parseStock, SLOT_MINUTES, MIN_PLAYS_FOR_RATE, QUIET_MINUTES,
  gameState, queue, playingNow, canGive, startToken, startGame, endGame, waitMinutes, checkChange, changeGame,
} from "./rules.js";
import { load, save, tokensSinceBackup, askPersistent, shareFile } from "./store.js";

const BACKUP_NAG_EVERY = 20;
const LOW_STOCK = 3; // warn when this many or fewer of a prize are left

let data = load();
let saveFailed = false;

const ui = {
  tab: "start",
  settingsView: "setup", // "setup" or "stats", inside the Settings tab
  logView: "players",    // "players" or "tokens", inside the Log tab
  search: "",
  playerId: null,        // player picked for a new token
  newPlayer: null,       // { name, type, clsKind, cls } while the form is open
  picked: [],            // game ids picked for a new token
  editing: null,         // { tokenId, results: [r, r], rewardId: id | null | undefined }
  changing: null,        // { tokenId, index } while a queued player picks a different game
  logFilter: "",
};

const $ = (sel) => document.querySelector(sel);
const view = $("#view");

// ---- helpers ---------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const nowIso = () => new Date().toISOString();
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const player = (id) => data.players.find((p) => p.id === id);
const game = (id) => data.games.find((g) => g.id === id);
const reward = (id) => data.rewards.find((r) => r.id === id);
const prizes = () => data.rewards.filter((r) => !r.everyone);
const everyoneGets = () => data.rewards.filter((r) => r.everyone).map((r) => r.name).join(" + ") || "nothing";
const everyoneGetsWithStock = () =>
  data.rewards.filter((r) => r.everyone).map((r) => r.name + (leftCount(data, r) == null ? "" : ` (${leftText(r)})`)).join(" + ") || "nothing";
const isLow = (r) => { const left = leftCount(data, r); return left != null && left <= LOW_STOCK; };
function leftText(r) {
  const left = leftCount(data, r);
  if (left == null) return "";
  return left <= 0 ? (left < 0 ? `${-left} over!` : "none left") : `${left} left`;
}
function stockLine(r) {
  const given = givenCount(data, r);
  return leftCount(data, r) == null ? `${given} given` : `${given} given · ${leftText(r)}`;
}
const tokenCount = (playerId) => data.tokens.filter((t) => t.playerId === playerId).length;
const minutesSince = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

// A timed game's clock: "ok", "soon" in its last minute, or "over" once time's up.
const timerPhase = (left) => (left <= 0 ? "over" : left <= SOON_SECONDS ? "soon" : "ok");
function timerText(left, short) {
  if (left > 0) return `${countdownText(left)} left`;
  return short ? "Time's up" : `Time's up · ${countdownText(left)} over`;
}
// The countdown for game i of a token. The tick below rewrites its text every second.
function timerHtml(t, i, left, short) {
  return `<span data-timer="${t.id}" data-i="${i}"${short ? " data-short" : ""}>${timerText(left, short)}</span>`;
}

function who(p) {
  if (!p) return "Unknown";
  return p.type === "student" && p.cls ? `${cap(p.type)} · ${esc(classLabel(p))}` : cap(p.type);
}

function commit() {
  saveFailed = !save(data);
  render();
}

let toastTimer;
function toast(message, undo, ms) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button" data-action="undo">Undo</button>' : ""}`;
  el.hidden = false;
  toastUndo = undo || null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; toastUndo = null; }, ms ?? (undo ? 7000 : 2500));
}
let toastUndo = null;

// ---- rendering -------------------------------------------------------------

function render() {
  document.querySelectorAll(".tabs button").forEach((b) => {
    if (b.dataset.tab === ui.tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const inQueue = queue(data);
  const canGo = inQueue.filter((t) => t.games.some((_, i) => canGive(data, t, i))).length;
  const playing = playingNow(data).length;
  const prizes = openTokens(data).filter(resultsComplete).length;
  setBadge("#badge-queue", canGo);
  setBadge("#badge-play", playing + prizes);
  $("#title").textContent = data.title;
  document.title = data.title;
  $("#top-count").textContent = `${finishedTokens(data).length} done · ${playing} playing · ${inQueue.length} in queue`;
  renderBanner();

  if (ui.editing) view.innerHTML = editorHtml();
  else if (ui.changing) view.innerHTML = changeHtml();
  else view.innerHTML = { start: startHtml, queue: queueHtml, play: playHtml, log: logHtml, settings: settingsHtml }[ui.tab]();
}

function setBadge(sel, n) {
  const badge = $(sel);
  badge.hidden = n === 0;
  badge.textContent = n;
}

function renderBanner() {
  const el = $("#banner");
  const since = tokensSinceBackup(data);
  if (saveFailed) {
    el.className = "banner error";
    el.innerHTML = "<span><b>Not saving!</b> This browser is refusing to store data. Don't use a private tab.</span>";
    el.hidden = false;
    return;
  }
  const parts = [];
  const over = timesUp(data, Date.now());
  if (over.length) {
    const names = over.map((x) => `<b>${esc(player(x.token.playerId)?.name)}</b> on ${esc(game(x.token.games[x.index].gameId)?.name)}`);
    parts.push(`<span class="banner-line timeup"><span>⏰ Time's up: ${names.join(", ")}</span>${ui.tab === "play" && !ui.editing && !ui.changing ? "" : '<button class="btn" data-tab="play">Show</button>'}</span>`);
  }
  const low = data.rewards.filter(isLow);
  if (low.length) {
    parts.push(`<span>Running low: ${low.map((r) => `<b>${esc(r.name)}</b> ${leftText(r)}`).join(", ")}</span>`);
  }
  if (since >= BACKUP_NAG_EVERY) {
    parts.push(`<span class="banner-line"><span>${since} tokens since the last backup.</span><button class="btn" data-action="backup">Back up</button></span>`);
  }
  el.className = over.length ? "banner timeup" : "banner";
  el.innerHTML = parts.join("");
  el.hidden = parts.length === 0;
}

// New token -------------------------------------------------------------

function startHtml() {
  if (ui.newPlayer) return newPlayerHtml();
  if (!ui.playerId) return pickPlayerHtml();

  const p = player(ui.playerId);
  const used = tokenCount(p.id);
  const error = ui.picked.length === 2 ? checkGamePick(data, ui.picked) : null;
  return `
    <div class="card picked">
      <div><div class="name">${esc(p.name)}</div><div class="small muted">${who(p)} · ${used ? `token ${used + 1} today` : "first token"}</div></div>
      <button class="btn" data-action="clear-player">Change</button>
    </div>
    <h2>Pick 2 games <span class="muted small">(${ui.picked.length} of 2)</span></h2>
    <div class="choices">
      ${data.games.map((g, i) => {
        const on = ui.picked.includes(g.id);
        const full = (ui.picked.length >= 2 || g.off) && !on;
        return `<button class="choice game-pick ${gameStateClass(g.id, true)}" data-action="toggle-game" data-id="${g.id}" aria-pressed="${on}" ${full ? "disabled" : ""}>
          <span class="num">${i + 1}</span>${on ? "✓ " : ""}${esc(g.name)}${tableStatusHtml(g.id)}</button>`;
      }).join("")}
    </div>
    ${error ? `<p class="small" style="color:var(--danger)">${esc(error)}</p>` : ""}
    <p></p>
    <button class="btn primary block" data-action="start-token" ${ui.picked.length === 2 && !error ? "" : "disabled"}>Start token</button>
  `;
}

// Colour for a game: free, in use or switched off. A picked game is coloured by aria-pressed.
// The registration buttons also show "queued" when players are already waiting for the game.
function gameStateClass(gameId, showQueue = false) {
  if (game(gameId)?.off) return "game-off";
  const s = gameState(data, gameId);
  if (showQueue && s.wanted.length) return "game-queued";
  return s.playing ? "game-busy" : "game-free";
}

function tableStatusHtml(gameId) {
  if (game(gameId)?.off) return `<span class="left busy">not available</span>`;
  const s = gameState(data, gameId);
  if (!s.playing) return `<span class="left">free${s.wanted.length ? ` · ${s.wanted.length} in queue` : ""}</span>`;
  return `<span class="left busy">${esc(player(s.playing.token.playerId)?.name)} playing${s.wanted.length ? ` · ${s.wanted.length} in queue` : ""}</span>`;
}

const ordinal = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

function playerMatches() {
  const q = ui.search.trim().toLowerCase();
  const list = q ? data.players.filter((p) => p.name.toLowerCase().includes(q) || (p.cls || "").toLowerCase() === q) : [];
  return list.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12);
}

function matchesHtml() {
  const q = ui.search.trim();
  const matches = playerMatches();
  const exact = matches.some((p) => p.name.toLowerCase() === q.toLowerCase());
  return `
    ${matches.length ? `<ul class="list card">${matches.map((p) => `
      <li><button data-action="pick-player" data-id="${p.id}">
        <span><span class="name">${esc(p.name)}</span><br><span class="small muted">${who(p)}</span></span>
        <span class="small muted">${tokenCount(p.id)} token${tokenCount(p.id) === 1 ? "" : "s"}</span>
      </button></li>`).join("")}</ul>` : ""}
    <button class="btn ${q && !matches.length ? "primary" : ""} block" data-action="new-player">+ New player${q && !exact ? ` "${esc(q)}"` : ""}</button>
  `;
}

function pickPlayerHtml() {
  return `
    <h2>Who is playing?</h2>
    <input type="search" id="search" placeholder="Type a name to find them" value="${esc(ui.search)}" autocomplete="off" autocapitalize="words" enterkeyhint="search">
    <div id="matches" class="stack" style="margin-top:12px">${matchesHtml()}</div>
    <p class="small muted">Everyone gets: ${esc(everyoneGets())}. A player who wins a game also picks a prize.</p>
  `;
}

function newPlayerHtml() {
  const np = ui.newPlayer;
  return `
    <h2>New player</h2>
    <label class="field" for="np-name">Name</label>
    <input type="text" id="np-name" value="${esc(np.name)}" autocomplete="off" autocapitalize="words" enterkeyhint="next">
    <label class="field">Who are they?</label>
    <div class="choices">
      ${PLAYER_TYPES.map((t) => `<button class="choice" data-action="np-type" data-type="${t}" aria-pressed="${np.type === t}">${cap(t)}</button>`).join("")}
    </div>
    ${np.type === "student" ? `
      <label class="field">Grade or year?</label>
      <div class="choices">
        ${CLASS_KINDS.map((k) => `<button class="choice" data-action="np-cls-kind" data-kind="${k}" aria-pressed="${np.clsKind === k}">${cap(k)}</button>`).join("")}
      </div>
      <label class="field" for="np-cls">${np.clsKind ? cap(np.clsKind) : "Class"}</label>
      <input type="text" id="np-cls" value="${esc(np.cls)}" placeholder="e.g. 1A, 5B, 6D" autocomplete="off" autocapitalize="characters">` : ""}
    <p></p>
    <div class="row">
      <button class="btn" data-action="np-cancel">Cancel</button>
      <button class="btn primary" data-action="np-save">Save player</button>
    </div>
  `;
}

// In play -----------------------------------------------------------------

function tokenCardHtml(t, showTime) {
  const p = player(t.playerId);
  const pill = (g) => `<span class="pill ${g.result || ""}">${esc(game(g.gameId)?.name)}${g.result ? ` · ${cap(g.result)}` : ""}</span>`;
  const right = showTime ? time(t.finishedAt ?? t.leftAt) : `${minutesSince(t.startedAt)} min`;
  const prize = t.finishedAt && t.rewardId ? `<span class="pill prize">${esc(reward(t.rewardId)?.name)}</span>`
    : t.leftAt ? `<span class="pill">${t.leftReason === "closed" ? "Stall closed" : "Left"}</span>` : "";
  return `<button class="card token" data-action="edit-token" data-id="${t.id}">
    <div class="head"><span class="name">${esc(p?.name)}</span><span class="muted small">${right}</span></div>
    <div class="small muted">${who(p)}</div>
    <div class="games">${t.games.map(pill).join("")}${prize}</div>
  </button>`;
}

const nameBtn = (t) => `<button class="name-link" data-action="edit-token" data-id="${t.id}">${esc(player(t.playerId)?.name)}</button>`;

function queueHtml() {
  const list = queue(data);
  if (!list.length) return `<div class="empty">Nobody is waiting.<br><br><button class="btn primary" data-tab="start">New token</button></div>`;
  return `
    <h2>Queue <span class="muted small">(${list.length})</span></h2>
    <p class="small muted">First come, first served. Give a player a game when it's free.</p>
    ${list.map((t, n) => {
      const p = player(t.playerId);
      const games = t.games.map((g, i) => {
        const name = esc(game(g.gameId)?.name);
        if (g.result) return `<div class="queue-game"><span class="pill ${g.result}">${name} · ${cap(g.result)}</span></div>`;
        const change = `<button class="btn change" data-action="change-open" data-id="${t.id}" data-i="${i}">Change</button>`;
        if (canGive(data, t, i)) return `<div class="queue-game"><button class="btn primary give" data-action="give" data-id="${t.id}" data-i="${i}">Give ${name}</button>${change}</div>`;
        const on = gameState(data, g.gameId).playing;
        const why = on ? `${esc(player(on.token.playerId)?.name)} playing` : game(g.gameId)?.off ? "not available" : "wait";
        return `<div class="queue-game"><span class="pill in-use">${name} · ${why}</span>${change}</div>`;
      }).join("");
      return `<div class="card queue-card">
        <div class="head"><span class="place">${n + 1}</span>${nameBtn(t)}
          <span class="muted small">${minutesSince(t.startedAt)} min</span></div>
        <div class="small muted">${who(p)}</div>
        <div class="queue-games">${games}</div>
      </div>`;
    }).join("")}
  `;
}

// A queued player swaps a game they're waiting for.
function changeHtml() {
  const t = data.tokens.find((x) => x.id === ui.changing.tokenId);
  const i = ui.changing.index;
  const old = game(t.games[i].gameId);
  const other = t.games[1 - i];
  return `
    <button class="btn link" data-action="change-close">‹ Back</button>
    <div class="card picked"><div><div class="name">${esc(player(t.playerId)?.name)}</div>
      <div class="small muted">Instead of <b>${esc(old?.name)}</b>. Their other game: ${esc(game(other.gameId)?.name)}</div></div></div>
    <h2>Pick a different game</h2>
    <p class="small muted">They keep their place in the queue.</p>
    <div class="choices">
      ${data.games.map((g, n) => {
        const ok = !checkChange(data, t, i, g.id);
        return `<button class="choice game-pick ${ok ? gameStateClass(g.id, true) : "game-off"}" data-action="change-pick" data-id="${g.id}" ${ok ? "" : "disabled"}>
          <span class="num">${n + 1}</span>${esc(g.name)}${ok ? tableStatusHtml(g.id) : `<span class="left">${g.id === old?.id ? "now" : "their other game"}</span>`}</button>`;
      }).join("")}
    </div>
  `;
}

function playHtml() {
  const playing = playingNow(data);
  const ready = openTokens(data).filter(resultsComplete).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (!playing.length && !ready.length) {
    return `<div class="empty">Nobody is playing right now.<br><br><button class="btn primary" data-tab="queue">Go to the queue</button></div>
      ${allGamesHtml()}`;
  }
  return `
    ${ready.length ? `<h2>Pick a prize</h2><p class="small muted">Both games done. Tap to finish the token.</p>
      ${ready.map((t) => tokenCardHtml(t, false)).join("")}` : ""}
    ${playing.length ? `<h2>Playing now <span class="muted small">(${playing.length})</span></h2>
    <p class="small muted">When a player says they're done, tap Won or Lost.</p>
    ${playing.map((t) => {
      const i = t.games.findIndex((g) => g.startedAt && !g.result);
      const g = t.games[i];
      const left = secondsLeft(data, g, Date.now());
      if (left != null) {
        const phase = timerPhase(left);
        return `<div class="card play-card ${phase === "over" ? "long" : phase === "soon" ? "soon" : ""}">
        <div class="head"><span class="game-name">${esc(game(g.gameId)?.name)}</span>
          <span class="small ${phase === "over" ? "long-text" : phase === "soon" ? "soon-text" : "muted"}">${timerHtml(t, i, left)}</span></div>
        ${phase === "over" ? `<div class="long-note">Time's up. Ask them to stop, then tap Won or Lost.</div>` : ""}
        <div>${nameBtn(t)} <span class="small muted">${who(player(t.playerId))}</span></div>
        <div class="choices">
          ${RESULTS.map((r) => `<button class="choice ${r}" data-action="end-game" data-id="${t.id}" data-i="${i}" data-r="${r}">${cap(r)}</button>`).join("")}
        </div>
      </div>`;
      }
      const long = isLongGame(g, Date.now());
      return `<div class="card play-card ${long ? "long" : ""}">
        <div class="head"><span class="game-name">${esc(game(g.gameId)?.name)}</span>
          <span class="small ${long ? "long-text" : "muted"}">${minutesSince(g.startedAt)} min</span></div>
        ${long ? `<div class="long-note">Over ${LONG_GAME_MINUTES} min. Still playing? Check the table.</div>` : ""}
        <div>${nameBtn(t)} <span class="small muted">${who(player(t.playerId))}</span></div>
        <div class="choices">
          ${RESULTS.map((r) => `<button class="choice ${r}" data-action="end-game" data-id="${t.id}" data-i="${i}" data-r="${r}">${cap(r)}</button>`).join("")}
        </div>
      </div>`;
    }).join("")}` : ""}
    ${allGamesHtml()}
  `;
}

// Every game at a glance: free, or who is on it, and how many in the queue want it.
function allGamesHtml() {
  const rows = data.games.map((g, n) => {
    const s = gameState(data, g.id);
    const on = s.playing && s.playing.token.games[s.playing.index];
    const left = on ? secondsLeft(data, on, Date.now()) : null;
    const status = s.playing && left != null
      ? `<span class="pill ${left <= 0 ? "long" : "in-use"}">${nameBtn(s.playing.token)} · ${timerHtml(s.playing.token, s.playing.index, left, true)}</span>`
      : s.playing
      ? `<span class="pill ${isLongGame(on, Date.now()) ? "long" : "in-use"}">${nameBtn(s.playing.token)} · ${minutesSince(on.startedAt)} min</span>`
      : g.off ? `<span class="pill">Not available</span>` : `<span class="pill free">Free</span>`;
    const want = s.wanted.length ? `<span class="small muted">${s.wanted.length} in queue</span>` : "";
    return `<div class="game-row"><span class="num">${n + 1}</span><span class="game">${esc(g.name)}</span>${want}${status}</div>`;
  });
  const free = data.games.filter((g) => !g.off && !gameState(data, g.id).playing).length;
  return `<h2>All games <span class="muted small">(${free} of ${data.games.length} free)</span></h2>
    <div class="card all-games">${rows.join("")}</div>`;
}

// Editing a token (finishing one in play, or fixing one in the log) ------------

// Both games on a token and where each one stands, for the top of the token screen.
function tokenGamesHtml(t) {
  const place = queue(data).indexOf(t) + 1;
  const rows = t.games.map((g) => {
    let status;
    if (g.result) status = `<span class="pill ${g.result}">${cap(g.result)}</span>`;
    else if (t.leftAt) status = `<span class="muted">${g.startedAt ? "stopped part way" : "not played"}</span>`;
    else if (g.startedAt) status = `<span class="pill playing">Playing now · ${minutesSince(g.startedAt)} min</span>`;
    else if (t.finishedAt) status = `<span class="muted">not played</span>`;
    else if (place) status = `<span class="pill in-use">Waiting · ${ordinal(place)} in queue</span>`;
    else status = `<span class="muted">next, after this game</span>`;
    const changed = g.registeredGameId ? `<div class="small muted">changed from ${esc(game(g.registeredGameId)?.name)}</div>` : "";
    return `<div class="token-game"><div><b>${esc(game(g.gameId)?.name)}</b>${changed}</div>${status}</div>`;
  });
  return `<div class="card token-games"><div class="small muted">Their games</div>${rows.join("")}</div>`;
}

function leftWhy(t) {
  return t.leftReason === "closed" ? `Not finished when the stall closed (${time(t.leftAt)})` : `Left without finishing at ${time(t.leftAt)}`;
}

function editorHtml() {
  const t = data.tokens.find((x) => x.id === ui.editing.tokenId);
  const p = player(t.playerId);
  if (t.leftAt) {
    return `
      <button class="btn link" data-action="close-editor">‹ Back</button>
      <div class="card picked"><div><div class="name">${esc(p?.name)}</div><div class="small muted">${who(p)} · registered ${time(t.startedAt)}</div></div></div>
      <div class="card">${esc(leftWhy(t))}.</div>
      ${tokenGamesHtml(t)}
      <button class="btn primary block" data-action="bring-back">Back in the queue</button>
      <p class="small muted">They go back in their old place. A game they stopped part way is played again.</p>
      <button class="btn danger block" data-action="delete-token">Delete this token</button>
    `;
  }
  const draft = { ...t, games: t.games.map((g, i) => ({ ...g, result: ui.editing.results[i] })) };
  const won = wonAny(draft);
  const complete = resultsComplete(draft);
  const rewardId = ui.editing.rewardId;
  const finishing = !t.finishedAt;
  const ready = complete && (!won || rewardId !== undefined) && !checkFinish(data, draft, rewardId ?? null);

  return `
    <button class="btn link" data-action="close-editor">‹ Back</button>
    <div class="card picked"><div><div class="name">${esc(p?.name)}</div><div class="small muted">${who(p)} · registered ${time(t.startedAt)}</div></div></div>
    ${tokenGamesHtml(t)}
    ${draft.games.map((g, i) => `
      <h2>${esc(game(g.gameId)?.name)}</h2>
      <div class="choices">
        ${RESULTS.map((r) => `<button class="choice ${r}" data-action="set-result" data-i="${i}" data-r="${r}" aria-pressed="${g.result === r}">${cap(r)}</button>`).join("")}
      </div>`).join("")}
    ${complete ? (won ? `
      <h2>Winner's prize</h2>
      <p class="small muted">They also get: ${esc(everyoneGetsWithStock())}</p>
      <div class="choices">
        ${prizes().map((r) => `<button class="choice" data-action="set-prize" data-id="${r.id}" aria-pressed="${rewardId === r.id}">${esc(r.name)}${leftText(r) ? `<span class="left ${isLow(r) ? "low" : ""}">${leftText(r)}</span>` : ""}</button>`).join("")}
        <button class="choice" data-action="set-prize" data-id="" aria-pressed="${rewardId === null}">No prize taken</button>
      </div>` : `<div class="card" style="margin-top:16px">No wins this time: <b>${esc(everyoneGetsWithStock())}</b> only.</div>`) : ""}
    <p></p>
    <button class="btn primary block" data-action="save-token" ${ready ? "" : "disabled"}>${finishing ? "Finish token" : "Save changes"}</button>
    <p></p>
    ${finishing ? `<button class="btn block" data-action="mark-left">Left without finishing</button>
    <p class="small muted">For a player who walked off. Their token is kept as a record, and a game they were on is freed.</p>` : ""}
    <button class="btn danger block" data-action="delete-token">${finishing ? "Cancel this token" : "Delete this token"}</button>
  `;
}

// Log -----------------------------------------------------------------------

function logHtml() {
  const q = ui.logFilter.trim().toLowerCase();
  const match = (playerId) => !q || (player(playerId)?.name || "").toLowerCase().includes(q);
  const seg = (v, label) => `<button class="seg-btn" data-action="log-view" data-view="${v}" aria-pressed="${ui.logView === v}">${label}</button>`;
  let list;
  if (ui.logView === "players") {
    const rows = playerRows().filter((r) => match(r.p.id));
    list = rows.length ? `<div class="card players-card"><div class="table-wrap"><table class="table players-table">
      <thead><tr><th>Player</th><th>Playing now</th><th>Played</th><th>Yet to play</th></tr></thead>
      <tbody>${rows.map(playerRowHtml).join("")}</tbody></table></div></div>`
      : `<div class="empty">${q ? "No match." : "Nobody has had a token yet."}</div>`;
  } else {
    const endOf = (t) => t.finishedAt ?? t.leftAt;
    const done = [...finishedTokens(data), ...leftTokens(data)].filter((t) => match(t.playerId)).sort((a, b) => endOf(b).localeCompare(endOf(a)));
    list = done.length ? done.map((t) => tokenCardHtml(t, true)).join("") : `<div class="empty">${q ? "No match." : "No finished or left tokens yet."}</div>`;
  }
  return `
    <div class="seg" role="group" aria-label="Log">${seg("players", "Players")}${seg("tokens", "Tokens")}</div>
    <input type="search" id="log-filter" placeholder="Filter by name" value="${esc(ui.logFilter)}" autocomplete="off">
    <p></p>
    <div id="log-list">${list}</div>
  `;
}

// Everyone who has had a token, with where each open token stands. Active players first:
// playing, then waiting for a prize, then the queue in order; players who are done last, latest first.
function playerRows() {
  const inQueue = queue(data);
  const statusOf = (t) => {
    const on = t.games.find((g) => g.startedAt && !g.result);
    if (on) return { rank: 0, order: on.startedAt, html: `<span class="pill playing">Playing ${esc(game(on.gameId)?.name)} · ${minutesSince(on.startedAt)} min</span>` };
    if (resultsComplete(t)) return { rank: 1, order: t.startedAt, html: `<span class="pill prize">Pick a prize</span>` };
    const place = inQueue.indexOf(t) + 1;
    return { rank: 2, order: String(place).padStart(6, "0"), html: `<span class="pill in-use">Waiting · ${ordinal(place)} in queue</span>` };
  };
  const rows = [];
  for (const p of data.players) {
    const tokens = data.tokens.filter((t) => t.playerId === p.id);
    if (!tokens.length) continue;
    const open = tokens.filter((t) => !t.finishedAt && !t.leftAt);
    const done = tokens.filter((t) => t.finishedAt);
    const statuses = open.map((t) => ({ t, ...statusOf(t) })).sort((a, b) => a.rank - b.rank || a.order.localeCompare(b.order));
    const lastDone = tokens.map((t) => t.finishedAt ?? t.leftAt ?? "").sort().at(-1) ?? "";
    const wins = done.reduce((n, t) => n + t.games.filter((g) => g.result === "won").length, 0);
    rows.push({ p, statuses, tokens: tokens.length, wins, lastDone, all: tokens, latest: tokens.at(-1) });
  }
  return rows.sort((a, b) => {
    const ra = a.statuses[0]?.rank ?? 9, rb = b.statuses[0]?.rank ?? 9;
    if (ra !== rb) return ra - rb;
    if (ra === 9) return b.lastDone.localeCompare(a.lastDone);
    return a.statuses[0].order.localeCompare(b.statuses[0].order);
  });
}

// One row of the Players table: who, the game they're on, the games they've played, and the rest.
function playerRowHtml(r) {
  const t = r.statuses[0]?.t ?? r.latest;
  const inQueue = queue(data);
  const now = [], played = [], todo = [];
  for (const tok of r.all) {
    for (const g of tok.games) {
      const name = esc(game(g.gameId)?.name);
      if (g.result) played.push(`<span class="tag-game ${g.result}">${name} · ${cap(g.result)}</span>`);
      else if (tok.leftAt) todo.push(`<span class="tag-game">${name} · ${g.startedAt ? "stopped" : tok.leftReason === "closed" ? "stall closed" : "left"}</span>`);
      else if (g.startedAt) {
        const long = isLongGame(g, Date.now());
        now.push(`<span class="tag-game ${long ? "long" : "busy"}">${name} · ${minutesSince(g.startedAt)} min</span>`);
      } else if (tok.finishedAt) todo.push(`<span class="tag-game">${name} · not played</span>`);
      else {
        // Coloured like the New token buttons: green if the game is free now, yellow if in use, grey if off.
        const place = inQueue.indexOf(tok) + 1;
        const state = gameStateClass(g.gameId).replace("game-", "");
        const where = state === "off" ? "not available" : place ? `${ordinal(place)} in queue` : "";
        todo.push(`<span class="tag-game ${state}">${name}${where ? ` · ${where}` : ""}</span>`);
      }
    }
    if (!tok.finishedAt && !tok.leftAt && resultsComplete(tok)) now.push(`<span class="tag-game prize">Pick a prize</span>`);
  }
  const cell = (items) => (items.length ? `<div class="cell-tags">${items.join("")}</div>` : `<span class="muted">–</span>`);
  return `<tr>
    <td>${nameBtn(t)}<div class="small muted">${who(r.p)}</div><div class="small muted">${plural(r.tokens, "token")} · ${plural(r.wins, "win")}</div></td>
    <td>${cell(now)}</td>
    <td>${cell(played)}</td>
    <td>${cell(todo)}</td>
  </tr>`;
}

// Stats -----------------------------------------------------------------------

function barsHtml(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return `<p class="muted small">Nothing yet.</p>`;
  return `<div class="bars">${rows.map((r) => `
    <div class="bar-row"><span class="label" title="${esc(r.label)}">${esc(r.label)}</span>
    <span><div class="bar" style="width:${(r.value / max) * 100}%"></div></span>
    <span class="n">${esc(r.text ?? r.value)}</span></div>`).join("")}</div>`;
}

const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const slotLabel = (slot) => `${hhmm(slot.start)}–${hhmm(slot.start + SLOT_MINUTES)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const mins = (m) => (m == null ? "–" : m < 1 ? "under 1 min" : `${Math.round(m)} min`);

// "A, B and C", or "A, B and 3 more" for long ties.
function nameList(names, max = 3) {
  if (names.length <= max) return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
  return `${names.slice(0, max - 1).join(", ")} and ${names.length - max + 1} more`;
}

function highlightsHtml(s) {
  const rows = [];
  const add = (label, value, note) => rows.push(`<div class="hl"><span class="hl-label">${label}</span><span class="hl-value">${value}${note ? `<span class="hl-note">${note}</span>` : ""}</span></div>`);
  const g = s.games;
  if (s.busiest.length) add("Busiest time", esc(nameList(s.busiest.map(slotLabel))), plural(s.busiest[0].count, "token"));
  if (s.peak.count > 1) add("Most at once", `${s.peak.count} playing`, `at ${time(s.peak.at)}`);
  if (g.mostPopular.length) add("Most popular game", esc(nameList(g.mostPopular.map((x) => x.name))), plural(g.mostPopular[0].plays, "play"));
  if (g.neverPlayed.length) add("Not picked yet", esc(nameList(g.neverPlayed.map((x) => x.name), 4)), "");
  else if (g.leastPopular.length) add("Least popular game", esc(nameList(g.leastPopular.map((x) => x.name))), plural(g.leastPopular[0].plays, "play"));
  if (g.hardest.length && g.easiest.length && g.hardest[0].winRate !== g.easiest[0].winRate) {
    add("Hardest to win", esc(nameList(g.hardest.map((x) => x.name))), `${pct(g.hardest[0].winRate)} won`);
    add("Easiest to win", esc(nameList(g.easiest.map((x) => x.name))), `${pct(g.easiest[0].winRate)} won`);
  }
  if (s.pairs.length && s.pairs[0].count > 1) add("Favourite pair", esc(s.pairs[0].names.join(" + ")), plural(s.pairs[0].count, "token"));
  if (s.topPrize.length) add("Favourite prize", esc(nameList(s.topPrize.map((r) => r.name))), `picked ${s.topPrize[0].count}×`);
  if (s.classStats.length > 1) add("Most active class", esc(s.classStats[0].cls), plural(s.classStats[0].tokens, "token"));
  if (s.topWinners.length) add("Top winner", esc(s.topWinners[0].name), `${plural(s.topWinners[0].wins, "win")} in ${s.topWinners[0].plays} games`);
  if (s.longestQueue.length) add("Longest queue", esc(nameList(s.longestQueue.map((x) => x.name))), `${mins(s.longestQueue[0].avgWait)} wait, average`);
  if (s.peakWaiting.count > 1) add("Most waiting at once", `${s.peakWaiting.count} waiting`, `at ${time(s.peakWaiting.at)}`);
  if (s.toughest.length) add("Toughest game", esc(nameList(s.toughest.map((x) => x.name))), `beat ${s.toughest[0].bestRun} players in a row`);
  if (s.quickestWin) add("Quickest win", esc(s.quickestWin.name), `${esc(s.quickestWin.game)} in ${mins(s.quickestWin.minutes)}`);
  if (s.perfect.length) add("Perfect record", esc(nameList(s.perfect.map((p) => p.name))), "won every game");
  if (s.comebacks.length) add("Comebacks", plural(s.comebacks.reduce((n, c) => n + c.count, 0), "token"), "lost the first game, won the second");
  if (s.longestWait && s.longestWait.minutes >= 1) add("Longest wait", esc(s.longestWait.name), `${Math.round(s.longestWait.minutes)} min`);
  if (s.longest && s.tokens > 1) add("Longest token", esc(s.longest.name), `${Math.round(s.longest.minutes)} min`);
  return rows.length ? `<div class="card highlights">${rows.join("")}</div>` : "";
}

function tableHtml(head, rows) {
  return `<div class="table-wrap"><table class="table"><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

// Tokens the app recorded against the tokens counted in the box.
function countCheckHtml(c) {
  const parts = [`${c.finished} finished`];
  if (c.left) parts.push(`${c.left} left early`);
  if (c.closed) parts.push(`${c.closed} not finished at closing`);
  if (c.open) parts.push(`${c.open} still going`);
  let verdict = "";
  if (c.difference === 0) verdict = `<p class="count-ok">Matches the box.</p>`;
  else if (c.difference > 0) verdict = `<p class="count-off">${plural(c.difference, "token")} more in the box than recorded. Some players may not have been registered.</p>`;
  else if (c.difference < 0) verdict = `<p class="count-off">${plural(-c.difference, "token")} fewer in the box than recorded. Check for a player registered twice, or a token that went missing.</p>`;
  return `<h2>Check the token box</h2>
    <div class="card">
      <p style="margin:0"><b>${plural(c.recorded, "token")}</b> recorded: ${parts.join(", ")}.</p>
      <div class="edit-row" style="margin-top:10px">
        <label class="tag" for="tokens-collected">Tokens in the box</label>
        <input type="text" id="tokens-collected" data-edit="tokens-collected" value="${c.collected ?? ""}" inputmode="numeric" pattern="[0-9]*" placeholder="count them" style="flex:0 0 7em">
      </div>
      ${verdict}
    </div>`;
}

function statsHtml() {
  const s = computeStats(data);
  if (!s.tokens) {
    return `${s.count.recorded ? countCheckHtml(s.count) : ""}
      <div class="empty">Stats show up once the first token is finished.${s.inPlay ? `<br><br>${plural(s.inPlay, "token")} in play now.` : ""}</div>`;
  }
  const kpi = (value, label) => `<div class="kpi"><div class="value">${value}</div><div class="label">${label}</div></div>`;
  const o = s.outcomes;
  return `
    ${countCheckHtml(s.count)}
    <h2>Highlights</h2>
    ${highlightsHtml(s)}

    <div class="kpis">
      ${kpi(s.tokens, "tokens used")}
      ${kpi(s.uniquePlayers, "different players")}
      ${kpi(s.plays, "games played")}
      ${kpi(s.returning, "came back for more")}
      ${kpi(s.avgMinutes == null ? "–" : `${Math.round(s.avgMinutes)} min`, "per token, average")}
      ${kpi(s.tokensPerHour == null ? "–" : Math.round(s.tokensPerHour), "tokens an hour")}
      ${s.avgWait == null ? "" : `
      ${kpi(`${Math.round(s.avgWait)} min`, "waiting per token, average")}
      ${kpi(finishedTokens(data).filter((t) => waitMinutes(t) >= 1).length, "had to wait for a game")}`}
    </div>

    <h2>How players did</h2>
    <div class="kpis three">
      ${kpi(o.wonBoth, "won both games")}
      ${kpi(o.wonOne, "won one game")}
      ${kpi(o.lostBoth, "lost both games")}
    </div>
    <div class="card" style="margin-top:10px">
      <p style="margin:0">Of ${plural(s.plays, "game")} played, <b>${s.gameWins} won</b> and <b>${s.gameLosses} lost</b> (${pct(s.gameWins / s.plays)} won).</p>
      <p style="margin:8px 0 0"><b>${s.playersWon}</b> of ${s.uniquePlayers} players won at least once${s.playersNeverWon ? `; ${s.playersNeverWon} haven't won yet` : ""}.</p>
    </div>

    <h2>Busy times</h2>
    <div class="card">${barsHtml(s.slots.map((x) => ({ label: hhmm(x.start), value: x.count })))}
      <p class="small muted" style="margin:10px 0 0">Tokens started in each half hour${s.firstStart ? `, from ${time(s.firstStart)} to ${time(s.lastFinish)}` : ""}.</p></div>

    <h2>Games played</h2>
    <div class="card">${barsHtml([...s.perGame].sort((a, b) => b.plays - a.plays).map((g) => ({ label: g.name, value: g.plays })))}</div>

    <h2>Win rate by game</h2>
    <div class="card">${barsHtml(s.perGame.filter((g) => g.plays).sort((a, b) => b.winRate - a.winRate).map((g) => ({ label: g.name, value: g.winRate, text: `${pct(g.winRate)} of ${g.plays}` })))}
      <p class="small muted" style="margin:10px 0 0">Share of plays the player won. Hardest and easiest need ${MIN_PLAYS_FOR_RATE}+ plays.</p></div>

    ${s.perGame.some((g) => g.avgPlayMinutes != null) ? `<h2>Game times and queues</h2>
    <div class="card">${tableHtml(["Game", "Length", "Busy", "Wait", "Beat in a row"],
      s.perGame.filter((g) => g.plays).map((g) => [esc(g.name), mins(g.avgPlayMinutes), pct(g.busyShare), mins(g.avgWait), g.bestRun]))}
      <p class="small muted" style="margin:10px 0 0">Length: average time a play took. Busy: share of the day the game was being played. Wait: average wait before a player started it. Beat in a row: most players in a row who lost to it.</p></div>` : ""}

    ${s.quietSpells.length ? `<h2>Quiet spells</h2>
    <div class="card">${tableHtml(["From", "To", "No games for"], s.quietSpells.map((q) => [time(q.from), time(q.to), mins(q.minutes)]))}
      <p class="small muted" style="margin:10px 0 0">Times of ${QUIET_MINUTES} minutes or more when no game was being played.</p></div>` : ""}

    <h2>Students and teachers</h2>
    <div class="card">${tableHtml(["", "Players", "Tokens", "Won", "Favourite"],
      s.typeStats.map((t) => [cap(t.type) + "s", t.players, t.tokens, pct(t.winRate), esc(nameList(t.favourite, 2))]))}</div>

    ${s.classStats.length ? `<h2>Classes</h2>
    <div class="card">${tableHtml(["Class", "Players", "Tokens", "Won"], s.classStats.map((c) => [esc(c.cls), c.players, c.tokens, pct(c.winRate)]))}</div>` : ""}

${s.gradeStats.length ? `<h2>Grades</h2>
    <div class="card">${tableHtml(["Grade", "Players", "Tokens", "Won", "Favourite"],
      s.gradeStats.map((g) => [esc(g.grade), g.players, g.tokens, pct(g.winRate), esc(nameList(g.favourite, 2))]))}
      <p class="small muted" style="margin:10px 0 0">Sections put together, so 5A and 5B count as Grade 5.</p></div>` : ""}

        <h2>Favourite pairs</h2>
    <div class="card">${barsHtml(s.pairs.slice(0, 8).map((p) => ({ label: p.names.join(" + "), value: p.count })))}</div>

    <h2>Prizes given</h2>
    <div class="card">${barsHtml(s.rewards.map((r) => ({ label: r.name, value: r.count, text: r.left == null ? r.count : `${r.count} · ${r.left} left` })))}
      ${s.noPick ? `<p class="small muted">${plural(s.noPick, "winner")} took no prize.</p>` : ""}</div>

    <h2>Most wins</h2>
    <div class="card">${barsHtml(s.topWinners.map((p) => ({ label: p.name, value: p.wins, text: `${p.wins} of ${p.plays}` })))}</div>

${s.perfect.length ? `<h2>Perfect record</h2>
    <div class="card">${tableHtml(["Player", "Tokens", "Games won"], s.perfect.map((p) => [esc(p.name), p.tokens, p.wins]))}
      <p class="small muted" style="margin:10px 0 0">Two or more tokens, and every game won.</p></div>` : ""}

    ${s.comebacks.length ? `<h2>Comebacks</h2>
    <div class="card">${barsHtml(s.comebacks.map((c) => ({ label: c.name, value: c.count })))}
      <p class="small muted" style="margin:10px 0 0">Lost the first game of a token, then won the second.</p></div>` : ""}

        <h2>Most tokens</h2>
    <div class="card">${barsHtml(s.topPlayers.map((p) => ({ label: p.name, value: p.tokens })))}</div>
  `;
}

// Settings: Setup before the stall opens, Stats once it's over -----------------

function settingsHtml() {
  const seg = (v, label) => `<button class="seg-btn" data-action="settings-view" data-view="${v}" aria-pressed="${ui.settingsView === v}">${label}</button>`;
  return `<div class="seg" role="group" aria-label="Settings">${seg("setup", "Setup")}${seg("stats", "Stats")}</div>
    ${ui.settingsView === "stats" ? statsHtml() : setupHtml()}`;
}

// Setup -----------------------------------------------------------------------

function setupHtml() {
  const usedRewards = new Set(data.tokens.map((t) => t.rewardId));
  const since = tokensSinceBackup(data);
  return `
    <h2>Stall name</h2>
    <div class="card">
      <input type="text" data-edit="title" value="${esc(data.title)}" aria-label="Stall name" autocapitalize="words">
      <p class="small muted" style="margin:8px 0 0">Shown at the top of every screen.</p>
    </div>

    <h2>Back up</h2>
    <div class="card stack">
      <p class="small muted" style="margin:0">Everything is kept only in this phone's browser. ${since ? `<b>${since} token${since === 1 ? "" : "s"} since the last backup.</b>` : "Backed up."}</p>
      <button class="btn primary block" data-action="backup">Back up (JSON file)</button>
      <button class="btn block" data-action="csv">Export for a spreadsheet (CSV)</button>
      <button class="btn block" data-action="stats-csv">Export the day's stats (CSV)</button>
      <label class="btn block" for="restore">Restore from a backup…</label>
      <input type="file" id="restore" accept="application/json,.json" hidden>
    </div>

    <h2>Games</h2>
    <div class="card">
      <p class="small muted" style="margin:0 0 12px">Broken or missing pieces? Mark a game Off: it can't be picked or given out until it's back On.</p>
      <p class="small muted" style="margin:0 0 12px"><b>Min</b> is the game's time limit, counted from when it's given out. When it runs out, the phone buzzes and the top of the screen says so. Leave it blank for a game with no limit.</p>
      ${data.games.map((g, i) => `<div class="edit-row"><span class="tag">${i + 1}</span>
        <input type="text" data-edit="game" data-id="${g.id}" value="${esc(g.name)}" aria-label="Game ${i + 1} name">
        <input type="text" class="limit" data-edit="game-limit" data-id="${g.id}" value="${g.limit ?? ""}" inputmode="numeric" pattern="[0-9]*" placeholder="–" aria-label="${esc(g.name)}: time limit in minutes"><span class="tag">min</span>
        <button class="btn kind-btn ${g.off ? "off" : ""}" data-action="toggle-game-off" data-id="${g.id}" aria-pressed="${!g.off}" aria-label="${esc(g.name)} available">${g.off ? "Off" : "On"}</button></div>`).join("")}
    </div>

    <h2>Screen</h2>
    <div class="card stack">
      <button class="btn block ${data.keepAwake ? "primary" : ""}" data-action="toggle-keep-awake" aria-pressed="${data.keepAwake}">Keep the screen on: ${data.keepAwake ? "On" : "Off"}</button>
      <p class="small muted" style="margin:0">${"wakeLock" in navigator
        ? "While the app is open, the phone's screen won't switch off. Keep a charger at the stall."
        : "This phone or browser can't keep the screen on by itself. Set the screen timeout to the longest in the phone's settings."}</p>
    </div>

    <h2>Prizes</h2>
    <div class="card">
      <p class="small muted" style="margin:0 0 12px">Type how many of each you start with, to see how many are left during the day. Leave it blank to not count. Restocked? Add the new ones to the number.</p>
      ${data.rewards.map((r) => `<div class="prize-edit">
        <div class="edit-row">
          <input type="text" data-edit="reward" data-id="${r.id}" value="${esc(r.name)}" aria-label="Prize name">
          ${r.everyone ? `<span class="tag">everyone</span>` : usedRewards.has(r.id) ? "" : `<button class="btn" data-action="delete-reward" data-id="${r.id}" aria-label="Remove ${esc(r.name)}">✕</button>`}
        </div>
        <div class="edit-row">
          <label class="tag" for="stock-${r.id}">Start with</label>
          <input type="text" id="stock-${r.id}" data-edit="reward-stock" data-id="${r.id}" value="${r.stock ?? ""}" inputmode="numeric" pattern="[0-9]*" placeholder="–" aria-label="${esc(r.name)}: how many at the start" style="flex:0 0 5.5em">
          <span class="tag ${isLow(r) ? "low" : ""}" data-left="${r.id}">${stockLine(r)}</span>
        </div>
      </div>`).join("")}
      <p></p>
      <button class="btn block" data-action="add-reward">+ Add a prize</button>
    </div>

    <h2>Players <span class="muted small">(${data.players.length})</span></h2>
    <div class="card">
      ${data.players.length ? [...data.players].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<div class="edit-row">
        <input type="text" data-edit="player-name" data-id="${p.id}" value="${esc(p.name)}" aria-label="Name">
        ${p.type === "student" ? `<button class="btn kind-btn" data-action="toggle-cls-kind" data-id="${p.id}" aria-label="Grade or year">${p.clsKind ? cap(p.clsKind) : "Class"}</button>
          <input type="text" data-edit="player-cls" data-id="${p.id}" value="${esc(p.cls)}" aria-label="${p.clsKind ? cap(p.clsKind) : "Class"}" style="flex:0 0 5.5em">` : `<span class="tag">${cap(p.type)}</span>`}
        ${tokenCount(p.id) ? "" : `<button class="btn" data-action="delete-player" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>`}
      </div>`).join("") : `<p class="muted small">No players yet.</p>`}
    </div>

    <h2>Close the stall</h2>
    <div class="card stack">
      <p class="small muted" style="margin:0">At the end of the day: everyone still in the queue or playing is marked as not finished, so Stats and the CSV include them.</p>
      <button class="btn block" data-action="close-stall">Close the stall</button>
    </div>

    <h2>Start over</h2>
    <div class="card stack">
      <p class="small muted" style="margin:0">Removes every player and token from this phone. Back up first.</p>
      <button class="btn danger block" data-action="clear-all">Clear all data</button>
    </div>
    <p class="small muted">Board Game Stall Tracker</p>
  `;
}

// ---- actions ---------------------------------------------------------------

function resetStart() {
  ui.search = "";
  ui.playerId = null;
  ui.newPlayer = null;
  ui.picked = [];
}

const actions = {
  "pick-player": (el) => { ui.playerId = el.dataset.id; ui.picked = []; render(); },
  "clear-player": () => { ui.playerId = null; ui.picked = []; render(); },
  "new-player": () => {
    // Start with whatever the last student registered used, since most of a day is one or the other.
    const last = [...data.players].reverse().find((p) => p.type === "student" && p.clsKind);
    ui.newPlayer = { name: ui.search.trim(), type: null, clsKind: last?.clsKind ?? "grade", cls: "" };
    render();
    $("#np-name")?.focus();
  },
  "np-cls-kind": (el) => { readNewPlayer(); ui.newPlayer.clsKind = el.dataset.kind; render(); $("#np-cls")?.focus(); },
  "toggle-cls-kind": (el) => {
    const p = player(el.dataset.id);
    p.clsKind = p.clsKind === "grade" ? "year" : "grade";
    commit();
  },
  "np-type": (el) => { readNewPlayer(); ui.newPlayer.type = el.dataset.type; render(); if (el.dataset.type === "student") $("#np-cls")?.focus(); },
  "np-cancel": () => { ui.newPlayer = null; render(); },
  "np-save": () => {
    readNewPlayer();
    const np = ui.newPlayer;
    const name = np.name.trim().replace(/\s+/g, " ");
    if (!name) return toast("Type their name first.");
    if (!np.type) return toast("Choose who they are.");
    const cls = np.type === "student" ? np.cls.trim().toUpperCase() : "";
    const clsKind = cls ? np.clsKind : null;
    const same = data.players.find((p) => p.name.toLowerCase() === name.toLowerCase() && (p.cls || "") === cls && (p.clsKind ?? null) === clsKind);
    if (same && !confirm(`There is already a ${same.name}. Add another player with the same name?`)) return;
    const p = { id: newId(), name, type: np.type, cls, clsKind, registeredAt: nowIso() };
    data.players.push(p);
    ui.newPlayer = null;
    ui.playerId = p.id;
    ui.picked = [];
    commit();
  },
  "toggle-game": (el) => {
    const id = el.dataset.id;
    ui.picked = ui.picked.includes(id) ? ui.picked.filter((x) => x !== id) : [...ui.picked, id].slice(0, 2);
    render();
  },
  "start-token": () => {
    const error = checkGamePick(data, ui.picked);
    if (error) return toast(error);
    const name = player(ui.playerId).name;
    const { place } = startToken(data, ui.playerId, ui.picked, nowIso());
    resetStart();
    ui.tab = "queue";
    commit();
    window.scrollTo(0, 0);
    toast(`${name} is ${ordinal(place)} in the queue.`, null, 4000);
  },
  "edit-token": (el) => {
    const t = data.tokens.find((x) => x.id === el.dataset.id);
    ui.editing = { tokenId: t.id, results: t.games.map((g) => g.result), rewardId: t.finishedAt ? t.rewardId : undefined };
    render();
    window.scrollTo(0, 0);
  },
  "close-editor": () => { ui.editing = null; render(); },
  "set-result": (el) => {
    ui.editing.results[Number(el.dataset.i)] = el.dataset.r;
    if (!ui.editing.results.includes("won")) ui.editing.rewardId = undefined;
    render();
  },
  "set-prize": (el) => { ui.editing.rewardId = el.dataset.id || null; render(); },
  "save-token": () => {
    const t = data.tokens.find((x) => x.id === ui.editing.tokenId);
    const draft = { ...t, games: t.games.map((g, i) => ({ ...g, result: ui.editing.results[i] })) };
    const rewardId = wonAny(draft) ? ui.editing.rewardId ?? null : null;
    const error = checkFinish(data, draft, rewardId);
    if (error) return toast(error);
    const before = structuredClone(t);
    const finishing = !t.finishedAt;
    const now = nowIso();
    t.games = draft.games.map((g) => (g.result && !g.endedAt ? { ...g, endedAt: now } : g));
    t.rewardId = rewardId;
    if (finishing) t.finishedAt = now;
    ui.editing = null;
    commit();
    const name = player(t.playerId)?.name;
    toast(finishing ? `${name} finished${rewardId ? ` · ${reward(rewardId).name}` : ""}.` : "Saved.", () => {
      Object.assign(t, before);
      commit();
    });
  },
  "mark-left": () => {
    const t = data.tokens.find((x) => x.id === ui.editing.tokenId);
    const index = data.tokens.indexOf(t);
    const before = structuredClone(t);
    markLeft(t, "left", nowIso());
    ui.editing = null;
    commit();
    toast(`${player(t.playerId)?.name} left. Their token is kept in the Log.`, () => {
      data.tokens[index] = before;
      commit();
    });
  },
  "bring-back": () => {
    const t = data.tokens.find((x) => x.id === ui.editing.tokenId);
    bringBack(t);
    ui.editing = null;
    ui.tab = "queue";
    commit();
    window.scrollTo(0, 0);
    toast(`${player(t.playerId)?.name} is back in the queue.`);
  },
  "toggle-game-off": (el) => {
    const g = game(el.dataset.id);
    g.off = !g.off;
    commit();
    toast(g.off ? `${g.name} is off: it can't be picked or given out.` : `${g.name} is back on.`);
  },
  "toggle-keep-awake": () => {
    data.keepAwake = !data.keepAwake;
    commit();
    if (data.keepAwake) keepScreenOn();
    else releaseScreen();
  },
  "close-stall": () => {
    const open = openTokens(data);
    if (!open.length) return toast("Nothing is still going: every token is finished.");
    if (!confirm(`Close the stall? ${plural(open.length, "token")} still in the queue or playing will be marked as not finished.`)) return;
    const before = open.map((t) => [data.tokens.indexOf(t), structuredClone(t)]);
    closeStall(data, nowIso());
    commit();
    toast(`Stall closed. ${plural(open.length, "token")} marked as not finished.`, () => {
      for (const [i, t] of before) data.tokens[i] = t;
      commit();
    });
  },
  "change-open": (el) => {
    ui.changing = { tokenId: el.dataset.id, index: Number(el.dataset.i) };
    render();
    window.scrollTo(0, 0);
  },
  "change-close": () => { ui.changing = null; render(); },
  "log-view": (el) => { ui.logView = el.dataset.view; render(); window.scrollTo(0, 0); },
  "settings-view": (el) => { ui.settingsView = el.dataset.view; render(); window.scrollTo(0, 0); },
  "change-pick": (el) => {
    const t = data.tokens.find((x) => x.id === ui.changing.tokenId);
    const i = ui.changing.index;
    const error = checkChange(data, t, i, el.dataset.id);
    if (error) return toast(error);
    const before = t.games[i].gameId;
    changeGame(t, i, el.dataset.id);
    ui.changing = null;
    commit();
    toast(`${player(t.playerId)?.name}: ${game(el.dataset.id)?.name} instead of ${game(before)?.name}.`, () => {
      if (t.games[i].startedAt) return toast("Too late to undo: they've started that game.");
      t.games[i].gameId = before;
      commit();
    });
  },
  "end-game": (el) => {
    const t = data.tokens.find((x) => x.id === el.dataset.id);
    const i = Number(el.dataset.i);
    const before = structuredClone(t.games);
    endGame(t, i, el.dataset.r, nowIso());
    if (resultsComplete(t)) ui.editing = { tokenId: t.id, results: t.games.map((g) => g.result), rewardId: undefined };
    commit();
    if (ui.editing) window.scrollTo(0, 0);
    const left = t.games.find((g) => !g.result);
    const next = left ? ` Back in the queue for ${game(left.gameId)?.name}.` : "";
    toast(`${player(t.playerId)?.name} ${el.dataset.r} ${game(t.games[i].gameId)?.name}.${next}`, () => {
      t.games = before;
      ui.editing = null;
      commit();
    });
  },
  give: (el) => {
    const t = data.tokens.find((x) => x.id === el.dataset.id);
    const i = Number(el.dataset.i);
    if (!canGive(data, t, i)) return render();
    startGame(t, i, nowIso());
    commit();
    toast(`${player(t.playerId)?.name} is playing ${game(t.games[i].gameId)?.name}.`, () => {
      t.games[i].startedAt = null;
      commit();
    });
  },
  "delete-token": () => {
    const t = data.tokens.find((x) => x.id === ui.editing.tokenId);
    const name = player(t.playerId)?.name;
    if (!confirm(t.finishedAt ? `Delete ${name}'s token? It won't count in the stats.` : `Cancel ${name}'s token?`)) return;
    const index = data.tokens.indexOf(t);
    data.tokens.splice(index, 1);
    ui.editing = null;
    commit();
    toast("Token removed.", () => { data.tokens.splice(index, 0, t); commit(); });
  },
  undo: () => {
    const fn = toastUndo;
    $("#toast").hidden = true;
    toastUndo = null;
    if (fn) fn();
  },
  backup: async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    data.lastBackupTokens = finishedTokens(data).length;
    const result = await shareFile(`backup-game-stall-${stamp}.json`, "application/json", JSON.stringify(data, null, 1));
    if (result === "cancelled") return;
    commit();
    toast("Backup made. Keep the file somewhere safe.");
  },
  csv: async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    await shareFile(`game-stall-${stamp}.csv`, "text/csv", tokensToCsv(data));
  },
  "stats-csv": async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    await shareFile(`game-stall-stats-${stamp}.csv`, "text/csv", statsToCsv(data));
  },
  "add-reward": () => {
    const name = prompt("Name of the new prize")?.trim();
    if (!name) return;
    data.rewards.push({ id: newId(), name, everyone: false, stock: null });
    commit();
  },
  "delete-reward": (el) => {
    data.rewards = data.rewards.filter((r) => r.id !== el.dataset.id);
    commit();
  },
  "delete-player": (el) => {
    const p = player(el.dataset.id);
    if (!confirm(`Remove ${p.name}?`)) return;
    data.players = data.players.filter((x) => x.id !== p.id);
    if (ui.playerId === p.id) resetStart();
    commit();
  },
  "clear-all": () => {
    const typed = prompt('This removes every player and token. Type CLEAR to confirm.');
    if (typed?.trim().toUpperCase() !== "CLEAR") return;
    const keep = { title: data.title, games: data.games, rewards: data.rewards };
    data = { ...defaultData(), ...keep };
    resetStart();
    ui.editing = null;
    commit();
    toast("All data cleared.");
  },
};

function readNewPlayer() {
  if (!ui.newPlayer) return;
  const name = $("#np-name");
  const cls = $("#np-cls");
  if (name) ui.newPlayer.name = name.value;
  if (cls) ui.newPlayer.cls = cls.value;
}

// ---- events ----------------------------------------------------------------

document.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    ui.tab = tab.dataset.tab;
    ui.editing = null;
    ui.changing = null;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action] && !el.disabled) actions[el.dataset.action](el);
});

document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    ui.search = e.target.value;
    $("#matches").innerHTML = matchesHtml();
  } else if (e.target.id === "log-filter") {
    ui.logFilter = e.target.value;
    const caret = e.target.selectionStart;
    render();
    const box = $("#log-filter");
    box.focus();
    box.setSelectionRange(caret, caret);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "search") {
    const first = playerMatches()[0];
    if (first && playerMatches().length === 1) actions["pick-player"]({ dataset: { id: first.id } });
    else actions["new-player"]();
  } else if (e.target.id === "np-name" || e.target.id === "np-cls") {
    e.target.blur();
  }
});

// Names in Setup save when the box loses focus, so a half-typed name isn't stored.
document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.id === "restore") {
    const file = el.files[0];
    el.value = "";
    if (!file) return;
    try {
      const restored = parseData(await file.text());
      const n = finishedTokens(restored).length;
      if (!confirm(`Replace what's on this phone with the backup (${restored.players.length} players, ${n} tokens)?`)) return;
      data = restored;
      data.lastBackupTokens = n;
      resetStart();
      commit();
      toast("Backup restored.");
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  const value = el.value.trim().replace(/\s+/g, " ");
  const kind = el.dataset.edit;
  if (!kind) return;
  if (kind === "title") {
    data.title = value || DEFAULT_TITLE;
    el.value = data.title;
    saveFailed = !save(data);
    $("#title").textContent = data.title;
    document.title = data.title;
    renderBanner();
    return;
  }
  if (kind === "tokens-collected") {
    const n = parseStock(el.value);
    if (n === undefined) {
      el.value = data.tokensCollected ?? "";
      toast("Type a whole number, like 120.");
      return;
    }
    data.tokensCollected = n;
    commit();
    return;
  }
  if (kind === "game-limit") {
    const g = game(el.dataset.id);
    const limit = parseLimit(el.value);
    if (limit === undefined) {
      el.value = g.limit ?? "";
      toast("Type the minutes, like 5, or leave it blank for no limit.");
      return;
    }
    if (limit === null) delete g.limit;
    else g.limit = limit;
    el.value = limit ?? "";
    saveFailed = !save(data);
    renderBanner();
    return;
  }
  if (kind === "reward-stock") {
    const r = reward(el.dataset.id);
    const stock = parseStock(el.value);
    if (stock === undefined) {
      el.value = r.stock ?? "";
      toast("Type a whole number, like 25.");
      return;
    }
    r.stock = stock;
    el.value = stock ?? "";
    saveFailed = !save(data);
    const line = document.querySelector(`[data-left="${r.id}"]`);
    line.textContent = stockLine(r);
    line.classList.toggle("low", isLow(r));
    renderBanner();
    return;
  }
  const target = {
    game: () => data.games.find((g) => g.id === el.dataset.id),
    reward: () => data.rewards.find((r) => r.id === el.dataset.id),
    "player-name": () => player(el.dataset.id),
    "player-cls": () => player(el.dataset.id),
  }[kind]?.();
  if (!target) return;
  if (kind === "player-cls") target.cls = value.toUpperCase();
  else if (value) target.name = value;
  else el.value = target.name; // an empty name isn't allowed: put the old one back
  // Save without redrawing, so the next box the user tapped keeps its focus.
  saveFailed = !save(data);
  renderBanner();
});

// Keep the minutes on the In play cards current.
setInterval(() => {
  if (["play", "queue"].includes(ui.tab) && !ui.editing && !ui.changing) render();
}, 30000);

// Time limits: every second, rewrite the countdowns on screen. When a game's clock changes phase
// (last minute, time's up), redraw so its card and the top line change colour. A game buzzes the
// phone once, the first time this phone sees its time is up (vibration works on Android, not iPhone).
const buzzed = new Set();
let lastPhases = "";
function tickTimers() {
  const now = Date.now();
  let fresh = false;
  for (const x of timesUp(data, now)) {
    const key = `${x.token.id}:${x.index}:${x.token.games[x.index].startedAt}`;
    if (!buzzed.has(key)) { buzzed.add(key); fresh = true; }
  }
  if (fresh) navigator.vibrate?.([400, 200, 400, 200, 400]);
  const phases = playingNow(data).map((t) => {
    const i = t.games.findIndex((g) => g.startedAt && !g.result);
    const left = secondsLeft(data, t.games[i], now);
    return left == null ? "" : `${t.id}:${i}:${timerPhase(left)}`;
  }).join(",");
  if (phases !== lastPhases) {
    lastPhases = phases;
    if (ui.tab === "play" && !ui.editing && !ui.changing) render();
    else renderBanner();
  }
  document.querySelectorAll("[data-timer]").forEach((el) => {
    const t = data.tokens.find((x) => x.id === el.dataset.timer);
    const left = t && secondsLeft(data, t.games[Number(el.dataset.i)], now);
    if (left != null) el.textContent = timerText(left, el.hasAttribute("data-short"));
  });
}
setInterval(tickTimers, 1000);

// Keep the screen on while the app is open (Setup → Screen). The browser lets go of this whenever
// the app is hidden, so it's asked for again each time the app comes back.
let screenLock = null;
async function keepScreenOn() {
  if (!data.keepAwake || screenLock || document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
  try {
    screenLock = await navigator.wakeLock.request("screen");
    screenLock.addEventListener("release", () => { screenLock = null; });
  } catch {
    // Refused (battery saver, or no tap yet): the next tap tries again.
  }
}
function releaseScreen() {
  screenLock?.release().catch(() => {});
  screenLock = null;
}
document.addEventListener("visibilitychange", keepScreenOn);
document.addEventListener("click", keepScreenOn);

render();
keepScreenOn();
askPersistent();
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Offline mode unavailable", err));
}
