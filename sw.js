// Keeps the app's files on the phone so it opens without internet.
// Raise CACHE whenever a file below changes, or phones keep the old copy.
const CACHE = "game-stall-v24";
const FILES = [
  "./", "index.html", "style.css", "app.js", "rules.js", "store.js", "manifest.json",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "fonts/bangers.woff2",
];

self.addEventListener("install", (e) => {
  // "reload" fetches fresh copies, so an old file the browser kept can't be stored as the offline copy.
  const fresh = FILES.map((f) => new Request(f, { cache: "reload" }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so a fixed version shows up when online; the cached copy when offline.
// "no-cache" asks the server every time instead of using the browser's own copy, which GitHub
// Pages lets it keep for 10 minutes. Without it, a phone could mix a new page with an old script
// just after an update, and every button would stop working.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))),
  );
});
