/* Service worker for the offline package of AI Image Dataset Collector.
   App shell is cached on install. The AI model and ONNX runtime (.wasm) are NOT cached here:
   the app downloads them on first use and keeps them in IndexedDB, so they are stored only once. */
const SHELL = "adc-shell-v4";
const FILES = ["./", "index.html", "config.js", "manifest.webmanifest", "icon.svg", "vendor/jszip.min.js", "vendor/supabase.js", "ort/ort.wasm.bundle.min.mjs", "models/waste5-v1.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // large AI files: always go to the network; the app caches them itself
  if (url.origin === location.origin && (/\.onnx$/.test(url.pathname) || /\.wasm$/.test(url.pathname))) return;
  if (url.origin === location.origin) {
    // network first for the shell so updates arrive, cache as offline fallback
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); return res; })));
  }
});
