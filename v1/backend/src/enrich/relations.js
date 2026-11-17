'use strict';
/**
 * Extraction de relations par IA, UN SEUL appel par section
 * (remplace detectRelationWithAI + detectServerTypeWithAI + extractServersFromPageWithAI).
 *
 * On donne au modèle les entités déjà détectées par les règles (IP, hôtes, chemins)
 * pour qu'il les relie, au lieu de tout lui faire deviner.
 */

const SYSTEM = `Tu es un analyste d'infrastructure. On te donne un extrait de documentation interne.
Extrais UNIQUEMENT les faits explicitement écrits. N'invente rien.
Réponds en JSON strict, sans texte autour, au format :
{
  "application": "code ou nom de l'application principale décrite, ou null",
  "entities": [
    {"name": "…", "type": "application|server|database|filesystem|url|queue|team|other", "env": "PROD|PREPROD|DEV|…|null"}
  ],
  "relations": [
    {"from": "…", "to": "…", "type": "runs_on|uses_db|calls|reads_from|writes_to|depends_on|owned_by", "evidence": "courte citation du texte", "confidence": 0.0}
  ]
}
Règles :
- "from" dépend de "to" (ex: application runs_on serveur, application uses_db base).
- Un chemin (/data/x, \\\\partage, D:\\...) est de type filesystem, PAS un serveur.
- confidence : 1.0 si c'est écrit tel quel, 0.5 si c'est une déduction directe, rien en dessous.
- Si l'extrait ne contient aucune relation, renvoie des listes vides.`;

const SCHEMA = { entities: 'array', relations: 'array', 'application?': 'string' };
const RELATION_TYPES = new Set(['runs_on', 'uses_db', 'calls', 'reads_from', 'writes_to', 'depends_on', 'owned_by']);
const ENTITY_TYPES = new Set(['application', 'server', 'database', 'filesystem', 'url', 'queue', 'team', 'other']);

/** Bloc du prompt décrivant le périmètre : noms de référence et variantes connues. */
function scopeText(scope) {
  const list = scope.apps.map((a) => `- ${a.name}${a.aliases.length ? ` (aussi écrit : ${a.aliases.join(', ')})` : ''}`).join('\n');
  return `Périmètre : seules ces applications nous intéressent (nom de référence, puis variantes connues) :
${list}
- Dans le texte, une application du périmètre peut être abrégée, incomplète, en sigle ou mal orthographiée : si tu la reconnais, écris son nom de référence EXACT.
- Quand le texte dit "l'application", "le batch", "ce serveur" sans nom et que la page concerne une application du périmètre (indiquée plus bas), utilise ce nom.
${scope.ignoreOthers ? '- N\'extrais AUCUNE relation qui implique une application hors de cette liste. Les serveurs, bases, files, flux et chemins liés à une application du périmètre restent à extraire.' : ''}`;
}

/**
 * @param {object} p { pageTitle, section, hints, scope? }
 *   scope : { apps: [{name, aliases}], ignoreOthers, pageApps?: [noms], knownServers?: [noms] }
 */
