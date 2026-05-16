const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const certDir = path.join(root, '.cert');
const keyPath = path.join(certDir, 'dev.key');
const certPath = path.join(certDir, 'dev.crt');
const configPath = path.join(certDir, 'openssl.cnf');
const defaultPort = process.env.PORT || '3443';

function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];

  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      ips.push(entry.address);
    }
  }

  return ips;
}

const lanIps = getLanIps();
fs.mkdirSync(certDir, { recursive: true });

const altNames = [
  'DNS.1 = localhost',
  'IP.1 = 127.0.0.1',
  ...lanIps.map((ip, index) => `IP.${index + 2} = ${ip}`),
].join('\n');

const config = `
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = ubrush-dev

[v3_req]
subjectAltName = @alt_names

[alt_names]
${altNames}
`;

fs.writeFileSync(configPath, config.trimStart(), 'utf8');

execFileSync('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-days',
  '825',
  '-keyout',
  keyPath,
  '-out',
  certPath,
  '-config',
  configPath,
], { stdio: 'inherit' });

console.log('');
console.log(`Created ${certPath}`);
console.log(`Created ${keyPath}`);
if (lanIps.length > 0) {
  console.log('');
  console.log('LAN URLs:');
  for (const ip of lanIps) {
    console.log(`  https://${ip}:${defaultPort}/`);
  }
}
