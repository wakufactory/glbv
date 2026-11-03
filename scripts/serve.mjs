import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHTTPServer } from 'node:http';
import { createServer as createHTTPSServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { isIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function certificateNames(extra = []) {
  const names = new Set(['localhost', '127.0.0.1', '::1', hostname(), ...extra]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) names.add(entry.address.split('%')[0]);
  }
  return [...names].sort().map(name => {
    if (isIP(name)) return `IP:${name}`;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(name)) {
      throw new Error(`Invalid certificate hostname: ${name}`);
    }
    return `DNS:${name}`;
  });
}

export async function ensureCertificate(directory, names) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const certPath = join(directory, 'server.crt');
  const keyPath = join(directory, 'server.key');
  const metadata = join(directory, 'names.json');
  try {
    const cert = await readFile(certPath);
    const key = await readFile(keyPath);
    const previousNames = JSON.parse(await readFile(metadata, 'utf8'));
    const parsed = new X509Certificate(cert);
    const now = Date.now();
    const matches = names.every(name => name.startsWith('IP:')
      ? parsed.checkIP(name.slice(3)) : parsed.checkHost(name.slice(4)));
    if (JSON.stringify(previousNames) === JSON.stringify(names) && matches &&
        Date.parse(parsed.validFrom) <= now && Date.parse(parsed.validTo) > now + 86400000) {
      createSecureContext({ cert, key }); // Also verify that the private key matches.
      await chmod(keyPath, 0o600);
      return { cert, key };
    }
  } catch { /* Missing, expired or invalid certificate: generate a new one. */ }
  const temporary = await mkdtemp(join(directory, 'generate-'));
  try {
    await chmod(temporary, 0o700);
    const config = join(temporary, 'openssl.cnf');
    await writeFile(config, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=GLBV local development\n[extensions]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names.join(',')}\n`);
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
        '-days', '365', '-config', config, '-keyout', join(temporary, 'key'),
        '-out', join(temporary, 'cert')], { stdio: 'pipe' });
    } catch {
      throw new Error('Certificate generation failed. Install OpenSSL and ensure it is on PATH.');
    }
    await chmod(join(temporary, 'key'), 0o600);
    await rename(join(temporary, 'key'), keyPath);
    await rename(join(temporary, 'cert'), certPath);
    await writeFile(metadata, JSON.stringify(names));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log('Generated local self-signed certificate.');
  return { cert: await readFile(certPath), key: await readFile(keyPath) };
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function allowedPath(root, path) {
  const name = relative(root, path);
  return !isAbsolute(name) && !name.split(sep).some(part => part.startsWith('.'));
}

export async function createStaticServer({ root = ROOT, tls } = {}) {
  root = await realpath(root);
  const handler = async (request, response) => {
    const fail = (code, message) => {
      response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : message);
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return fail(405, 'Method not allowed');
    }
    try {
      let pathname;
      try { pathname = decodeURIComponent(request.url.split('?')[0]).replaceAll('\\', '/'); }
      catch { return fail(400, 'Invalid path'); }
      if (!pathname.startsWith('/') || pathname.includes('\0')) return fail(400, 'Invalid path');
      let path = resolve(root, '.' + pathname);
      if (!allowedPath(root, path)) return fail(403, 'Forbidden');
      path = await realpath(path);
      if (!allowedPath(root, path)) return fail(403, 'Forbidden');
      let file = await stat(path);
      if (file.isDirectory()) {
        // Serve an index but never a directory listing, including certificate folders.
        path = await realpath(join(path, 'index.html')).catch(() => null);
        if (!path || !allowedPath(root, path)) return fail(403, 'Directory listing disabled');
        file = await stat(path);
      }
      if (!file.isFile()) return fail(403, 'Forbidden');
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': file.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (request.method === 'HEAD') return response.end();
      const stream = createReadStream(path);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return fail(404, 'Not found');
      if (['EACCES', 'EPERM'].includes(error.code)) return fail(403, 'Forbidden');
      console.error('Unable to serve request:', error.message);
      fail(500, 'Server error');
    }
  };
  return tls
    ? createHTTPSServer({ ...tls, minVersion: 'TLSv1.2', requestCert: false }, handler)
    : createHTTPServer(handler);
}

async function main() {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '8443' }, bind: { type: 'string', default: '0.0.0.0' },
    san: { type: 'string', multiple: true, default: [] }, http: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  } });
  if (values.help) {
    console.log('node scripts/serve.mjs [--port 8443] [--bind 0.0.0.0] [--san LAN_IP_OR_HOST] [--http]');
    return;
  }
  if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) {
    throw new Error('Port must be between 1 and 65535.');
  }
  const names = certificateNames(values.san);
  const tls = values.http ? undefined : await ensureCertificate(join(ROOT, '.certs'), names);
  const server = await createStaticServer({ tls });
  server.on('error', error => { console.error(`Server error: ${error.message}`); process.exitCode = 1; });
  server.listen(Number(values.port), values.bind, () => {
    const scheme = values.http ? 'http' : 'https';
    console.log(`GLBV: ${scheme}://localhost:${values.port}`);
    if (['0.0.0.0', '::'].includes(values.bind)) {
      for (const name of names) if (name.startsWith('IP:') && isIP(name.slice(3)) === 4 && !name.startsWith('IP:127.')) {
        console.log(`LAN:  ${scheme}://${name.slice(3)}:${values.port}`);
      }
    }
    if (tls) console.log('Self-signed server certificate; no client certificate required.');
    console.log('Ctrl+C to stop.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
