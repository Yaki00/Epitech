'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConfluenceApi } = require('../src/fetch/confluenceApi');
const { fetchSpaces, safeName, readState } = require('../src/fetch/confluenceFetcher');
const { readExportPages, analyseEntry, loadDiagrams } = require('../src/ingest/confluenceExport');

const silent = { info() {}, warn() {}, error() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-fetch-'));

/** Faux Confluence en mémoire : pages par espace, pièces jointes, compteur d'appels. */
function fakeConfluence() {
  const db = {
    DEMO: [
      { id: '10', title: 'OrderHub', version: 1, view: '<p>Accueil OrderHub</p>', ancestors: [] },
      {
        id: '11',
        title: 'OrderHub - Architecture',
        version: 3,
        view: '<p>Serveurs</p><img src="/download/attachments/11/schema%20prod.png?version=1" data-image-src="/download/attachments/11/schema%20prod.png"/>',
        storage: '<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">archi-ohb</ac:parameter></ac:structured-macro>',
        ancestors: [{ id: '10', title: 'OrderHub' }],
        attachments: [
          { id: 'a1', title: 'schema prod.png', mediaType: 'image/png', data: 'PNG' },
          { id: 'a2', title: 'archi-ohb', mediaType: 'application/vnd.jgraph.mxfile', data: '<mxfile><diagram name="p"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>' },
          { id: 'a3', title: 'contrat.pdf', mediaType: 'application/pdf', data: 'PDF' },
        ],
      },
    ],
  };
  const calls = { getPage: 0, download: 0 };
  const find = (id) => Object.values(db).flat().find((p) => p.id === id);
  const api = {
    absolute: (p) => `https://wiki.example.local${p}`,
    listPages: async (space) => (db[space] || []).map((p) => ({ id: p.id, title: p.title, version: { number: p.version } })),
    getPage: async (id) => {
      calls.getPage++;
      const p = find(id);
      const space = Object.keys(db).find((k) => db[k].includes(p));
      return {
        id: p.id,
        title: p.title,
        status: 'current',
        space: { key: space },
        version: { number: p.version, when: '2026-11-01T10:00:00.000+01:00' },
        ancestors: p.ancestors,
        metadata: { labels: { results: [{ name: 'archi' }] } },
        body: { view: { value: p.view }, storage: { value: p.storage || '' } },
        _links: { webui: `/spaces/${space}/pages/${p.id}` },
      };
    },
    listAttachments: async (id) =>
      (find(id).attachments || []).map((a) => ({ id: a.id, title: a.title, metadata: { mediaType: a.mediaType }, extensions: { fileSize: a.data.length }, version: { number: 1 }, _links: { download: `/download/${a.id}` } })),
    download: async (link) => {
      calls.download++;
      const a = Object.values(db).flat().flatMap((p) => p.attachments || []).find((x) => link.endsWith(x.id));
      return Buffer.from(a.data);
    },
  };
  return { db, api, calls };
}

describe('récupération Confluence', () => {
  test('noms de dossiers valables sous Windows', () => {
    assert.equal(safeName('Archi: prod/recette <v2>?'), 'Archi_ prod_recette _v2__');
    assert.equal(safeName('Fin avec point. '), 'Fin avec point');
    assert.equal(safeName(''), '_');
  });

  test('premier passage : pages, images et schémas au format lu par Lyra', async () => {
    const root = tmpDir();
    const { api } = fakeConfluence();
    const { stats } = await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent });
    assert.equal(stats.fetched, 2);
    assert.equal(stats.attachments, 2); // le PDF n'est pas téléchargé

    const dir = path.join(root, 'DEMO', '11 - OrderHub - Architecture');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
    assert.equal(meta.parentId, '10');
    assert.equal(meta.url, 'https://wiki.example.local/spaces/DEMO/pages/11');
    assert.deepEqual(meta.attachments.map((a) => a.file).sort(), ['attachments/archi-ohb', 'images/schema prod.png']);
    assert.equal(fs.readFileSync(path.join(dir, 'images', 'schema prod.png'), 'utf8'), 'PNG');

    // Lyra relit l'export tel quel, schéma draw.io compris
    const entries = [...readExportPages(root)].filter((e) => e.p);
    assert.equal(entries.length, 2);
    const archi = entries.find((e) => e.p.id === '11');
    assert.deepEqual(archi.p.ancestors, ['OrderHub']);
    assert.equal(archi.p.version, 3);
    const page = analyseEntry(archi);
    const diagrams = loadDiagrams(root, archi, page);
    assert.equal(diagrams.results.length, 1);
    assert.deepEqual(diagrams.missing, []);
  });

  test('passage suivant : seulement les pages modifiées ; titre changé, page supprimée', async () => {
    const root = tmpDir();
    const { db, api, calls } = fakeConfluence();
    await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent });
    calls.getPage = 0;

    let r = await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent });
    assert.equal(r.stats.fetched, 0);
    assert.equal(r.stats.unchanged, 2);
    assert.equal(calls.getPage, 0);

    db.DEMO[1].title = 'OrderHub - Architecture v2';
    db.DEMO[1].version = 4;
    db.DEMO.splice(0, 1); // page 10 supprimée
    r = await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent });
    assert.deepEqual([r.stats.fetched, r.stats.renamed, r.stats.deleted], [1, 1, 1]);
    // copie : un tableau venu de fs n'a pas le même prototype que ceux de jest (comparaison stricte)
    assert.deepEqual([...fs.readdirSync(path.join(root, 'DEMO'))], ['11 - OrderHub - Architecture v2']);
    assert.deepEqual(Object.keys(readState(root).pages), ['11']);
  });

  test('espace vide ou en erreur : rien n\'est supprimé', async () => {
    const root = tmpDir();
    const { db, api } = fakeConfluence();
    await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent });
    const saved = db.DEMO.splice(0);
    let r = await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent });
    assert.equal(r.stats.deleted, 0);
    db.DEMO.push(...saved);
    api.listPages = async () => {
      throw new Error('HTTP 500');
    };
    r = await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent });
    assert.equal(r.stats.deleted, 0);
    assert.equal(r.errors.length, 1);
    assert.equal(fs.readdirSync(path.join(root, 'DEMO')).length, 2);
  });

  test('--limit et --dry-run ne suppriment rien et n\'écrivent rien de trop', async () => {
    const root = tmpDir();
    const { api } = fakeConfluence();
    let r = await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent, options: { dryRun: true } });
    assert.equal(r.stats.fetched, 2);
    assert.ok(!fs.existsSync(path.join(root, 'DEMO')));
    r = await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent, options: { limit: 1 } });
    assert.equal(r.stats.fetched, 1);
  });

  test('page en erreur : les autres continuent, elle sera reprise au passage suivant', async () => {
    const root = tmpDir();
    const { api } = fakeConfluence();
    const real = api.getPage;
    api.getPage = async (id) => {
      if (id === '10') throw new Error('HTTP 500');
      return real(id);
    };
    let r = await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent });
    assert.deepEqual([r.stats.fetched, r.stats.errors], [1, 1]);
    api.getPage = real;
    r = await fetchSpaces({ api, root, spaces: ['DEMO'], logger: silent });
    assert.equal(r.stats.fetched, 1);
  });
});

