import {
  PLAYER_TYPES, RESULTS, newId, defaultData, checkGamePick, checkFinish, wonAny, resultsComplete,
  openTokens, finishedTokens, computeStats, tokensToCsv, parseData,
  DEFAULT_TITLE, givenCount, leftCount, parseStock, SLOT_MINUTES, MIN_PLAYS_FOR_RATE,
  gameState, queue, playingNow, canGive, startToken, startGame, endGame, waitMinutes, checkChange, changeGame,
} from "./rules.js";
import { load, save, tokensSinceBackup, askPersistent, shareFile } from "./store.js";

const BACKUP_NAG_EVERY = 20;
const LOW_STOCK = 3; // warn when this many or fewer of a prize are left

let data = load();
let saveFailed = false;

const ui = {
  tab: "start",
  search: "",
  playerId: null,        // player picked for a new token
  newPlayer: null,       // { name, type, cls } while the form is open
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

function who(p) {
  if (!p) return "Unknown";
  return p.type === "student" && p.cls ? `${cap(p.type)} · ${esc(p.cls)}` : cap(p.type);
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
  else view.innerHTML = { start: startHtml, queue: queueHtml, play: playHtml, log: logHtml, stats: statsHtml, setup: setupHtml }[ui.tab]();
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
  const low = data.rewards.filter(isLow);
  if (low.length) {
    parts.push(`<span>Running low: ${low.map((r) => `<b>${esc(r.name)}</b> ${leftText(r)}`).join(", ")}</span>`);
  }
  if (since >= BACKUP_NAG_EVERY) {
    parts.push(`<span class="banner-line"><span>${since} tokens since the last backup.</span><button class="btn" data-action="backup">Back up</button></span>`);
  }
  el.className = "banner";
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
        const full = ui.picked.length >= 2 && !on;
        return `<button class="choice" data-action="toggle-game" data-id="${g.id}" aria-pressed="${on}" ${full ? "disabled" : ""}>
          <span class="num">${i + 1}</span>${esc(g.name)}${tableStatusHtml(g.id)}</button>`;
      }).join("")}
    </div>
    ${error ? `<p class="small" style="color:var(--danger)">${esc(error)}</p>` : ""}
    <p></p>
    <button class="btn primary block" data-action="start-token" ${ui.picked.length === 2 && !error ? "" : "disabled"}>Start token</button>
  `;
}

function tableStatusHtml(gameId) {
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
      <label class="field" for="np-cls">Class</label>
      <input type="text" id="np-cls" value="${esc(np.cls)}" placeholder="e.g. 5B" autocomplete="off" autocapitalize="characters">` : ""}
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
  const right = showTime ? time(t.finishedAt) : `${minutesSince(t.startedAt)} min`;
  const prize = t.finishedAt && t.rewardId ? `<span class="pill prize">${esc(reward(t.rewardId)?.name)}</span>` : "";
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
        return `<div class="queue-game"><span class="pill in-use">${name} · ${esc(player(on?.token.playerId)?.name)} playing</span>${change}</div>`;
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
        return `<button class="choice" data-action="change-pick" data-id="${g.id}" ${ok ? "" : "disabled"}>
          <span class="num">${n + 1}</span>${esc(g.name)}${ok ? tableStatusHtml(g.id) : `<span class="left">${g.id === old?.id ? "now" : "their other game"}</span>`}</button>`;
      }).join("")}
    </div>
  `;
}

function playHtml() {
  const playing = playingNow(data);
  const ready = openTokens(data).filter(resultsComplete).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (!playing.length && !ready.length) {
    return `<div class="empty">Nobody is playing right now.<br><br><button class="btn primary" data-tab="queue">Go to the queue</button></div>`;
  }
  return `
    ${ready.length ? `<h2>Pick a prize</h2><p class="small muted">Both games done. Tap to finish the token.</p>
      ${ready.map((t) => tokenCardHtml(t, false)).join("")}` : ""}
    ${playing.length ? `<h2>Playing now <span class="muted small">(${playing.length})</span></h2>
    <p class="small muted">When a player says they're done, tap Won or Lost.</p>
    ${playing.map((t) => {
      const i = t.games.findIndex((g) => g.startedAt && !g.result);
      const g = t.games[i];
      return `<div class="card play-card">
        <div class="head"><span class="game-name">${esc(game(g.gameId)?.name)}</span>
          <span class="muted small">${minutesSince(g.startedAt)} min</span></div>
        <div>${nameBtn(t)} <span class="small muted">${who(player(t.playerId))}</span></div>
        <div class="choices">
          ${RESULTS.map((r) => `<button class="choice ${r}" data-action="end-game" data-id="${t.id}" data-i="${i}" data-r="${r}">${cap(r)}</button>`).join("")}
        </div>
      </div>`;
    }).join("")}` : ""}
  `;
}

// Editing a token (finishing one in play, or fixing one in the log) ------------

// Both games on a token and where each one stands, for the top of the token screen.
function tokenGamesHtml(t) {
  const place = queue(data).indexOf(t) + 1;
  const rows = t.games.map((g) => {
    let status;
    if (g.result) status = `<span class="pill ${g.result}">${cap(g.result)}</span>`;
    else if (g.startedAt) status = `<span class="pill playing">Playing now · ${minutesSince(g.startedAt)} min</span>`;
    else if (t.finishedAt) status = `<span class="muted">not played</span>`;
    else if (place) status = `<span class="pill in-use">Waiting · ${ordinal(place)} in queue</span>`;
    else status = `<span class="muted">next, after this game</span>`;
    const changed = g.registeredGameId ? `<div class="small muted">changed from ${esc(game(g.registeredGameId)?.name)}</div>` : "";
    return `<div class="token-game"><div><b>${esc(game(g.gameId)?.name)}</b>${changed}</div>${status}</div>`;
  });
  return `<div class="card token-games"><div class="small muted">Their games</div>${rows.join("")}</div>`;
}

function editorHtml() {
  const t = data.tokens.find((x) => x.id === ui.editing.tokenId);
  const p = player(t.playerId);
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
    <button class="btn danger block" data-action="delete-token">${finishing ? "Cancel this token" : "Delete this token"}</button>
  `;
}

