import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { configurePWA } from '../html/pwa.js';

const source = await readFile(new URL('../html/sw.js', import.meta.url), 'utf8');

function worker(scope = 'https://viewer.example/tools/glbv/') {
  const handlers = new Map();
  const stores = new Map();
  let online = true;
  let claimed = false;
  const requests = [];
  const fetch = async request => {
    if (!online) throw new Error('offline');
    const url = typeof request === 'string' ? request : request.url;
    requests.push(url);
    return new Response(url);
  };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(requests) {
          const responses = await Promise.all(requests.map(fetch));
          requests.forEach((request, i) => entries.set(request.url, responses[i]));
        },
        async match(key) { return entries.get(key)?.clone(); },
        async put(key, response) { entries.set(key, response); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  vm.runInNewContext(source, {
    URL, Request, caches, fetch,
    self: {
      registration: { scope },
      clients: { async claim() { claimed = true; } },
      addEventListener(type, handler) { handlers.set(type, handler); },
    },
  });
  return {
    stores, requests,
    offline() { online = false; },
    get claimed() { return claimed; },
    async lifecycle(type) {
      let work;
      handlers.get(type)({ waitUntil(promise) { work = promise; } });
      await work;
    },
    async get(url, mode = 'cors', method = 'GET') {
      let result;
      const request = new Request(url, { method });
      Object.defineProperty(request, 'mode', { value: mode });
      handlers.get('fetch')({ request, respondWith(promise) { result = promise; } });
      return result;
    },
  };
}

test('installed shell and three.js including lazy decoders work offline under a subpath', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  const urls = [...sw.requests];
  assert.ok(urls.some(url => url.endsWith('/build/three.core.js')));
  assert.ok(urls.some(url => url.endsWith('/draco/gltf/draco_decoder.wasm')));
  assert.ok(urls.some(url => url.endsWith('/basis/basis_transcoder.wasm')));
  assert.ok(urls.includes('https://viewer.example/tools/glbv/room-environment.js'));
  assert.ok(!urls.some(url => url.includes('/examples/jsm/environments/RoomEnvironment.js')));
  sw.offline();
  for (const url of urls) {
    assert.equal(await (await sw.get(url)).text(), url);
  }
  const home = 'https://viewer.example/tools/glbv/';
  for (const path of ['?url=./sample.glb', 'index.html?url=https://example.com/model.glb']) {
    assert.equal(await (await sw.get(home + path, 'navigate')).text(), home);
  }
  assert.equal(await sw.get(home + 'private.glb'), undefined);
  assert.equal(await sw.get(home + 'reset.html', 'navigate'), undefined);
  assert.equal(await sw.get('https://example.com/model.glb'), undefined);
  assert.equal(await sw.get(home, 'cors', 'POST'), undefined);
  assert.equal(await sw.get('https://viewer.example/other/', 'navigate'), undefined);
});

test('activation cleans only this app scope and failed installs reject', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  const current = [...sw.stores.keys()][0];
  const prefix = current.replace(/v\d+-three-\d+$/, '');
  sw.stores.set(prefix + 'old', new Map());
  sw.stores.set('unrelated-app', new Map());
  await sw.lifecycle('activate');
  assert.deepEqual([...sw.stores.keys()], [current, 'unrelated-app']);
  assert.equal(sw.claimed, true);
  const firstVisitOffline = worker();
  firstVisitOffline.offline();
  await assert.rejects(firstVisitOffline.lifecycle('install'), /offline/);
});

test('nocache unregisters this viewer, clears only its caches, and reloads to release control', async () => {
  const scope = 'https://viewer.example/tools/glbv/';
  const prefix = `glbv-${encodeURIComponent(scope)}-`;
  const deleted = [], unregistered = [], registered = [];
  let reloads = 0;
  const environment = {
    location: { href: scope + '?url=./sample.glb&nocache=1', reload() { reloads++; } },
    secureContext: true,
    navigator: { serviceWorker: {
      controller: { scriptURL: scope + 'sw.js' },
      async getRegistrations() {
        return [scope, 'https://viewer.example/other/'].map(scope => ({
          scope, async unregister() { unregistered.push(scope); return true; },
        }));
      },
      async register(...args) { registered.push(args); },
    } },
    caches: {
      async keys() { return [prefix + 'v1', prefix + 'v2', 'unrelated']; },
      async delete(name) { deleted.push(name); },
    },
  };
  assert.equal(await configurePWA(environment), false);
  assert.equal(reloads, 1);
  assert.deepEqual(unregistered, [scope]);
  assert.deepEqual(deleted, [prefix + 'v1', prefix + 'v2']);
  assert.deepEqual(registered, []);
  environment.navigator.serviceWorker.controller = null;
  assert.equal(await configurePWA(environment), true);
  assert.equal(reloads, 1, 'uncontrolled page must not reload again');
  environment.location.href = scope + '?url=./sample.glb';
  assert.equal(await configurePWA(environment), true);
  assert.equal(registered[0][0], scope + 'sw.js');
});

test('nocache navigations use browser networking without respondWith or a worker fetch', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  const home = 'https://viewer.example/tools/glbv/';
  const requestsBefore = sw.requests.length;
  for (const path of ['?nocache=1&url=./sample.glb', 'index.html?nocache=1']) {
    assert.equal(await sw.get(home + path, 'navigate'), undefined);
  }
  assert.equal(sw.requests.length, requestsBefore, 'worker must not fetch the navigation');
  sw.offline();
  assert.equal(await sw.get(home + '?nocache=1', 'navigate'), undefined);
  assert.equal(await (await sw.get(home, 'navigate')).text(), home);
});

test('standalone recovery removes only this viewer and offers an uncached navigation', async () => {
  const html = await readFile(new URL('../html/reset.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:src|href)=/i);
  const scope = 'https://viewer.example/tools/glbv/';
  const prefix = `glbv-${encodeURIComponent(scope)}-`;
  const elements = { reset: {}, status: {}, viewer: { hidden: true } };
  const unregistered = [], deleted = [];
  let fail = false;
  const caches = {
    async keys() { return [prefix + 'v1', prefix + 'v2', 'unrelated']; },
    async delete(name) { deleted.push(name); },
  };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    URL, location: { href: scope + 'reset.html' },
    document: { getElementById(id) { return elements[id]; } },
    window: { caches }, caches,
    navigator: { serviceWorker: {
      async getRegistrations() {
        if (fail) throw new Error('blocked');
        return [scope, 'https://viewer.example/other/'].map(scope => ({
          scope, async unregister() { unregistered.push(scope); return true; },
        }));
      },
    } },
  });
  await elements.reset.onclick();
  assert.deepEqual(unregistered, [scope]);
  assert.deepEqual(deleted, [prefix + 'v1', prefix + 'v2']);
  assert.equal(elements.viewer.href, scope + '?nocache=1');
  assert.equal(elements.viewer.hidden, false);
  assert.equal(elements.reset.disabled, false);
  fail = true;
  await elements.reset.onclick();
  assert.equal(elements.viewer.hidden, true);
  assert.match(elements.status.textContent, /解除できませんでした。blocked/);
  assert.equal(elements.reset.disabled, false);
});
