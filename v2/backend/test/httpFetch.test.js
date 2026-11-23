'use strict';
const assert = require('assert').strict;
const http = require('http');
const { httpFetch } = require('../src/lib/httpFetch');

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) }));
  });
}

describe('httpFetch (client HTTP sans fetch, Node 16)', () => {
  test('POST JSON, accents, statut et corps', async () => {
    const s = await server((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.statusCode = 201;
        res.end(JSON.stringify({ echo: JSON.parse(b), auth: req.headers.authorization }));
      });
    });
    try {
      const r = await httpFetch(`${s.url}/x`, { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'éà' }) });
      assert.equal(r.ok, true);
      assert.equal(r.status, 201);
      assert.deepEqual(await r.json(), { echo: { a: 'éà' }, auth: 'Bearer t' });
    } finally {
      await s.close();
    }
  });
  test('code 503 : ok = false, pas d\'exception', async () => {
    const s = await server((req, res) => {
      res.statusCode = 503;
      res.end('busy');
    });
    try {
      const r = await httpFetch(s.url);
      assert.equal(r.ok, false);
      assert.equal(await r.text(), 'busy');
    } finally {
      await s.close();
    }
  });
  test('timeout et annulation -> AbortError', async () => {
    const s = await server(() => {}); // ne répond jamais
    try {
      await assert.rejects(httpFetch(s.url, { timeoutMs: 50 }), (e) => e.name === 'AbortError' && /Timeout/.test(e.message));
      const ctrl = new AbortController();
      const p = httpFetch(s.url, { signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 20);
      await assert.rejects(p, (e) => e.name === 'AbortError');
    } finally {
      await s.close();
    }
  });
  test('serveur injoignable : erreur réseau', async () => {
    await assert.rejects(httpFetch('http://127.0.0.1:1/x', { timeoutMs: 2000 }));
  });
});
