import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { certificateNames, createStaticServer, ensureCertificate } from '../scripts/serve.mjs';

function request(server, path, { tls, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = (tls ? httpsRequest : httpRequest)({
      hostname: '127.0.0.1', port: server.address().port, path, method,
      ca: tls?.cert, agent: false,
      // No client certificate or key: the server must not require them.
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('Node HTTP and HTTPS serve viewer assets and protect private files', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'glbv-server-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const root = join(folder, 'site');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<title>GLBV</title>');
  await writeFile(join(root, 'app.js'), 'export const ok = true;');
  const glb = Buffer.from([0x67, 0x6c, 0x54, 0x46]);
  await writeFile(join(root, 'sample.glb'), glb);
  await writeFile(join(folder, 'outside.txt'), 'private');
  await symlink(join(folder, 'outside.txt'), join(root, 'outside-link'));
  const certDir = join(root, '.certs');
  const names = ['DNS:localhost', 'IP:127.0.0.1'];
  const tls = await ensureCertificate(certDir, names);
  const parsed = new X509Certificate(tls.cert);
  assert.ok(parsed.checkHost('localhost'));
  assert.ok(parsed.checkIP('127.0.0.1'));
  assert.equal((await stat(join(certDir, 'server.key'))).mode & 0o777, 0o600);
  const reused = await ensureCertificate(certDir, names);
  assert.deepEqual(reused.cert, tls.cert);
  assert.deepEqual(reused.key, tls.key);

  for (const secure of [false, true]) await t.test(secure ? 'HTTPS without client certificate' : 'HTTP', async () => {
    const options = secure ? { tls } : {};
    const server = await createStaticServer({ root, ...options });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const page = await request(server, '/?url=./sample.glb', options);
      assert.equal(page.status, 200);
      assert.equal(page.body.toString(), '<title>GLBV</title>');
      const script = await request(server, '/app.js', options);
      assert.match(script.headers['content-type'], /javascript/);
      const model = await request(server, '/sample.glb', options);
      assert.equal(model.headers['content-type'], 'model/gltf-binary');
      assert.deepEqual(model.body, glb);
      const head = await request(server, '/sample.glb', { ...options, method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assert.equal(head.headers['content-length'], String(glb.length));
      for (const path of ['/.certs/server.key', '/%2ecerts/server.key', '/assets/', '/outside-link', '/%2e%2e/outside.txt']) {
        assert.equal((await request(server, path, options)).status, 403, path);
      }
      assert.equal((await request(server, '/missing.glb', options)).status, 404);
      assert.equal((await request(server, '/bad%zz', options)).status, 400);
      assert.equal((await request(server, '/', { ...options, method: 'POST' })).status, 405);
    } finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  });
  // Changing the requested hostnames must regenerate the server certificate.
  const updated = await ensureCertificate(certDir, [...names, 'DNS:viewer.local']);
  assert.ok(new X509Certificate(updated.cert).checkHost('viewer.local'));
  assert.notDeepEqual(updated.cert, tls.cert);
  assert.deepEqual(await readFile(join(certDir, 'server.crt')), updated.cert);
});

test('default document root serves html assets without exposing repository files', async () => {
  const server = await createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    for (const path of ['/', '/app.js', '/object-tree.js', '/xr-gestures.js', '/style.css', '/sample.glb', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png']) {
      assert.equal((await request(server, path)).status, 200, path);
    }
    const manifest = await request(server, '/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers['content-type'], 'application/manifest+json');
    assert.equal(JSON.parse(manifest.body).display, 'standalone');
    const roomEnvironment = await request(server, '/room-environment.js');
    assert.equal(roomEnvironment.status, 200);
    assert.match(roomEnvironment.headers['content-type'], /javascript/);
    assert.equal((await request(server, '/licenses/three-LICENSE.txt')).status, 200);
    for (const path of ['/package.json', '/README.md', '/scripts/serve.mjs', '/tests/server.test.js']) {
      assert.equal((await request(server, path)).status, 404, path);
    }
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});

test('additional SAN names are validated before writing OpenSSL configuration', () => {
  const names = certificateNames(['viewer.local', '192.168.1.10']);
  assert.ok(names.includes('DNS:viewer.local'));
  assert.ok(names.includes('IP:192.168.1.10'));
  assert.throws(() => certificateNames(['bad\n[extensions]']), /Invalid certificate hostname/);
});
