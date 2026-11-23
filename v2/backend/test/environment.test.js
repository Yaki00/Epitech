'use strict';
const assert = require('assert').strict;
const { normalizeEnv, serverEnv, appCriticality } = require('../src/lib/environment');

describe('environnement', () => {
  test('normalizeEnv : PRD, STG, DEV ou null', () => {
    for (const v of ['prd', 'PROD', 'Production']) assert.equal(normalizeEnv(v), 'PRD');
    for (const v of ['stg', 'staging', 'preprod', 'Pré-production']) assert.equal(normalizeEnv(v), 'STG');
    for (const v of ['dev', 'Development']) assert.equal(normalizeEnv(v), 'DEV');
    for (const v of ['', 'recette', undefined]) assert.equal(normalizeEnv(v), null);
  });
  test('serverEnv : environment prime sur usedFor, pas de déduction depuis le nom', () => {
    assert.equal(serverEnv({ attrs: { usedFor: 'stg' } }), 'STG');
    assert.equal(serverEnv({ attrs: { environment: 'dev', usedFor: 'stg' } }), 'DEV');
    assert.equal(serverEnv({ name: 'srvprd01', attrs: {} }), null);
  });
  test('appCriticality : criticality puis confidentiality', () => {
    assert.equal(appCriticality({ attrs: { confidentiality: 'C2' } }), 'C2');
    assert.equal(appCriticality({ attrs: { criticality: 'High', confidentiality: 'C2' } }), 'High');
    assert.equal(appCriticality({ attrs: {} }), null);
  });
});
