import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const HOSTNAME = 'hotspot-share.local';

const openssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe' });

// Local CA (created once) + a server cert regenerated whenever the IP set changes.
export function createCerts(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = (f) => join(dir, f);

  if (!existsSync(p('ca.crt')) || !existsSync(p('ca.key'))) {
    openssl('req', '-x509', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-keyout', p('ca.key'), '-out', p('ca.crt'), '-days', '3650', '-subj', '/CN=Hotspot Share CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  }

  function issue(ips) {
    const san = ['DNS:' + HOSTNAME, 'DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => 'IP:' + ip)].join(',');
    writeFileSync(p('ext.cnf'), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n`);
    openssl('req', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-keyout', p('server.key'), '-out', p('server.csr'), '-subj', '/CN=' + HOSTNAME);
    openssl('x509', '-req', '-in', p('server.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial',
      '-out', p('server.crt'), '-days', '800', '-extfile', p('ext.cnf'));
    writeFileSync(p('server.sans'), san);
    rmSync(p('server.csr'), { force: true });
    return { key: readFileSync(p('server.key')), cert: readFileSync(p('server.crt')) };
  }

  const current = () => (existsSync(p('server.sans')) ? readFileSync(p('server.sans'), 'utf8') : '');

  return {
    caPath: p('ca.crt'),
    // returns {key, cert}, reissuing only when the SAN list would change
    ensure(ips) {
      const san = ['DNS:' + HOSTNAME, 'DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => 'IP:' + ip)].join(',');
      if (san === current() && existsSync(p('server.crt'))) {
        return { key: readFileSync(p('server.key')), cert: readFileSync(p('server.crt')) };
      }
      return issue(ips);
    },
  };
}
