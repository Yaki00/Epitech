'use strict';
/**
 * Jeu de démonstration : un graphe entièrement inventé, mais construit avec les mêmes formes que les vraies
 * données (serveurs et runs_on comme l'inventaire APM, pages et documented_in comme Confluence, résumés comme
 * enrich/summary). Rien n'est lu ni appelé sur le réseau. Déterministe pour une graine et une date données.
 *
 * Les 3 imports d'historique passent par createHistory().recordImport puis applyRetirements, comme une vraie synchro.
 */
const path = require('path');
const { nodeKey } = require('../store/repo');
const { ensurePerimeterNodes, createMatcher } = require('../perimeter/perimeter');
const { verdictFr } = require('../perimeter/architecture');
const { serverEnv } = require('../lib/environment');
const { readJson, writeJsonAtomic } = require('../store/store');
const { applyFiches, linkFiches } = require('../knowledge/apply');

const DAY = 86400000;
const SOURCE = 'apm';
const WIKI = 'https://wiki.example.local/pages';

/** PRNG maison (mulberry32) : même graine, même suite. */
function createRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.pick = (list) => list[Math.floor(next() * list.length)];
  next.int = (min, max) => min + Math.floor(next() * (max - min + 1));
  return next;
}

// Applications du périmètre : sigle, criticité, serveurs par environnement, base de données, résumé.
const APPS = [
  { sigle: 'ATP', name: 'Atlas Paiements', crit: 'Critique', profile: 'Métier', n: [4, 2, 1], db: 'Base Paiements', summary: 'Encaissement et rapprochement des paiements clients, avec détection des impayés.', en: 'Customer payment collection and reconciliation, with unpaid invoice detection.' },
  { sigle: 'ORC', name: 'Orion Clients', crit: 'Critique', profile: 'Métier', n: [3, 2, 1], db: 'Base Clients', summary: 'Référentiel des clients et de leurs contrats, source unique pour les autres applications.', en: 'Customer and contract master data, single source for the other applications.' },
  { sigle: 'VGF', name: 'Vega Facturation', crit: 'Haute', profile: 'Métier', n: [3, 1, 1], db: 'Base Comptable', summary: 'Émission des factures et des avoirs, calcul des taxes et envoi aux clients.', en: 'Invoice and credit note issuing, tax calculation and delivery to customers.' },
  { sigle: 'HLC', name: 'Helios Commandes', crit: 'Critique', profile: 'Métier', n: [4, 2, 1], db: 'Base Commandes', summary: 'Prise de commande, suivi des statuts et orchestration des livraisons.', en: 'Order capture, status tracking and delivery orchestration.' },
  { sigle: 'NVC', name: 'Nova Catalogue', crit: 'Haute', profile: 'Métier', n: [3, 2, 1], db: 'Base Catalogue', summary: 'Catalogue produits, tarifs et disponibilités publié vers les canaux de vente.', en: 'Product catalog, prices and availability published to sales channels.' },
  { sigle: 'SRS', name: 'Sirius Stocks', crit: 'Haute', profile: 'Métier', n: [2, 1, 1], db: 'Base Stocks', summary: 'Gestion des stocks par entrepôt et réservations pour les commandes.', en: 'Stock management per warehouse and reservations for orders.' },
  { sigle: 'LXL', name: 'Lynx Logistique', crit: 'Moyenne', profile: 'Métier', n: [3, 1, 1], db: 'Base Stocks', summary: null },
  { sigle: 'CRH', name: 'Cassiopée RH', crit: 'Moyenne', profile: 'Support', n: [2, 1, 1], db: 'Base RH', summary: 'Gestion des dossiers du personnel, des congés et des campagnes d\'entretiens.', en: 'Staff records, leave and review campaign management.' },
  { sigle: 'PGR', name: 'Pégase Reporting', crit: 'Moyenne', profile: 'Décisionnel', n: [2, 1, 1], db: 'Entrepôt Décisionnel', summary: null },
  { sigle: 'TTP', name: 'Titan Passerelle', crit: 'Critique', profile: 'Socle', n: [3, 2, 1], db: null, summary: null },
  { sigle: 'ZPN', name: 'Zéphyr Notifications', crit: 'Basse', profile: 'Socle', n: [2, 1, 1], db: null, summary: null },
  { sigle: 'ALC', name: 'Altaïr Comptabilité', crit: 'Haute', profile: 'Métier', n: [3, 1, 1], db: 'Base Comptable', summary: 'Écritures comptables, clôtures mensuelles et états réglementaires.', en: 'Accounting entries, monthly closings and statutory reports.' },
];
// Applications hors périmètre : présentes dans l'inventaire, jamais analysées.
const OUT = [
  { sigle: 'BIN', name: 'Borealis Intranet', crit: 'Basse', profile: 'Support', n: [2, 1, 0] },
  { sigle: 'MAR', name: 'Mistral Archivage', crit: 'Moyenne', profile: 'Support', n: [2, 1, 0] },
  { sigle: 'PBD', name: 'Polaris Badgeuse', crit: 'Moyenne', profile: 'Support', n: [2, 1, 0] },
  { sigle: 'QVL', name: 'Quasar Veille', crit: 'Basse', profile: 'Décisionnel', n: [2, 1, 0] },
];
const ENV_ORDER = ['PRD', 'STG', 'DEV'];

