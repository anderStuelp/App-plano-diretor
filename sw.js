/* PD-SLZ Campo – service worker: o app abre e funciona sem internet */
const VERSAO = 'pdslz-campo-1.1.0';
const MAPAS = 'pdslz-campo-mapas';
const SHELL = ['./', './index.html', './app.js', './catalogo.js', './config.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSAO && k !== MAPAS) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'atualizar') self.skipWaiting(); });

async function limitarMapas(max) {
  const c = await caches.open(MAPAS);
  const ks = await c.keys();
  for (let i = 0; i < ks.length - max; i++) await c.delete(ks[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    const ehConfig = url.pathname.endsWith('/config.js') || /\/webgis\.(html|js)$/.test(url.pathname);
    e.respondWith((async () => {
      const cache = await caches.open(VERSAO);
      const naRede = fetch(req).then((r) => { if (r && r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
      if (ehConfig) { const r = await naRede; if (r) return r; }
      const emCache = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
      if (emCache) { e.waitUntil(naRede); return emCache; }
      const r = await naRede;
      return r || new Response('Sem conexão', { status: 503 });
    })());
    return;
  }
  if (/arcgisonline\.com|tile\.openstreetmap\.org/.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(MAPAS);
      const m = await c.match(req);
      if (m) return m;
      try {
        const r = await fetch(req);
        if (r && (r.ok || r.type === 'opaque')) { c.put(req, r.clone()); limitarMapas(3000); }
        return r;
      } catch (err) { return new Response('', { status: 504 }); }
    })());
  }
});