function buildMessages({ pageTitle, section, hints, scope = null }) {
  const hintText = [
    hints.ips.length && `IP repérées : ${hints.ips.join(', ')}`,
    hints.hosts.length && `Hôtes repérés : ${hints.hosts.join(', ')}`,
    hints.paths.length && `Chemins repérés (filesystem) : ${hints.paths.join(', ')}`,
    scope?.pageApps?.length && `Cette page concerne probablement : ${scope.pageApps.join(', ')}`,
    scope?.knownServers?.length && `Serveurs connus de ces applications cités dans la page : ${scope.knownServers.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: scope ? `${SYSTEM}\n\n${scopeText(scope)}` : SYSTEM },
    {
      role: 'user',
      content: `Page : ${pageTitle}\nSection : ${section.heading || '(début)'}\n${hintText ? hintText + '\n' : ''}\n---\n${section.text}\n---`,
    },
  ];
}

/** Nettoie la sortie du modèle (types inconnus, confiance hors bornes, doublons). */
function sanitize(result) {
  const entities = (result.entities || [])
    .filter((e) => e && e.name)
    .map((e) => ({ name: String(e.name).trim(), type: ENTITY_TYPES.has(e.type) ? e.type : 'other', env: e.env || null }));
  const seen = new Set();
  const relations = (result.relations || [])
    .filter((r) => r && r.from && r.to && RELATION_TYPES.has(r.type))
    .map((r) => ({
      from: String(r.from).trim(),
      to: String(r.to).trim(),
      type: r.type,
      evidence: r.evidence ? String(r.evidence).slice(0, 300) : null,
      confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
    }))
    .filter((r) => r.confidence >= 0.5)
    .filter((r) => {
      const k = `${r.from}|${r.type}|${r.to}`.toLowerCase();
      return seen.has(k) ? false : seen.add(k);
    });
  return { application: result.application || null, entities, relations };
}

/**
 * @param {object} llm  client créé par createLlmClient
 * @param {object} p    { pageTitle, section: {heading,text}, hints: {ips,hosts,paths}, scope? }
 */
async function extractRelations(llm, p) {
  const raw = await llm.chatJson({ task: 'extract', messages: buildMessages(p), temperature: 0, maxTokens: 2048, schema: SCHEMA });
  return sanitize(raw);
}

const TRIAGE_SYSTEM = `Tu tries des pages de documentation interne. Dis si la page parle d'une ou plusieurs applications de la liste,
même si le nom est abrégé, incomplet, en sigle ou mal orthographié, ou si la page la décrit sans la nommer (serveurs, rôle, environnement).
Réponds en JSON strict, sans texte autour : {"applications": [{"name": "nom de référence EXACT de la liste", "confidence": 0.0, "evidence": "courte citation"}]}
confidence : 1.0 si c'est écrit tel quel, 0.6 si c'est une déduction claire, ne cite pas l'application en dessous. Liste vide si la page ne concerne aucune application de la liste.`;

/**
 * Tri rapide d'une page dont aucun nom du périmètre n'a été reconnu par les règles :
 * l'IA lit le titre, les pages parentes et le début du texte.
 * @returns {Promise<Array<{name, confidence, evidence}>>}
 */
async function triagePage(llm, { title, ancestors = [], text, scope }) {
  const list = scope.apps.map((a) => `- ${a.name}${a.aliases.length ? ` (aussi écrit : ${a.aliases.join(', ')})` : ''}`).join('\n');
  const raw = await llm.chatJson({
    task: 'extract',
    messages: [
      { role: 'system', content: `${TRIAGE_SYSTEM}\n\nApplications :\n${list}` },
      { role: 'user', content: `Page : ${title}\nPages parentes : ${ancestors.join(' > ') || '(aucune)'}\n---\n${String(text || '').slice(0, 4000)}\n---` },
    ],
    temperature: 0,
    maxTokens: 400,
    schema: { applications: 'array' },
  });
  return (raw.applications || [])
    .filter((a) => a && a.name)
    .map((a) => ({ name: String(a.name).trim(), confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)), evidence: a.evidence ? String(a.evidence).slice(0, 300) : null }))
    .filter((a) => a.confidence >= 0.6);
}

/** Découpe une section trop longue en morceaux (par paragraphes). */
function chunkText(text, maxChars = 6000) {
  if (text.length <= maxChars) return [text];
  const out = [];
  let cur = '';
  for (const para of text.split(/\n{1,}/)) {
    if ((cur + '\n' + para).length > maxChars && cur) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? cur + '\n' + para : para;
    while (cur.length > maxChars) {
      out.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Écrit les relations extraites dans le graphe.
 * - une entité déjà connue est réutilisée (résolution par alias)
 * - une entité inconnue est créée avec attrs.fromLlm = true (à valider)
 * - confiance finale = confiance du modèle × 0.8 (une déduction IA ne vaut pas une source structurée)
 * - avec un périmètre (matcher) : un nom d'application mal écrit est ramené à son nom de référence,
 *   et une relation qui implique une application hors périmètre est écartée (comptée dans `dropped`)
 * @returns {number} nombre de relations écrites (le détail est dans opts.counters si fourni)
 */
function applyRelations(repo, extracted, { sourceRef, docId = null, matcher = null, counters = null }) {
  const typeOf = new Map(extracted.entities.map((e) => [e.name.toLowerCase(), e.type]));
  const ensure = (name) => {
    const declared = typeOf.get(name.toLowerCase());
    if (matcher) {
      const m = matcher.resolveAppName(name);
      if (m) {
        if (m.kind !== 'exact' && m.kind !== 'alias' && counters) counters.renamed = (counters.renamed || 0) + 1;
        return m.app.id;
      }
    }
    const [known] = repo.resolve(name);
    if (known) {
      if (matcher && matcher.ignoreOthers && known.type === 'application' && !known.attrs.perimeter) return null;
      return known.id;
    }
    // application inconnue et hors périmètre : ignorée
    if (matcher && matcher.ignoreOthers && declared === 'application') return null;
    const type = declared || 'unknown';
    return repo.upsertNode({ type: type === 'other' ? 'unknown' : type, key: name, name, source: 'llm', attrs: { fromLlm: true } });
  };
  let count = 0;
  for (const r of extracted.relations) {
    const src = ensure(r.from);
    const dst = ensure(r.to);
    if (!src || !dst || src === dst) {
      if (counters) counters.dropped = (counters.dropped || 0) + 1;
      continue;
    }
    repo.addEdge({ src, dst, type: r.type, source: 'llm', sourceRef, confidence: +(r.confidence * 0.8).toFixed(2), attrs: { evidence: r.evidence, docId } });
    count++;
  }
  return count;
}

module.exports = { extractRelations, applyRelations, triagePage, sanitize, buildMessages, chunkText, SYSTEM };