// flux : le premier appelle (dépend de) le second
const CALLS = [
  ['TTP', 'HLC'], ['TTP', 'ORC'], ['HLC', 'ATP'], ['HLC', 'SRS'], ['HLC', 'NVC'], ['ATP', 'VGF'], ['ATP', 'ZPN'],
  ['VGF', 'ALC'], ['ORC', 'ZPN'], ['LXL', 'SRS'], ['PGR', 'ATP'], ['PGR', 'VGF'], ['CRH', 'ALC'], ['CRH', 'PBD'],
];
const DB_ENGINES = { 'Base Paiements': 'PostgreSQL 15', 'Base Clients': 'PostgreSQL 15', 'Base Comptable': 'Oracle 19c', 'Base Commandes': 'PostgreSQL 14', 'Base Catalogue': 'MongoDB 6', 'Base Stocks': 'PostgreSQL 14', 'Base RH': 'SQL Server 2019', 'Entrepôt Décisionnel': 'Oracle 19c' };

// vie des serveurs : import de départ et de fin (3 = encore présent), changements d'attributs à partir d'un import
const LIFE = {
  'srv-hlc-prd5': { from: 1, to: 2 },
  'srv-nvc-stg3': { from: 1, to: 1 },
  'srv-vgf-prd4': { from: 2 },
  'srv-orc-stg3': { from: 2 },
  'srv-atp-prd5': { from: 3 },
  'srv-ttp-prd4': { from: 3 },
};
const CHANGES = {
  'srv-atp-prd1': [{ at: 2, attr: 'ram', before: '32 Go' }],
  'srv-nvc-prd1': [{ at: 2, attr: 'cpuCores', before: '4' }],
  'srv-hlc-prd2': [{ at: 3, attr: 'osVersion', before: '8.8' }],
};
const EXTRA = [
  // serveurs ajoutés / retirés au fil des imports, en plus des effectifs de la table APPS
  { app: 'HLC', env: 'PRD', n: 5 },
  { app: 'NVC', env: 'STG', n: 3 },
  { app: 'VGF', env: 'PRD', n: 4 },
  { app: 'ORC', env: 'STG', n: 3 },
  { app: 'ATP', env: 'PRD', n: 5 },
  { app: 'TTP', env: 'PRD', n: 4 },
  // serveurs sans environnement dans l'inventaire (zone « Non précisé »)
  { app: 'ATP', env: null, n: 1, name: 'srv-atp-util1' },
  { app: 'ORC', env: null, n: 1, name: 'srv-orc-util1' },
];

const OS_CHOICES = [
  { os: 'Red Hat Enterprise Linux', osVersion: '8.9' },
  { os: 'Red Hat Enterprise Linux', osVersion: '9.3' },
  { os: 'Ubuntu', osVersion: '22.04 LTS' },
  { os: 'SUSE Linux Enterprise', osVersion: '15 SP5' },
  { os: 'Windows Server', osVersion: '2019' },
  { os: 'Windows Server', osVersion: '2022' },
];
const CPUS = ['Intel Xeon Gold 6338', 'Intel Xeon Silver 4314', 'AMD EPYC 7543', 'AMD EPYC 7313'];
const RAMS = ['8 Go', '16 Go', '32 Go', '64 Go', '128 Go'];
const CORES = ['4', '8', '16', '32'];