// Log -----------------------------------------------------------------------

function logHtml() {
  const q = ui.logFilter.trim().toLowerCase();
  const done = finishedTokens(data)
    .filter((t) => !q || (player(t.playerId)?.name || "").toLowerCase().includes(q))
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  return `
    <h2>Finished tokens</h2>
    <input type="search" id="log-filter" placeholder="Filter by name" value="${esc(ui.logFilter)}" autocomplete="off">
    <p></p>
    <div id="log-list">${done.length ? done.map((t) => tokenCardHtml(t, true)).join("") : `<div class="empty">${q ? "No match." : "No finished tokens yet."}</div>`}</div>
  `;
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
  if (s.longestWait && s.longestWait.minutes >= 1) add("Longest wait", esc(s.longestWait.name), `${Math.round(s.longestWait.minutes)} min`);
  if (s.longest && s.tokens > 1) add("Longest token", esc(s.longest.name), `${Math.round(s.longest.minutes)} min`);
  return rows.length ? `<div class="card highlights">${rows.join("")}</div>` : "";
}

function tableHtml(head, rows) {
  return `<div class="table-wrap"><table class="table"><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function statsHtml() {
  const s = computeStats(data);
  if (!s.tokens) {
    return `<div class="empty">Stats show up once the first token is finished.${s.inPlay ? `<br><br>${plural(s.inPlay, "token")} in play now.` : ""}</div>`;
  }
  const kpi = (value, label) => `<div class="kpi"><div class="value">${value}</div><div class="label">${label}</div></div>`;
  const o = s.outcomes;
  return `
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

    <h2>Students and teachers</h2>
    <div class="card">${tableHtml(["", "Players", "Tokens", "Won", "Favourite"],
      s.typeStats.map((t) => [cap(t.type) + "s", t.players, t.tokens, pct(t.winRate), esc(nameList(t.favourite, 2))]))}</div>

    ${s.classStats.length ? `<h2>Classes</h2>
    <div class="card">${tableHtml(["Class", "Players", "Tokens", "Won"], s.classStats.map((c) => [esc(c.cls), c.players, c.tokens, pct(c.winRate)]))}</div>` : ""}

    <h2>Favourite pairs</h2>
    <div class="card">${barsHtml(s.pairs.slice(0, 8).map((p) => ({ label: p.names.join(" + "), value: p.count })))}</div>

    <h2>Prizes given</h2>
    <div class="card">${barsHtml(s.rewards.map((r) => ({ label: r.name, value: r.count, text: r.left == null ? r.count : `${r.count} · ${r.left} left` })))}
      ${s.noPick ? `<p class="small muted">${plural(s.noPick, "winner")} took no prize.</p>` : ""}</div>

    <h2>Most wins</h2>
    <div class="card">${barsHtml(s.topWinners.map((p) => ({ label: p.name, value: p.wins, text: `${p.wins} of ${p.plays}` })))}</div>

    <h2>Most tokens</h2>
    <div class="card">${barsHtml(s.topPlayers.map((p) => ({ label: p.name, value: p.tokens })))}</div>
  `;
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
      <label class="btn block" for="restore">Restore from a backup…</label>
      <input type="file" id="restore" accept="application/json,.json" hidden>
    </div>

    <h2>Games</h2>
    <div class="card">
      ${data.games.map((g, i) => `<div class="edit-row"><span class="tag">${i + 1}</span>
        <input type="text" data-edit="game" data-id="${g.id}" value="${esc(g.name)}" aria-label="Game ${i + 1} name"></div>`).join("")}
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
        ${p.type === "student" ? `<input type="text" data-edit="player-cls" data-id="${p.id}" value="${esc(p.cls)}" aria-label="Class" style="flex:0 0 5.5em">` : `<span class="tag">${cap(p.type)}</span>`}
        ${tokenCount(p.id) ? "" : `<button class="btn" data-action="delete-player" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>`}
      </div>`).join("") : `<p class="muted small">No players yet.</p>`}
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
  "new-player": () => { ui.newPlayer = { name: ui.search.trim(), type: null, cls: "" }; render(); $("#np-name")?.focus(); },
  "np-type": (el) => { readNewPlayer(); ui.newPlayer.type = el.dataset.type; render(); if (el.dataset.type === "student") $("#np-cls")?.focus(); },
  "np-cancel": () => { ui.newPlayer = null; render(); },
  "np-save": () => {
    readNewPlayer();
    const np = ui.newPlayer;
    const name = np.name.trim().replace(/\s+/g, " ");
    if (!name) return toast("Type their name first.");
    if (!np.type) return toast("Choose who they are.");
    const same = data.players.find((p) => p.name.toLowerCase() === name.toLowerCase() && (p.cls || "") === (np.cls || "").trim());
    if (same && !confirm(`There is already a ${same.name}. Add another player with the same name?`)) return;
    const p = { id: newId(), name, type: np.type, cls: np.type === "student" ? np.cls.trim().toUpperCase() : "", registeredAt: nowIso() };
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
  "change-open": (el) => {
    ui.changing = { tokenId: el.dataset.id, index: Number(el.dataset.i) };
    render();
    window.scrollTo(0, 0);
  },
  "change-close": () => { ui.changing = null; render(); },
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
  if ((ui.tab === "play" || ui.tab === "queue") && !ui.editing) render();
}, 30000);

render();
askPersistent();
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Offline mode unavailable", err));
}