describe('client API Confluence', () => {
  const res = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    buffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  });

  test('jeton Bearer, pagination, chemin de contexte', async () => {
    const urls = [];
    const fetch = async (url, opts) => {
      urls.push(url);
      assert.equal(opts.headers.Authorization, 'Bearer abc');
      const start = Number(new URL(url).searchParams.get('start'));
      return start === 0 ? res(200, { results: [{ id: '1' }, { id: '2' }], _links: { next: '/x' } }) : res(200, { results: [{ id: '3' }], _links: {} });
    };
    const api = createConfluenceApi({ baseUrl: 'https://wiki.example.local/wiki/', token: 'abc' }, { fetch, logger: silent });
    const pages = await api.listPages('DEMO');
    assert.deepEqual(pages.map((p) => p.id), ['1', '2', '3']);
    assert.match(urls[0], /^https:\/\/wiki\.example\.local\/wiki\/rest\/api\/space\/DEMO\/content\/page\?expand=version&limit=200&start=0$/);
    assert.equal(api.absolute('/wiki/download/attachments/1/a.png'), 'https://wiki.example.local/wiki/download/attachments/1/a.png');
    assert.equal(api.absolute('/download/attachments/1/a.png'), 'https://wiki.example.local/wiki/download/attachments/1/a.png');
  });

  test('identifiant + mot de passe en Basic', async () => {
    const fetch = async (url, opts) => {
      assert.equal(opts.headers.Authorization, `Basic ${Buffer.from('moi:secret').toString('base64')}`);
      return res(200, { id: '1' });
    };
    await createConfluenceApi({ baseUrl: 'https://w.example.local', user: 'moi', password: 'secret' }, { fetch }).getPage('1');
  });

  test('429 puis succès, redirection suivie', async () => {
    let n = 0;
    const fetch = async (url) => {
      n++;
      if (n === 1) return res(429, '', { 'retry-after': '0' });
      if (n === 2) return res(302, '', { location: 'https://cdn.example.local/fichier' });
      assert.equal(url, 'https://cdn.example.local/fichier');
      return res(200, 'DATA');
    };
    const api = createConfluenceApi({ baseUrl: 'https://w.example.local', token: 't' }, { fetch, logger: silent, backoffBaseMs: 1 });
    assert.equal((await api.download('/download/x')).toString(), 'DATA');
  });

  test('messages clairs : accès refusé, page de connexion HTML', async () => {
    const api401 = createConfluenceApi({ baseUrl: 'https://w.example.local', token: 't' }, { fetch: async () => res(401, '') });
    await assert.rejects(() => api401.getPage('1'), /CONFLUENCE_TOKEN/);
    const apiHtml = createConfluenceApi({ baseUrl: 'https://w.example.local', token: 't' }, { fetch: async () => res(200, '<html>Login</html>') });
    await assert.rejects(() => apiHtml.getPage('1'), /page de connexion/);
    assert.throws(() => createConfluenceApi({ baseUrl: '' }), /CONFLUENCE_BASE_URL/);
  });
});