// Documentation par application : pages d'architecture (env, écart éventuel) et autres pages.
// gap : 'missing' (serveur absent de la page), 'unknown' (hôte inconnu des inventaires), 'ip' (IP différente), 'old' (page ancienne)
const DOCS = {
  ATP: { archi: [{ env: 'PRD' }, { env: 'STG' }], other: ['Guide d\'exploitation', 'Procédure de sauvegarde'] },
  ORC: { archi: [{ env: 'PRD' }, { env: 'STG' }], other: ['Guide d\'exploitation'] },
  VGF: { archi: [{ env: 'PRD' }], other: ['Guide d\'exploitation', 'Notes de version'] },
  HLC: { archi: [{ env: 'PRD', gap: ['missing', 'unknown'] }, { env: 'STG' }], other: ['Guide d\'exploitation'] },
  NVC: { archi: [{ env: 'PRD' }, { env: 'STG' }], other: ['Dossier d\'architecture technique'] },
  SRS: { archi: [{ env: 'PRD', gap: ['missing', 'old'] }], other: ['Plan de reprise d\'activité'] },
  LXL: { archi: [], other: ['Note de cadrage', 'Procédure d\'exploitation'], cites: { 'Procédure d\'exploitation': 2 } },
  CRH: { archi: [], other: ['Page d\'accueil'], cites: { 'Page d\'accueil': 1 } },
  PGR: { archi: [{ env: 'PRD', gap: ['missing'] }], other: ['Cahier des charges'] },
  TTP: { archi: [{ env: 'PRD', gap: ['ip'] }], other: ['Contrats d\'interface API'] },
  ZPN: { archi: [{ env: 'PRD' }], other: ['Catalogue des modèles de messages'] },
  ALC: { archi: [{ env: 'PRD' }], other: ['Guide de clôture mensuelle'] },
};

// Responsables lus dans les pages (noms inventés) : { sigle: [[nom, nature, rôle, période]] }.
// ZPN n'a que les colonnes APM (owner, supportTeam), sans page : cas « personne sans nœud ».
const OWNERS = {
  ATP: [['Claire Vasseur', 'person', 'owner'], ['Mehdi Lambert', 'person', 'support'], ['Équipe Finance', 'team', 'support'], ['Astreinte Socle', 'team', 'oncall']],
  ORC: [['Julien Marchetti', 'person', 'owner'], ['Sofia Delorme', 'person', 'support'], ['Équipe Relation Client', 'team', 'support']],
  VGF: [['Nadia Fontaine', 'person', 'owner'], ['Équipe Finance', 'team', 'support']],
  HLC: [['Thomas Kessler', 'person', 'owner'], ['Inès Bourdin', 'person', 'support'], ['Paul Garnier', 'person', 'other'], ['Équipe Supply', 'team', 'support']],
  NVC: [['Sofia Delorme', 'person', 'owner'], ['Équipe Relation Client', 'team', 'support']],
  SRS: [['Marc Aubert', 'person', 'owner'], ['Hugo Rinaldi', 'person', 'owner', 'past'], ['Équipe Supply', 'team', 'support']],
  LXL: [['Marc Aubert', 'person', 'owner'], ['Équipe Supply', 'team', 'support']],
  CRH: [['Lucie Perrot', 'person', 'owner'], ['Équipe Données', 'team', 'support']],
  PGR: [['Karim Besson', 'person', 'owner'], ['Lucie Perrot', 'person', 'support'], ['Équipe Données', 'team', 'support']],
  TTP: [['Thomas Kessler', 'person', 'owner'], ['Anaïs Mercier', 'person', 'oncall'], ['Équipe Socle', 'team', 'support'], ['Astreinte Socle', 'team', 'oncall']],
  ALC: [['Nadia Fontaine', 'person', 'owner'], ['Mehdi Lambert', 'person', 'support'], ['Équipe Finance', 'team', 'support']],
};
const APM_OWNERS = { ZPN: { owner: 'Élodie Marchand', supportTeam: 'Équipe Notifications' } };
const OOI_SERVER = { name: 'srv-vgf-prd9', ip: '10.13.0.99', app: 'VGF' };

const fmtLocal = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const slug = (s) => String(s).toLowerCase();

/** Définition du périmètre en mémoire (même forme que loadPerimeter). */
function buildDemoPerimeter() {
  return {
    applications: APPS.map((a, i) => ({ name: a.name, aliases: [a.sigle], auid: `AUID-${String(101 + i)}`, naemonHostgroups: [] })),
    ignoreOtherApplications: true,
    hash: 'demo',
  };
}

