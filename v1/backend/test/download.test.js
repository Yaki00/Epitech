'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const { downloadIfNeeded, downloadSettings, checkCsv, localDay } = require('../src/fetch/download');
const { resolveInputFile } = require('../src/ingest/inventory');

const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers, buffer: async () => Buffer.from(body) });
const CSV1 = 'Hostname;IP;Application\nsrv1;10.0.0.1;OrderHub\n';
const CSV2 = 'Hostname;IP;Application\nsrv1;10.0.0.1;OrderHub\nsrv2;10.0.0.2;OrderHub\n';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-dl-'));
  return { dir, target: path.join(dir, 'marketplace', 'servers.csv') };
}

describe('téléchargement de la marketplace', () => {
  const day1 = new Date(2026, 10, 18, 8, 0);
  const day1Later = new Date(2026, 10, 18, 15, 0);
  const day2 = new Date(2026, 10, 19, 8, 0);

  test('nouveau, puis rien le même jour, puis identique, puis remplacé si différent', async () => {
    const { target } = setup();
    let body = CSV1;
    let calls = 0;
    const fetch = async () => {
      calls++;
      return res(200, body, { 'content-type': 'text/csv' });
    };
    assert.equal((await downloadIfNeeded({ url: 'https://x.example.local/export', target, fetch, now: day1 })).status, 'nouveau');
    assert.equal(fs.readFileSync(target, 'utf8'), CSV1);

    assert.equal((await downloadIfNeeded({ url: 'u', target, fetch, now: day1Later })).status, "déjà vérifié aujourd'hui");
    assert.equal(calls, 1);

    assert.equal((await downloadIfNeeded({ url: 'u', target, fetch, now: day2 })).status, 'identique');
    body = CSV2;
    assert.equal((await downloadIfNeeded({ url: 'u', target, fetch, now: day2, force: true })).status, 'remplacé');
    assert.equal(fs.readFileSync(target, 'utf8'), CSV2);
    const state = JSON.parse(fs.readFileSync(`${target}.telechargement.json`, 'utf8'));
    assert.equal(state.checkedDay, localDay(day2));
    assert.ok(!JSON.stringify(state).includes('x.example.local')); // jamais l'URL dans l'état
  });

  test('page de connexion, xlsx ou fichier vide : erreur et ancien fichier gardé', async () => {
    const { target } = setup();
    await downloadIfNeeded({ url: 'u', target, fetch: async () => res(200, CSV1), now: day1 });
    for (const [body, type, msg] of [
      ['<!DOCTYPE html><html>Connexion</html>', 'text/html', /page HTML/],
      ['PK\u0003\u0004xlsx', 'application/octet-stream', /xlsx/],
      ['', 'text/csv', /vide/],
    ]) {
      await assert.rejects(() => downloadIfNeeded({ url: 'u', target, fetch: async () => res(200, body, { 'content-type': type }), now: day2 }), msg);
      assert.equal(fs.readFileSync(target, 'utf8'), CSV1);
    }
  });

  test('redirection suivie, accès refusé expliqué, authentification envoyée', async () => {
    const { target } = setup();
    const seen = [];
    const fetch = async (url, opts) => {
      seen.push([url, opts.headers.Authorization, opts.headers.Cookie]);
      return url.includes('stockage') ? res(200, CSV1) : res(302, '', { location: 'https://stockage.example.local/f.csv' });
    };
    await downloadIfNeeded({ url: 'https://lien.example.local/dl', target, fetch, auth: { token: 'tok', cookie: 'JSESSIONID=1' }, now: day1 });
    assert.deepEqual(seen[1], ['https://stockage.example.local/f.csv', 'Bearer tok', 'JSESSIONID=1']);
    await assert.rejects(() => downloadIfNeeded({ url: 'u', target, fetch: async () => res(401, ''), force: true }), /accès refusé/);
  });

  test('réglages lus depuis le .env avec un préfixe', () => {
    const s = downloadSettings('MARKETPLACE', { MARKETPLACE_URL: ' https://l/x ', MARKETPLACE_USER: 'moi', MARKETPLACE_PASSWORD: 'p' });
    assert.deepEqual(s, { url: 'https://l/x', token: '', user: 'moi', password: 'p', cookie: '' });
  });

  test('contrôle du contenu CSV', () => {
    assert.equal(checkCsv(Buffer.from('﻿a;b\n1;2')), null);
    assert.match(checkCsv(Buffer.from('bonjour\nla suite')), /séparateur/);
  });
});

describe('fichier le plus récent', () => {
  test('un fichier téléchargé sans date dans le nom passe devant un export daté plus ancien', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-recent-'));
    fs.writeFileSync(path.join(dir, 'apm_20200101.csv'), 'a;b');
    fs.writeFileSync(path.join(dir, 'apm.csv'), 'a;b');
    assert.equal(path.basename(resolveInputFile(dir, './*.csv')), 'apm.csv');
    fs.writeFileSync(path.join(dir, 'apm_20991231.csv'), 'a;b');
    assert.equal(path.basename(resolveInputFile(dir, './*.csv')), 'apm_20991231.csv');
  });
});
