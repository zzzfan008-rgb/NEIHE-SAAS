import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Do not print resolved Compose config: it can contain private credentials.
const result = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
  encoding: 'utf8',
  env: { ...process.env, POSTGRES_PASSWORD: 'deployment-contract-test-only' },
});
assert.equal(result.status, 0, 'Compose configuration must validate');
const config = JSON.parse(result.stdout);
const { app, postgres, proxy } = config.services;
assert.equal(app.ports?.length, 1, 'App must publish exactly one localhost-only port');
assert.equal(app.ports[0].host_ip, '127.0.0.1');
assert.equal(String(app.ports[0].published), '3002');
assert.equal(app.ports[0].target, 3002);
assert.equal(postgres.ports?.length ?? 0, 0, 'Database must not publish host ports');
assert.equal(proxy.ports.length, 1);
assert.equal(proxy.ports[0].host_ip, '192.168.0.92');
assert.equal(String(proxy.ports[0].published), '80');
assert.equal(proxy.ports[0].target, 80);
assert.equal(proxy.depends_on.app.condition, 'service_healthy');
assert.equal(app.depends_on.postgres.condition, 'service_healthy');
assert.ok(app.volumes.some(v => v.type === 'bind' && v.target === '/app/data'));
assert.ok(postgres.volumes.some(v => v.source === 'postgres_data'));
const nginx = readFileSync(new URL('../deploy/nginx.conf', import.meta.url), 'utf8');
assert.match(nginx, /proxy_pass \$app_upstream;/);
assert.match(nginx, /set \$app_upstream http:\/\/app:3002;/);
assert.match(nginx, /proxy_buffering off;/);
assert.match(nginx, /client_max_body_size 50m;/);
const ignored = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
assert.match(ignored, /^data\/$/m, 'Business files must not enter the build context');
console.log('Deployment contract passed: app is localhost-only on 3002; proxy is LAN-only on 192.168.0.92:80.');