/** Liste de tous les serveurs prévus (y compris ajoutés et retirés), dans un ordre fixe. */
function planServers(rng) {
  const out = [];
  const all = [...APPS.map((a) => ({ ...a, inScope: true })), ...OUT.map((a) => ({ ...a, inScope: false }))];
  let appIdx = 0;
  for (const a of all) {
    appIdx++;
    ENV_ORDER.forEach((env, ei) => {
      for (let i = 1; i <= a.n[ei]; i++) out.push({ app: a, env, name: `srv-${slug(a.sigle)}-${env.toLowerCase()}${i}`, appIdx, ei, i });
    });
    for (const x of EXTRA.filter((e) => e.app === a.sigle)) {
      const name = x.name || `srv-${slug(a.sigle)}-${x.env.toLowerCase()}${x.n}`;
      out.push({ app: a, env: x.env, name, appIdx, ei: x.env ? ENV_ORDER.indexOf(x.env) : 3, i: x.n });
    }
  }
  return out.map((s, idx) => {
    const osc = rng.pick(OS_CHOICES);
    const ramIdx = s.env === 'PRD' ? rng.int(2, 4) : s.env === null ? 1 : rng.int(0, 2);
    const life = LIFE[s.name] || {};
    const attrs = {
      osHost: s.name,
      fqdn: `${s.name}.demo.example.local`,
      ip: `10.${10 + s.appIdx}.${s.ei}.${10 + s.i}`,
      provisioner: rng.pick(['Équipe Socle', 'Hébergeur interne']),
      os: osc.os,
      osVersion: osc.osVersion,
      country: 'FR',
      ram: RAMS[ramIdx],
      cpu: rng.pick(CPUS),
      cpuCores: CORES[Math.min(3, Math.max(0, ramIdx - 1 + rng.int(0, 1)))],
    };
    if (s.env) attrs.environment = s.env;
    if (s.name === 'srv-atp-prd1') attrs.ram = '64 Go';
    if (s.name === 'srv-nvc-prd1') attrs.cpuCores = '8';
    if (s.name === 'srv-hlc-prd2') {
      attrs.os = 'Red Hat Enterprise Linux';
      attrs.osVersion = '8.9';
    }
    return { ...s, attrs, from: life.from || 1, to: life.to || 3, row: idx + 2 };
  });
}

/** Attributs suivis d'un serveur tels que l'inventaire les donnait à l'import k. */
function attrsAt(s, k) {
  const a = { ...s.attrs };
  for (const c of CHANGES[s.name] || []) if (k < c.at) a[c.attr] = c.before;
  return a;
}

