// 건강 측정 v12.0 ME-rPPG — Service Worker
const CACHE_NAME = 'healthmeas-v12-s2';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './legacy/index.html',
  // ME-rPPG assets
  './me-rppg/onnxWorker.js',
  './me-rppg/welchWorker.js',
  './me-rppg/model.onnx',
  './me-rppg/welch_psd.onnx',
  './me-rppg/get_hr.onnx',
  './me-rppg/state.json',
  './me-rppg/blaze_face_short_range.tflite',
  './me-rppg/LICENSE',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
