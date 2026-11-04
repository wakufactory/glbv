// Bump this version whenever the app shell or its dependencies change.
const CACHE_PREFIX = `glbv-${encodeURIComponent(self.registration.scope)}-`;
const CACHE_NAME = `${CACHE_PREFIX}v3-three-187`;
const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.187.0/';
const LOCAL_ASSETS = [
  './', './index.html', './style.css', './app.js', './object-tree.js',
  './xr-gestures.js', './pwa.js', './sample.glb', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
].map(path => new URL(path, self.registration.scope).href);
// Include transitive module imports and lazy-loaded compression decoders so
// even the first compressed GLB opened after installation works offline.
const THREE_ASSETS = [
  'build/three.module.js',
  'build/three.core.js',
  'examples/jsm/controls/OrbitControls.js',
  'examples/jsm/environments/RoomEnvironment.js',
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/loaders/DRACOLoader.js',
  'examples/jsm/loaders/KTX2Loader.js',
  'examples/jsm/libs/meshopt_decoder.module.js',
  'examples/jsm/libs/ktx-parse.module.js',
  'examples/jsm/libs/zstddec.module.js',
  'examples/jsm/math/ColorSpaces.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
  'examples/jsm/utils/SkeletonUtils.js',
  'examples/jsm/utils/WorkerPool.js',
  'examples/jsm/libs/draco/gltf/draco_decoder.js',
  'examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js',
  'examples/jsm/libs/draco/gltf/draco_decoder.wasm',
  'examples/jsm/libs/basis/basis_transcoder.js',
  'examples/jsm/libs/basis/basis_transcoder.wasm',
].map(path => THREE_CDN + path);
const ASSETS = new Set([...LOCAL_ASSETS, ...THREE_ASSETS]);

self.addEventListener('install', event => {
  // Fail installation if any dependency is missing. Keep the previous worker
  // active until all its windows close to avoid mixing app versions.
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(
    [...ASSETS].map(url => new Request(url, { mode: 'cors', cache: 'reload' })),
  )));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const home = new URL('./', self.registration.scope);
  // Ignore navigation query parameters (including ?url=...) only for the app
  // document. Arbitrary remote/user GLBs are never stored in the app cache.
  const isAppNavigation = event.request.mode === 'navigate' &&
    url.origin === home.origin &&
    [home.pathname, `${home.pathname}index.html`].includes(url.pathname);
  if (isAppNavigation && url.searchParams.get('nocache') === '1') {
    event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
    return;
  }
  const key = isAppNavigation ? home.href : url.href;
  if (!ASSETS.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  })());
});