function generateDemo(repo, history, { seed = 42, now = Date.now(), dir = null } = {}) {
  const rng = createRng(seed);
  const perimeter = buildDemoPerimeter();
  const servers = planServers(rng);
  const appId = (sigle) => `application:${[...APPS, ...OUT].find((a) => a.sigle === sigle).name.toLowerCase().replace(/\s+/g, '-')}`;

  // ---------- applications ----------
  ensurePerimeterNodes(repo, perimeter);
  APPS.forEach((a, i) => {
    repo.upsertNode({ type: 'application', key: a.name, name: a.name, source: SOURCE, attrs: { auid: `AUID-${101 + i}`, profile: a.profile, criticality: a.crit, perimeter: true }, aliases: [a.sigle] });
  });
  OUT.forEach((a, i) => {
    repo.upsertNode({ type: 'application', key: a.name, name: a.name, source: SOURCE, attrs: { auid: `AUID-${301 + i}`, profile: a.profile, criticality: a.crit }, aliases: [a.sigle] });
  });

  // ---------- serveurs, runs_on (état final) ----------
  for (const s of servers) {
    const id = repo.upsertNode({ type: 'server', key: s.name, name: s.name, source: SOURCE, attrs: { [`${SOURCE}_row`]: s.row, ...s.attrs }, aliases: [s.attrs.fqdn, s.attrs.ip] });
    s.id = id;
    repo.addEdge({ src: appId(s.app.sigle), dst: id, type: 'runs_on', source: SOURCE, sourceRef: `${SOURCE}#${s.row}`, confidence: 1 });
  }

  // ---------- les 3 imports d'inventaire ----------
  const imports = [now - 6 * DAY, now - 3 * DAY, now - DAY];
  for (let k = 1; k <= 3; k++) {
    const present = servers.filter((s) => s.from <= k && s.to >= k);
    const seen = {
      nodeIds: present.map((s) => s.id),
      edgeIds: present.map((s) => `${appId(s.app.sigle)}|${s.id}|runs_on|${SOURCE}`),
    };
    const attrsById = Object.fromEntries(present.map((s) => [s.id, attrsAt(s, k)]));
    history.recordImport({ source: SOURCE, seen, attrsById, complete: true, repo });
  }
  history.applyRetirements(repo);

  // ---------- bases de données et flux (schémas) ----------
  const dbIds = {};
  for (const a of APPS) {
    if (!a.db) continue;
    if (!dbIds[a.db]) dbIds[a.db] = repo.upsertNode({ type: 'database', key: a.db, name: a.db, source: 'drawio', attrs: { engine: DB_ENGINES[a.db] } });
    repo.addEdge({ src: appId(a.sigle), dst: dbIds[a.db], type: 'uses_db', source: 'drawio', sourceRef: `schema-${slug(a.sigle)}`, confidence: 0.8, attrs: { diagramPage: `Architecture ${a.name}` } });
  }
  for (const [from, to] of CALLS) {
    repo.addEdge({ src: appId(from), dst: appId(to), type: 'calls', source: 'drawio', sourceRef: `schema-${slug(from)}`, confidence: 0.8, attrs: { label: 'API', diagramPage: `Architecture ${[...APPS, ...OUT].find((a) => a.sigle === from).name}` } });
  }

  // ---------- documentation ----------
  const live = (sigle, env) => servers.filter((s) => s.app.sigle === sigle && s.to === 3 && (env === undefined || s.env === env));
  let pageNo = 10000;
  const docRows = [];
  const docsOf = {}; // sigle -> { archi: [{ docId, pid, env }], other: [{ docId, pid }] }
  const makeDoc = ({ title, kind, text, updatedDays, citedIds, period = 'current' }) => {
    const pid = String(++pageNo);
    const docId = repo.upsertNode({
      type: 'document',
      key: `confluence-${pid}`,
      name: title,
      source: 'confluence',
      attrs: {
        url: `${WIKI}/${pid}`,
        space: 'ARCH',
        version: rng.int(2, 14),
        updatedAt: new Date(now - updatedDays * DAY).toISOString(),
        labels: kind === 'architecture' ? ['architecture', 'exploitation'] : ['exploitation'],
        excerpt: text,
        pageKindAi: kind === 'architecture' ? 'architecture' : 'other',
        period,
        ...(kind === 'architecture' ? { pageKind: 'architecture', architecture: { score: 0.9, reasons: ['titre', 'serveurs cités'] } } : {}),
      },
    });
    for (const sid of citedIds) repo.addEdge({ src: docId, dst: sid, type: 'mentions', source: 'confluence', sourceRef: pid, confidence: 0.9 });
    repo.saveDocument({ id: docId, source: 'confluence', title, url: `${WIKI}/${pid}`, version: 1, updatedAt: new Date(now - updatedDays * DAY).toISOString(), contentHash: `demo-${pid}`, status: 'enriched', attrs: { sections: 6, tables: 2 } });
    docRows.push(docId);
    return { docId, pid };
  };

  for (const a of APPS) {
    const spec = DOCS[a.sigle];
    docsOf[a.sigle] = { archi: [], other: [] };
    for (const p of spec.archi) {
      const expected = live(a.sigle, p.env);
      const gaps = p.gap || [];
      const missing = gaps.includes('missing') ? expected.slice(-1).map((s) => s.name) : [];
      const cited = expected.filter((s) => !missing.includes(s.name));
      const old = gaps.includes('old');
      const envLabel = p.env === 'PRD' ? 'production' : 'recette';
      const problems = [];
      if (missing.length) problems.push({ code: 'missing', n: missing.length });
      if (gaps.includes('unknown')) problems.push({ code: 'unknown', n: 1 });
      if (gaps.includes('ip')) problems.push({ code: 'ipMismatch', n: 1 });
      if (old) problems.push({ code: 'old', n: 3 });
      const audit = {
        environment: p.env,
        completeness: expected.length ? +(cited.length / expected.length).toFixed(2) : null,
        expected: expected.length,
        confirmed: cited.map((s) => s.name),
        missing,
        otherApp: [],
        unknown: gaps.includes('unknown') ? [`${slug(a.sigle)}-old1`] : [],
        ipMismatch: gaps.includes('ip') ? [{ server: expected[0].name, page: ['10.99.0.5'], inventory: [expected[0].attrs.ip] }] : [],
        sections: { servers: true, databases: !gaps.includes('missing'), flows: true, backup: p.env === 'PRD' && !gaps.includes('old'), monitoring: p.env === 'PRD', redundancy: p.env === 'PRD' && expected.length > 2, diagram: !old },
        absentSections: [],
        ageDays: old ? 1100 : rng.int(20, 300),
        problems,
        ok: problems.length === 0,
        verdict: verdictFr(problems),
      };
      audit.absentSections = Object.entries(audit.sections).filter(([, v]) => !v).map(([k]) => k);
      const { docId, pid } = makeDoc({
        title: `Architecture ${a.name} (${envLabel})`,
        kind: 'architecture',
        text: `Architecture technique de ${a.name} en ${envLabel} : serveurs applicatifs, base de données, flux entrants et sortants, sauvegarde et supervision.`,
        updatedDays: audit.ageDays,
        // la page de production décrit aussi les autres environnements de l'application
        period: old ? 'past' : 'current',
        citedIds: (p.env === 'PRD' ? [...cited, ...live(a.sigle).filter((s) => s.env !== 'PRD' && s.env !== null)] : cited).map((s) => s.id),
      });
      docsOf[a.sigle].archi.push({ docId, pid, env: p.env });
      repo.addEdge({ src: appId(a.sigle), dst: docId, type: 'documented_in', source: 'confluence', sourceRef: pid, confidence: 0.95, attrs: { role: 'subject', written: `Architecture ${a.name}`, evidence: `Architecture ${a.name} (${envLabel})`, reasons: ['titre (exact)', `${cited.length} serveurs de l'application`], spellings: [], audit } });
    }
    for (const title of spec.other) {
      const nCite = (spec.cites || {})[title] || 0;
      const { docId, pid } = makeDoc({
        title: `${title} ${a.name}`,
        kind: 'other',
        text: `${title} de l'application ${a.name}.`,
        updatedDays: rng.int(10, 400),
        citedIds: live(a.sigle, 'PRD').slice(0, nCite).map((s) => s.id),
      });
      docsOf[a.sigle].other.push({ docId, pid });
      repo.addEdge({ src: appId(a.sigle), dst: docId, type: 'documented_in', source: 'confluence', sourceRef: pid, confidence: 0.9, attrs: { role: 'subject', written: a.name, evidence: `${title} ${a.name}`, reasons: ['titre (exact)'], spellings: [] } });
    }
  }
  // page générale rattachée à aucune application
  const charte = makeDoc({ title: 'Charte d\'architecture du système d\'information', kind: 'other', text: 'Principes généraux d\'architecture, de sécurité et d\'exploitation communs à toutes les applications.', updatedDays: 200, citedIds: [] });

  // ---------- repérage par l'IA : formes écrites par la chaîne de lecture (voir reading/apply.js) ----------
  // page citée (et non sujet) : la charte mentionne deux applications
  for (const sigle of ['ATP', 'ORC']) {
    repo.addEdge({ src: appId(sigle), dst: charte.docId, type: 'documented_in', source: 'confluence', sourceRef: charte.pid, confidence: 0.6, attrs: { role: 'cited', written: [...APPS, ...OUT].find((x) => x.sigle === sigle).name, evidence: 'Les applications critiques (Atlas Paiements, Orion Clients) suivent cette charte.' } });
  }
  // responsables : une page de l'application les nomme (la page ancienne pour l'ancien responsable)
  for (const [sigle, list] of Object.entries(OWNERS)) {
    const pages = docsOf[sigle];
    const current = pages.other[0] || pages.archi[0];
    const old = pages.archi.find((p) => p.env === 'PRD') || current;
    for (const [name, kind, role, period = 'current'] of list) {
      const doc = period === 'past' ? old : current;
      const id = repo.upsertNode({ type: kind, key: nodeKey(kind, name), name, source: 'llm', attrs: { fromLlm: true } });
      repo.addEdge({
        src: appId(sigle), dst: id, type: 'owned_by', source: 'llm', sourceRef: doc.pid, confidence: 0.8,
        attrs: { role, period, evidence: `${kind === 'team' ? 'Équipe' : role === 'owner' ? 'Responsable' : 'Contact'} : ${name}`, docId: doc.docId },
      });
    }
  }
  for (const [sigle, a] of Object.entries(APM_OWNERS)) {
    repo.upsertNode({ type: 'application', key: [...APPS, ...OUT].find((x) => x.sigle === sigle).name, name: [...APPS, ...OUT].find((x) => x.sigle === sigle).name, source: SOURCE, attrs: a });
  }
  const readLink = (src, dst, type, doc, { trust, period = 'current', evidence }) =>
    repo.addEdge({ src, dst, type, source: 'llm', sourceRef: doc.pid, confidence: trust === 'toValidate' ? 0.5 : 0.8, attrs: { trust, period, evidence, docId: doc.docId } });
  const serverId = (name) => servers.find((s) => s.name === name).id;
  const prdPage = (sigle) => docsOf[sigle].archi.find((p) => p.env === 'PRD');
  // serveur hors inventaire, lu dans la page de production de VGF et supervisé par Naemon (corroboré)
  const ooi = repo.upsertNode({ type: 'server', key: OOI_SERVER.name, name: OOI_SERVER.name, source: 'llm', attrs: { fromLlm: true, outOfInventory: true, environment: 'PRD', ip: OOI_SERVER.ip }, aliases: [OOI_SERVER.ip] });
  readLink(appId('VGF'), ooi, 'runs_on', prdPage('VGF'), { trust: 'added', evidence: `${OOI_SERVER.name} (${OOI_SERVER.ip}) : serveur d'édition des factures` });
  repo.addEdge({ src: prdPage('VGF').docId, dst: ooi, type: 'mentions', source: 'confluence', sourceRef: prdPage('VGF').pid, confidence: 0.9 });
  // liens anciens, lus dans la page d'architecture ancienne de Sirius Stocks
  const oldPage = prdPage('SRS');
  readLink(appId('SRS'), serverId('srv-lxl-prd1'), 'runs_on', oldPage, { trust: 'added', period: 'past', evidence: 'Hébergé sur srv-lxl-prd1 (ancienne plateforme logistique)' });
  readLink(appId('SRS'), dbIds['Base Catalogue'], 'uses_db', oldPage, { trust: 'added', period: 'past', evidence: 'Lecture des références dans Base Catalogue' });
  readLink(appId('SRS'), appId('NVC'), 'calls', oldPage, { trust: 'added', period: 'past', evidence: 'Interroge Nova Catalogue pour les références articles' });
  // liens à valider : lus dans une page, pas encore confirmés par un inventaire
  readLink(appId('HLC'), serverId('srv-lxl-prd2'), 'runs_on', prdPage('HLC'), { trust: 'toValidate', evidence: 'Le module de préparation tourne aussi sur srv-lxl-prd2' });
  readLink(appId('TTP'), serverId('srv-zpn-prd2'), 'runs_on', prdPage('TTP'), { trust: 'toValidate', evidence: 'Relais de secours sur srv-zpn-prd2' });

  // ---------- fiches opérationnelles (écrites comme par la chaîne de lecture, par applyFiches et linkFiches) ----------
  const it = (text, evidence = text) => ({ text, evidence });
  const base = { section: null, date: null, fields: {}, lists: {}, unresolved: [], tickets: [], keywords: [], replaces: null, fixes: null, serverIds: [] };
  const demoFiches = [
    // procédure ancienne (page ancienne), remplacée par la procédure récente de la page voisine
    { app: 'ATP', page: ['other', 1], daysAgo: 900, period: 'past', fiche: { kind: 'procedure', title: it('Relancer le service d\'encaissement (ancienne méthode)'), keywords: ['relance', 'encaissement'], fields: { goal: it('Relancer le service d\'encaissement après un arrêt'), when: it('Après un arrêt du service') }, lists: { steps: [it('Arrêter le service avec le script stop-encaissement'), it('Vider le dossier de travail'), it('Démarrer le service avec le script start-encaissement')] } } },
    { app: 'ATP', page: ['other', 0], daysAgo: 40, period: 'current', fiche: { kind: 'procedure', title: it('Relancer le service d\'encaissement'), keywords: ['relance', 'redémarrage', 'encaissement'], replaces: it('Relancer le service d\'encaissement (ancienne méthode)'), fields: { goal: it('Relancer le service d\'encaissement sans perdre de paiement'), when: it('Quand les paiements restent en attente plus de 10 minutes'), cautions: it('Ne jamais relancer pendant la clôture de 23 h') }, lists: { steps: [it('Vérifier que la file des paiements est vide'), it('Arrêter le service avec la commande systemctl stop encaissement'), it('Démarrer le service avec la commande systemctl start encaissement'), it('Contrôler le tableau de bord des paiements pendant 5 minutes')] } } },
    { app: 'ORC', page: ['other', 0], daysAgo: 60, period: 'current', fiche: { kind: 'procedure', title: it('Purger le cache des clients'), keywords: ['purge', 'cache', 'référentiel'], fields: { goal: it('Purger le cache du référentiel clients après une mise à jour massive'), when: it('Quand des fiches clients affichent d\'anciennes valeurs') }, lists: { steps: [it('Se connecter à la console d\'administration d\'Orion Clients'), it('Ouvrir le menu Maintenance puis Purge du cache'), it('Lancer la purge et attendre le message de fin')] } } },
    { app: 'VGF', page: ['other', 0], daysAgo: 25, period: 'current', fiche: { kind: 'incident', title: it('Factures non envoyées, erreur SMTP-451'), keywords: ['facture', 'envoi', 'messagerie'], tickets: ['TCK-2087'], fields: { symptoms: it('Les factures restent en file d\'envoi et le journal affiche SMTP-451'), cause: it('La file d\'envoi sature quand le relais de messagerie répond trop lentement'), solution: it('Vider la file bloquée puis relancer l\'envoi des factures') }, lists: { errors: [it('SMTP-451 temporary local problem')], actions: [it('Vider la file bloquée depuis l\'écran Envois'), it('Relancer l\'envoi des factures du jour')], tickets: [it('TCK-2087')] } } },
    { app: 'VGF', page: ['other', 1], daysAgo: 10, period: 'current', fiche: { kind: 'correctif', title: it('Version 4.2.1 de Vega Facturation'), keywords: ['version', 'file d\'envoi'], tickets: ['TCK-2087'], fields: { version: it('4.2.1') }, lists: { tickets: [it('TCK-2087')] } } },
    { app: 'HLC', page: ['other', 0], daysAgo: 15, period: 'current', fiche: { kind: 'incident', title: it('Commandes bloquées au statut En préparation'), keywords: ['commande', 'blocage', 'statut'], tickets: ['TCK-3310'], fields: { symptoms: it('Des commandes restent au statut En préparation et le journal affiche ERR-ORD-017'), cause: it('Une réservation de stock reste verrouillée après un délai dépassé'), solution: it('Libérer la réservation verrouillée puis relancer la commande') }, lists: { errors: [it('ERR-ORD-017 reservation locked')], actions: [it('Libérer la réservation depuis l\'écran Stocks réservés'), it('Relancer la commande concernée')], tickets: [it('TCK-3310')] } } },
    { app: 'HLC', page: ['other', 0], daysAgo: 15, period: 'current', fiche: { kind: 'pratique', title: it('Bonnes pratiques de déploiement de Helios Commandes'), keywords: ['déploiement', 'mise en production'], lists: { rules: [it('Déployer en dehors des heures de pointe, de 10 h à 12 h et de 15 h à 17 h'), it('Vérifier la recette sur le serveur de préproduction avant la production'), it('Garder la version précédente pour un retour arrière rapide')] } } },
  ];
  // une page à la fois : applyFiches remplace tout ce que la page avait produit
  const byPage = new Map();
  for (const d of demoFiches) {
    const page = docsOf[d.app][d.page[0]][d.page[1]];
    if (!byPage.has(page.pid)) byPage.set(page.pid, { page, daysAgo: d.daysAgo, period: d.period, list: [] });
    byPage.get(page.pid).list.push({ ...base, ...d.fiche, appIds: [appId(d.app)] });
  }
  for (const { page, daysAgo, period, list } of byPage.values()) {
    applyFiches(repo, list, { pageId: page.pid, docNodeId: page.docId, page: { title: repo.getNode(page.docId).name, url: `${WIKI}/${page.pid}`, updatedAt: new Date(now - daysAgo * DAY).toISOString() }, period });
  }
  linkFiches(repo);

  // ---------- résumés ----------
  for (const a of APPS) {
    if (!a.summary) continue;
    repo.upsertNode({
      type: 'application',
      key: a.name,
      name: a.name,
      source: 'llm',
      attrs: { summary: a.summary, summaryEn: a.en, summaryAt: new Date(now - 2 * DAY).toISOString(), summaryHash: `demo-${slug(a.sigle)}`, summarySources: [] },
    });
  }

  const matcher = createMatcher(perimeter, repo);
  normalizeTimes(repo, { now, imports, dir });
  return { perimeter, matcher, seed, imports };
}

