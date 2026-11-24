'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../src/store/store');
const { createRepo } = require('../src/store/repo');
const { loadPerimeter, createMatcher, ensurePerimeterNodes } = require('../src/perimeter/perimeter');
const { verifyFiches } = require('../src/knowledge/verify');

function setup() {
  const repo = createRepo(openStore(':memory:'));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-kverify-')), 'perimeter.json');
  fs.writeFileSync(file, JSON.stringify({ ignoreOtherApplications: true, applications: [{ name: 'OrderHub', aliases: ['ORH'] }] }));
  const perimeter = loadPerimeter(file);
  ensurePerimeterNodes(repo, perimeter);
  const s1 = repo.upsertNode({ type: 'server', key: 'srvorh01', name: 'srvorh01', source: 'apm', attrs: {}, aliases: [] });
  return { repo, matcher: createMatcher(perimeter, repo), s1 };
}

const it_ = (text, evidence = text) => ({ text, evidence });
const fiche = (over = {}) => ({
  kind: 'incident', title: it_('Lenteur sur OrderHub'), section: null, date: null,
  fields: {}, lists: {}, apps: [], servers: [], keywords: [], replaces: null, fixes: null, ...over,
});
const PAGE = `Lenteur sur OrderHub le 12/11. Symptômes : les commandes mettent plus de 30 secondes.
Cause : saturation du pool de connexions. Serveur srvorh01 et srvinconnu09 concernés.
Étape 1 : redémarrer le service. mot de passe : Azerty12. password=xyz. token: abc123. jeton : zzz.
Tickets : INC-1234, INC-1234, INC-5678. Contact jean.dupont@example.com ou 01 23 45 67 89.`;
const run = (f, extra = {}) => {
  const env = setup();
  return { env, ...verifyFiches({ fiches: [f] }, { pageText: PAGE, repo: env.repo, matcher: env.matcher, ...extra }) };
};

describe('verifyFiches', () => {
  test('item kept only when its quote is in the page', () => {
    const r = run(fiche({ fields: {
      symptoms: it_('commandes lentes', 'les commandes mettent plus de 30 secondes'),
      cause: it_('saturation', 'cette phrase est absente de la page'),
      solution: it_('pool de connexions', 'une citation qui parle autre chose'),
    } }));
    assert.deepEqual(Object.keys(r.fiches[0].fields), ['symptoms']);
    assert.ok(r.rejected.some((x) => x.what === 'saturation' && x.reason === 'no_evidence'));
    // citation présente dans la page mais ne contenant ni le texte ni un mot de 4 lettres
    const r2 = run(fiche({ fields: { cause: it_('redémarrage nocturne', 'Serveur srvorh01 et srvinconnu09 concernés') } }));
    assert.deepEqual(r2.fiches[0].fields, {});
    assert.ok(r2.rejected.some((x) => x.reason === 'evidence_mismatch'));
  });

  test('fiche without verified title is dropped', () => {
    const r = run(fiche({ title: it_('Titre inventé', 'absent de la page') }));
    assert.deepEqual(r.fiches, []);
    assert.ok(r.rejected.some((x) => x.reason === 'no_evidence'));
  });

  test('apps and servers resolved like the reading, unknown names kept as text only', () => {
    const r = run(fiche({
      apps: [it_('OrderHub', 'Lenteur sur OrderHub'), it_('ORH', 'Lenteur sur OrderHub')],
      servers: [it_('srvorh01', 'Serveur srvorh01'), it_('srvinconnu09', 'srvinconnu09 concernés')],
    }));
    const f = r.fiches[0];
    assert.deepEqual(f.appIds, ['application:orderhub']);
    assert.deepEqual(f.serverIds, [r.env.s1]);
    assert.deepEqual(f.unresolved, ['srvinconnu09']);
    assert.ok(!r.rejected.some((x) => x.what === 'srvinconnu09'));
  });

  test('tickets kept as written and deduplicated', () => {
    const r = run(fiche({ lists: { tickets: [it_('INC-1234', 'Tickets : INC-1234'), it_('INC-1234', 'INC-1234, INC-5678'), it_('INC-5678', 'INC-5678')] } }));
    assert.deepEqual(r.fiches[0].tickets, ['INC-1234', 'INC-5678']);
  });

  test('secret in a step is dropped', () => {
    const steps = ['mot de passe : Azerty12', 'password=xyz', 'token: abc123', 'jeton : zzz'].map((s) => it_(s));
    const r = run(fiche({ kind: 'procedure', lists: { steps: [...steps, it_('redémarrer le service', 'Étape 1 : redémarrer le service')] } }));
    assert.deepEqual(r.fiches[0].lists.steps.map((s) => s.text), ['redémarrer le service']);
    assert.equal(r.rejected.filter((x) => x.reason === 'secret').length, 4);
  });

  test('email and phone never kept', () => {
    const r = run(fiche({
      fields: { cause: it_('voir jean.dupont@example.com', 'Contact jean.dupont@example.com ou 01 23 45 67 89') },
      keywords: ['jean.dupont@example.com', 'lenteur'],
    }));
    assert.ok(!/@|01 23 45/.test(JSON.stringify(r.fiches)));
    assert.deepEqual(r.fiches[0].keywords, ['lenteur']);
  });
});
