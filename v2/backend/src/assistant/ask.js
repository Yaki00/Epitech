'use strict';
/**
 * Assistant "pose une question" : le modèle ne devine pas, il appelle des OUTILS
 * qui interrogent le graphe (recherche, impact, dépendances), puis répond en
 * citant ce qu'il a trouvé.
 */
const { impactOf, dependenciesOf, isInactiveEdge } = require('../graph/impact');
const { ownersOfApp } = require('../api/views');
const { parseLlmJson } = require('../lib/json');

const SYSTEM = `Tu es Lyra, assistant d'analyse d'infrastructure.
Tu réponds en français, de façon concise.
Utilise TOUJOURS les outils pour obtenir les faits (serveurs, applications, dépendances, impacts).
N'invente aucun nom de serveur, d'application ou d'IP. Si l'information n'est pas dans les résultats des outils, dis-le.
Indique la source et la confiance des liens quand elle est inférieure à 1 (ex : "déduit de Confluence").
Un lien ou un responsable dont period vaut "past" est ANCIEN, "target" est une CIBLE (pas encore en place), period null (responsable) est de période inconnue et À VALIDER, trust "toValidate" est À VALIDER : dis-le toujours, et ne les compte pas comme actifs (inactiveLinks les liste à part).
outOfInventory vrai : le serveur est cité par la documentation mais absent des inventaires.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'owners_of',
      description: "Responsables et équipes d'une application (id d'application), ou applications d'une personne ou d'une équipe (id de personne ou d'équipe). Chaque résultat indique role et period (current, past, target).",
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_entities',
      description: "Cherche des applications, serveurs, bases, personnes, équipes… par nom, FQDN ou IP. À appeler d'abord pour obtenir l'id exact.",
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'impact_analysis',
      description: "Liste ce qui est impacté si l'entité tombe ou est modifiée (applications, serveurs dépendants).",
      parameters: { type: 'object', properties: { id: { type: 'string' }, max_depth: { type: 'integer' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dependencies',
      description: "Liste ce dont l'entité a besoin pour fonctionner (serveurs, bases, autres applications).",
      parameters: { type: 'object', properties: { id: { type: 'string' }, max_depth: { type: 'integer' } }, required: ['id'] },
    },
  },
];

/** Consigne système dans la langue de l'interface (fr par défaut, en sur demande). */
const systemFor = (lang) => (lang === 'en' ? SYSTEM.replace('Tu réponds en français, de façon concise.', 'Answer in English, concisely. Keep server, application and IP names exactly as they are.') : SYSTEM);

const marks = (e) => ({ trust: (e.attrs && e.attrs.trust) || null, period: (e.attrs && e.attrs.period) || null });
const outOf = (n) => Boolean(n && n.type === 'server' && n.attrs && n.attrs.outOfInventory);
const lite = (n) => ({ id: n.id, name: n.name, type: n.type, ...(outOf(n) ? { outOfInventory: true } : {}) });

/** Marques (confiance, période) du lien qui a mené à un élément du parcours. */
function viaMarks(repo, item) {
  if (!item.via) return {};
  const edges = [...repo.edgesFrom(item.via.from), ...repo.edgesTo(item.via.from)].filter((e) => e.type === item.via.edgeType && (e.src === item.id || e.dst === item.id) && !isInactiveEdge(e));
  return edges[0] ? marks(edges[0]) : {};
}

/** Liens inactifs (anciens, cibles, à valider) qui touchent l'entité : listés à part, jamais comptés. */
function inactiveLinks(repo, id) {
  const out = [];
  for (const e of [...repo.edgesFrom(id), ...repo.edgesTo(id)]) {
    if (!isInactiveEdge(e) || (e.attrs && e.attrs.retired) || ['mentions', 'documented_in', 'monitored_by', 'owned_by'].includes(e.type)) continue;
    const from = repo.getNode(e.src);
    const to = repo.getNode(e.dst);
    if (from && to) out.push({ from: lite(from), to: lite(to), type: e.type, ...marks(e) });
  }
  return out;
}

const compact = (repo, r) =>
  r && {
    start: lite(r.start),
    total: r.total,
    items: r.items.slice(0, 60).map((i) => ({ id: i.id, name: i.name, type: i.type, depth: i.depth, via: i.via, ...(outOf(repo.getNode(i.id)) ? { outOfInventory: true } : {}), ...viaMarks(repo, i) })),
    truncated: r.items.length > 60,
    inactiveLinks: inactiveLinks(repo, r.start.id).slice(0, 30),
  };

/** Responsables d'une application, ou applications d'une personne / équipe. */
function ownersTool(repo, id) {
  const n = repo.getNode(String(id || ''));
  if (!n) return { error: `id inconnu : ${id}` };
  if (n.type === 'application') return { application: lite(n), owners: ownersOfApp(repo, n).map(({ id: oid, name, kind, role, period, source }) => ({ id: oid, name, kind, role, period, source })) };
  if (n.type !== 'person' && n.type !== 'team') return { error: `${id} n'est ni une application, ni une personne, ni une équipe` };
  const apps = new Map();
  for (const e of repo.edgesTo(n.id).filter((x) => x.type === 'owned_by' && !(x.attrs && x.attrs.retired))) {
    const a = repo.getNode(e.src);
    if (a && !(a.attrs && a.attrs.retired)) apps.set(`${a.id}|${(e.attrs && e.attrs.role) || ''}`, { id: a.id, name: a.name, role: (e.attrs && e.attrs.role) || 'other', period: e.attrs && e.attrs.period === null ? null : (e.attrs && e.attrs.period) || 'current', source: 'doc' });
  }
  const attr = n.type === 'person' ? 'owner' : 'supportTeam';
  for (const a of repo.listByType('application').filter((x) => !(x.attrs && x.attrs.retired))) {
    if (a.attrs[attr] && String(a.attrs[attr]).toLowerCase() === n.name.toLowerCase() && ![...apps.values()].some((x) => x.id === a.id)) {
      apps.set(`${a.id}|apm`, { id: a.id, name: a.name, role: n.type === 'person' ? 'owner' : 'support', period: 'current', source: 'apm' });
    }
  }
  return { [n.type]: lite(n), applications: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function runTool(repo, name, args) {
  switch (name) {
    case 'search_entities':
      return repo.search(String(args.query || ''), 15).map((n) => ({ id: n.id, name: n.name, type: n.type, attrs: n.attrs, ...(outOf(n) ? { outOfInventory: true } : {}) }));
    case 'owners_of':
      return ownersTool(repo, args.id);
    case 'impact_analysis':
      return compact(repo, impactOf(repo, args.id, { maxDepth: Math.min(args.max_depth || 4, 6) })) || { error: `id inconnu : ${args.id}` };
    case 'dependencies':
      return compact(repo, dependenciesOf(repo, args.id, { maxDepth: Math.min(args.max_depth || 3, 6) })) || { error: `id inconnu : ${args.id}` };
    default:
      return { error: `outil inconnu : ${name}` };
  }
}

/** Consigne du mode "json" : pour les passerelles qui ne gèrent pas le champ tools (function calling). */
function jsonToolsPrompt(lang = 'fr') {
  const list = TOOLS.map((t) => `- ${t.function.name}(${Object.keys(t.function.parameters.properties).join(', ')}) : ${t.function.description}`).join('\n');
  return `${systemFor(lang)}

Outils disponibles :
${list}

Réponds UNIQUEMENT par un objet JSON, sans texte autour :
- pour appeler un outil : {"tool": "<nom>", "arguments": {...}}
- pour répondre à l'utilisateur : {"answer": "<ta réponse en français>"}
Appelle un seul outil à la fois. Les résultats des outils te sont renvoyés dans le message suivant.`;
}

const FAILED = "Je n'ai pas pu conclure en un nombre raisonnable d'étapes. Reformulez ou précisez l'application/le serveur.";

async function askNative({ llm, repo, messages, toolTrace, maxRounds }) {
  for (let round = 0; round < maxRounds; round++) {
    const res = await llm.chat({ task: 'chat', messages, tools: TOOLS, temperature: 0.2, maxTokens: 1500, cache: false });
    if (!res.toolCalls.length) return { answer: res.content, toolTrace };
    messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* arguments invalides : l'outil renverra une erreur */
      }
      const result = runTool(repo, call.function.name, args);
      toolTrace.push({ tool: call.function.name, args });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { answer: FAILED, toolTrace };
}

async function askJson({ llm, repo, messages, toolTrace, maxRounds, lang }) {
  messages[0] = { role: 'system', content: jsonToolsPrompt(lang) };
  for (let round = 0; round < maxRounds; round++) {
    const res = await llm.chat({ task: 'chat', messages, json: true, temperature: 0.2, maxTokens: 1500, cache: false });
    let msg;
    try {
      msg = parseLlmJson(res.content);
    } catch {
      return { answer: res.content, toolTrace }; // le modèle a répondu en texte libre : on le rend tel quel
    }
    if (typeof msg.answer === 'string') return { answer: msg.answer, toolTrace };
    if (!msg.tool) return { answer: res.content, toolTrace };
    const args = msg.arguments && typeof msg.arguments === 'object' ? msg.arguments : {};
    const result = runTool(repo, String(msg.tool), args);
    toolTrace.push({ tool: String(msg.tool), args });
    messages.push({ role: 'assistant', content: res.content });
    messages.push({ role: 'user', content: `Résultat de ${msg.tool} :\n${JSON.stringify(result)}` });
  }
  return { answer: FAILED, toolTrace };
}

/** La passerelle refuse-t-elle le champ tools ? (HTTP 400 qui parle d'outils) */
const toolsRejected = (err) => err && err.status === 400 && /tool|function/i.test(err.body || err.message || '');

/**
 * @param {object} p { llm, repo, question, history?: [{role, content}], toolsMode?: 'native'|'json' }
 *   toolsMode 'native' : function calling ; si la passerelle le refuse, bascule automatiquement en 'json'.
 * @returns {Promise<{answer: string, toolTrace: Array, toolsMode: string}>}
 */
async function ask({ llm, repo, question, history = [], maxRounds = 5, toolsMode = 'native', lang = 'fr' }) {
  const fresh = () => [{ role: 'system', content: systemFor(lang) }, ...history.slice(-10), { role: 'user', content: question }];
  if (toolsMode === 'json') return { ...(await askJson({ llm, repo, messages: fresh(), toolTrace: [], maxRounds, lang })), toolsMode: 'json' };
  try {
    return { ...(await askNative({ llm, repo, messages: fresh(), toolTrace: [], maxRounds })), toolsMode: 'native' };
  } catch (err) {
    if (!toolsRejected(err)) throw err;
    return { ...(await askJson({ llm, repo, messages: fresh(), toolTrace: [], maxRounds, lang })), toolsMode: 'json' };
  }
}

module.exports = { ask, runTool, TOOLS, jsonToolsPrompt, systemFor };
