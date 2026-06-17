/* Basic offline cache for local files (PWA) + Web Share Target handler. */
const CACHE_NAME = 'calendar-notebook-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './mstile-144.png',
  './icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Web Share Target: accept POST at /share-target, stash payload in Cache Storage,
// then redirect user into the app with a key.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(event));
    return;
  }

  if (req.method !== 'GET') return;

  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});

function uuid() {
  // good enough for cache keys
  return (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2)));
}

async function handleShareTarget(event) {
  const form = await event.request.formData();
  const key = uuid();

  const title = form.get('title') || '';
  const text = form.get('text') || '';
  const sharedUrl = form.get('url') || '';

  const files = form.getAll('files').filter(Boolean);

  const meta = {
    title,
    text,
    url: sharedUrl,
    files: files.map((f) => ({ name: f.name, type: f.type, size: f.size }))
  };

  const cache = await caches.open(CACHE_NAME);
  await cache.put(new Request(`./__share/meta/${key}.json`), new Response(JSON.stringify(meta), {
    headers: { 'Content-Type': 'application/json' }
  }));

  // store first file only (keeps it simple + reliable)
  if (files[0]) {
    const f = files[0];
    await cache.put(new Request(`./__share/file/${key}`), new Response(f, {
      headers: { 'Content-Type': f.type || 'application/octet-stream' }
    }));
  }

  return Response.redirect(`./index.html?share_key=${encodeURIComponent(key)}`, 303);
}
