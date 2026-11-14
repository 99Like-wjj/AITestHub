import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import mysql from 'mysql2/promise';

const secret = async (name) =>
  (await readFile(`/run/secrets/${name}`, 'utf8')).trim();
const password = await secret('target_api_auth_password');
const pgPassword = await secret('target_postgres_app_password');
const mysqlPassword = await secret('target_mysql_app_password');
const counts = new Map();
const tokens = new Set();
const count = (route) => counts.set(route, (counts.get(route) ?? 0) + 1);
async function mutate(driver, id, tenant, payload, deleting = false) {
  if (driver === 'postgresql') {
    const client = new pg.Client({
      host: 'target-postgres',
      database: 'aitesthub_target',
      user: 'ath_target_app',
      password: pgPassword,
    });
    try {
      await client.connect();
      if (deleting)
        await client.query(
          'DELETE FROM test_objects WHERE id=$1 AND tenant_id=$2',
          [id, tenant],
        );
      else
        await client.query(
          'INSERT INTO test_objects(id,tenant_id,payload) VALUES($1,$2,$3)',
          [id, tenant, payload],
        );
    } finally {
      await client.end();
    }
  } else {
    const client = await mysql.createConnection({
      host: 'target-mysql',
      database: 'aitesthub_target',
      user: 'ath_target_app',
      password: mysqlPassword,
    });
    try {
      if (deleting)
        await client.execute(
          'DELETE FROM test_objects WHERE id=? AND tenant_id=?',
          [id, tenant],
        );
      else
        await client.execute(
          'INSERT INTO test_objects(id,tenant_id,payload) VALUES(?,?,?)',
          [id, tenant, payload],
        );
    } finally {
      await client.end();
    }
  }
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://synthetic-api:8080');
  const route = url.pathname;
  count(route);
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    if (route === '/health') return send(200, { ready: true });
    if (route === '/stats')
      return send(200, { counts: Object.fromEntries(counts) });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) return send(413, { error: 'size' });
      chunks.push(chunk);
    }
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      return send(400, { error: 'json' });
    }
    if (route === '/auth/login') {
      if (body.username !== 'synthetic-user' || body.password !== password)
        return send(401, { error: 'credentials' });
      const token = `synthetic-auth-${randomUUID()}`;
      tokens.add(token);
      return send(200, { token });
    }
    if (route === '/private') {
      const token = String(req.headers.authorization ?? '').replace(
        /^Bearer /,
        '',
      );
      return tokens.has(token)
        ? send(200, { ok: true, echo: token, [token]: 'protected-key' })
        : send(401, { ok: false });
    }
    if (route === '/create') {
      const id = typeof body.id === 'string' ? body.id : randomUUID();
      const tenant =
        typeof body.tenant === 'string' ? body.tenant : 'synthetic';
      for (const driver of ['postgresql', 'mysql'])
        await mutate(driver, id, tenant, 'synthetic');
      return send(201, { id, tenant, created: true });
    }
    if (route === '/expected400') return send(400, { expected: true });
    if (route === '/business-failure') return send(200, { ok: false });
    if (route === '/redirect') {
      res.writeHead(302, { location: '/effect' });
      res.end();
      return;
    }
    if (route === '/slow') {
      await new Promise((resolve) =>
        setTimeout(resolve, Number(url.searchParams.get('ms') ?? 200)),
      );
      return send(200, { ok: true });
    }
    if (route === '/cleanup') {
      const id = body.id ?? url.searchParams.get('id');
      const tenant =
        body.tenant ?? url.searchParams.get('tenant') ?? 'synthetic';
      if (typeof id !== 'string' || !id)
        return send(400, { error: 'target-required' });
      for (const driver of ['postgresql', 'mysql'])
        await mutate(driver, id, tenant, '', true);
      return send(200, { ok: true, id });
    }
    if (route === '/effect')
      return send(200, { ok: true, id: body.id ?? url.searchParams.get('id') });
    return send(200, { ok: true });
  } catch {
    send(500, { error: 'synthetic-target-failure' });
  }
});
server.listen(8080, '0.0.0.0', () =>
  process.stdout.write('Synthetic target listening on 8080.\n'),
);
