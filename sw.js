// Bump the version whenever any cached file changes so installed phones pick up the update.
const CACHE = 'readaloud-v3';
const FILES = [
    './',
    './index.html',
    './app.js',
    './pronounce.js',
    './voicepacks.js',
    './settings.js',
    './piper-worker.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './vendor/pdf.min.mjs',
    './vendor/pdf.worker.min.mjs',
];
// App caches are named readaloud-v<N>. Voice packs live in readaloud-voices-v1 and must survive updates.
const APP_CACHE = /^readaloud-v\d+$/;

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((name) => APP_CACHE.test(name) && name !== CACHE).map((name) => caches.delete(name))))
            .then(() => self.clients.claim())
    );
});

// Answers from any cache, which includes downloaded voice packs and the speech engine.
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || fetch(event.request))
    );
});