/** Dates relatives à `now` : le graphe est identique d'une génération à l'autre. */
function normalizeTimes(repo, { now, imports, dir }) {
  const d = repo.store.data;
  const created = fmtLocal(now - 7 * DAY);
  const updated = fmtLocal(now - DAY);
  for (const n of d.nodes.values()) {
    n.createdAt = created;
    n.updatedAt = updated;
    if (n.attrs.retiredAt) n.attrs.retiredAt = new Date(imports[2]).toISOString();
  }
  for (const e of d.edges.values()) {
    e.updated_at = updated;
    if (e.attrs && e.attrs.retiredAt) e.attrs.retiredAt = new Date(imports[2]).toISOString();
  }
  for (const doc of d.documents.values()) doc.processed_at = updated;
  const target = dir || (repo.store && repo.store.dir);
  if (!target) return;
  const snapFile = path.join(target, 'snapshots.json');
  const changesFile = path.join(target, 'changes.json');
  const snaps = readJson(snapFile, {});
  if (snaps[SOURCE]) {
    snaps[SOURCE].at = new Date(imports[2]).toISOString();
    writeJsonAtomic(snapFile, snaps);
  }
  const changes = readJson(changesFile, []);
  // la plus récente d'abord : import 3 puis import 2
  changes.forEach((c, i) => (c.at = new Date(imports[2 - i]).toISOString()));
  writeJsonAtomic(changesFile, changes);
}

module.exports = { generateDemo, buildDemoPerimeter, createRng, APPS, OUT };
