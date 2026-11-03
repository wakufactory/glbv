"""Serve GLBV over HTTPS with a local self-signed server certificate."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CERT_DIR = ROOT / '.certs'


def local_names(extra):
    names = {'localhost', '127.0.0.1', '::1'}
    hostname = socket.gethostname()
    if re.fullmatch(r'[A-Za-z0-9_.-]+', hostname):
        names.add(hostname)
    try:
        names.update(item[4][0].split('%')[0] for item in socket.getaddrinfo(hostname, None))
    except OSError:
        pass
    # Discover the default LAN interface; UDP connect sends no packet.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(('192.0.2.1', 9))
            names.add(probe.getsockname()[0])
    except OSError:
        pass
    names.update(extra)
    result = []
    for name in sorted(names):
        try:
            result.append('IP:' + str(ipaddress.ip_address(name)))
        except ValueError:
            if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', name):
                raise ValueError(f'Invalid certificate hostname: {name}')
            result.append('DNS:' + name)
    return result


def certificate(names):
    if not shutil.which('openssl'):
        raise RuntimeError('OpenSSL is required to generate the HTTPS certificate.')
    CERT_DIR.mkdir(mode=0o700, exist_ok=True)
    CERT_DIR.chmod(0o700)
    cert, key, metadata = (CERT_DIR / name for name in ('server.crt', 'server.key', 'names.json'))
    if cert.exists() and key.exists() and metadata.exists():
        try:
            valid = json.loads(metadata.read_text()) == names
        except (ValueError, OSError):
            valid = False
        if valid and subprocess.run(['openssl', 'x509', '-in', str(cert), '-checkend', '86400', '-noout'], capture_output=True).returncode == 0:
            key.chmod(0o600)
            return cert, key
    # TemporaryDirectory is private even while OpenSSL is writing the key.
    with tempfile.TemporaryDirectory(dir=CERT_DIR) as folder:
        folder = Path(folder)
        config = folder / 'openssl.cnf'
        config.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n'
                          '[dn]\nCN=GLBV local development\n[extensions]\n'
                          'basicConstraints=critical,CA:FALSE\n'
                          'keyUsage=critical,digitalSignature,keyEncipherment\n'
                          'extendedKeyUsage=serverAuth\nsubjectAltName=' + ','.join(names) + '\n')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
                        '-days', '365', '-config', str(config), '-keyout', str(folder / 'key'),
                        '-out', str(folder / 'cert')], check=True, capture_output=True)
        (folder / 'key').chmod(0o600)
        (folder / 'key').replace(key)
        (folder / 'cert').replace(cert)
    metadata.write_text(json.dumps(names))
    print('Generated local self-signed certificate.', flush=True)
    return cert, key


class StaticHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = Path(self.translate_path(self.path)).resolve()
        try:
            relative = path.relative_to(ROOT)
        except ValueError:
            self.send_error(403)
            return None
        if any(part.startswith('.') for part in relative.parts):
            self.send_error(403)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(403, 'Directory listing disabled')
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8443)
    parser.add_argument('--bind', default='0.0.0.0')
    parser.add_argument('--san', action='append', default=[], help='Additional LAN IP address or DNS name')
    parser.add_argument('--http', action='store_true', help='Serve plain HTTP instead of HTTPS')
    args = parser.parse_args()
    names = local_names(args.san)
    context = None
    if not args.http:
        cert, key = certificate(names)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.verify_mode = ssl.CERT_NONE  # No client certificate is requested.
        context.load_cert_chain(cert, key)
    handler = partial(StaticHandler, directory=str(ROOT))
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        if context:
            server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = 'https' if context else 'http'
        print(f'GLBV: {scheme}://localhost:{args.port}', flush=True)
        if args.bind == '0.0.0.0':
            for entry in names:
                if entry.startswith('IP:'):
                    address = ipaddress.ip_address(entry[3:])
                    if address.version == 4 and not address.is_loopback:
                        print(f'LAN:  {scheme}://{address}:{args.port}', flush=True)
        if context:
            print('Self-signed server certificate; no client certificate required.', flush=True)
        print('Ctrl+C to stop.', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
