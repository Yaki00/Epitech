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

function buildMessages({ pageTitle, section, hints }) {
  const hintText = [
    hints.ips.length && `IP repérées : ${hints.ips.join(', ')}`,
    hints.hosts.length && `Hôtes repérés : ${hints.hosts.join(', ')}`,
    hints.paths.length && `Chemins repérés (filesystem) : ${hints.paths.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: SYSTEM },
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
 * @param {object} p    { pageTitle, section: {heading,text}, hints: {ips,hosts,paths} }
 */
async function extractRelations(llm, p) {
  const raw = await llm.chatJson({ task: 'extract', messages: buildMessages(p), temperature: 0, maxTokens: 2048, schema: SCHEMA });
  return sanitize(raw);
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
 */
function applyRelations(repo, extracted, { sourceRef, docId = null }) {
  const typeOf = new Map(extracted.entities.map((e) => [e.name.toLowerCase(), e.type]));
  const ensure = (name) => {
    const [known] = repo.resolve(name);
    if (known) return known.id;
    const type = typeOf.get(name.toLowerCase()) || 'unknown';
    return repo.upsertNode({ type: type === 'other' ? 'unknown' : type, key: name, name, source: 'llm', attrs: { fromLlm: true } });
  };
  let count = 0;
  for (const r of extracted.relations) {
    const src = ensure(r.from);
    const dst = ensure(r.to);
    repo.addEdge({ src, dst, type: r.type, source: 'llm', sourceRef, confidence: +(r.confidence * 0.8).toFixed(2), attrs: { evidence: r.evidence, docId } });
    count++;
  }
  return count;
}

module.exports = { extractRelations, applyRelations, sanitize, buildMessages, chunkText, SYSTEM };
