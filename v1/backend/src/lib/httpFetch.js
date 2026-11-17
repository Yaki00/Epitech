'use strict';
/**
 * Équivalent minimal de fetch() pour Node 16 (pas de fetch global avant Node 18).
 * Seul client HTTP sortant du projet : utilisé par llmClient, mcpClient et doctor.
 *
 *   const res = await httpFetch(url, { method, headers, body, signal, timeoutMs });
 *   res.ok, res.status, await res.text(), await res.json()
 *
 * - http et https selon l'URL
 * - timeout (timeoutMs) et annulation (signal d'un AbortController) -> erreur nommée AbortError
 * - certificat d'entreprise : Node lit la variable système NODE_EXTRA_CA_CERTS, rien à coder ici
 */
const http = require('http');
const https = require('https');

function abortError(message) {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function httpFetch(url, { method = 'GET', headers = {}, body, signal, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(new Error(`URL invalide : ${url}`));
      return;
    }
    if (signal && signal.aborted) {
      reject(abortError('Requête annulée'));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined || body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const finalHeaders = { ...headers };
    if (data) finalHeaders['Content-Length'] = data.length;

    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    const req = lib.request(u, { method, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (err) => done(reject, err));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        done(resolve, {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });

    function onAbort() {
      req.destroy();
      done(reject, abortError('Requête annulée'));
    }
    if (signal) signal.addEventListener('abort', onAbort);
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        done(reject, abortError(`Timeout après ${timeoutMs} ms`));
      });
    }
    req.on('error', (err) => done(reject, err));
    if (data) req.write(data);
    req.end();
  });
}

module.exports = { httpFetch };
