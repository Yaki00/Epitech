'use strict';
/**
 * Assistant "pose une question" : le modèle ne devine pas, il appelle des OUTILS
 * qui interrogent le graphe (recherche, impact, dépendances), puis répond en
 * citant ce qu'il a trouvé.
 */
const { impactOf, dependenciesOf } = require('../graph/impact');
const { parseLlmJson } = require('../lib/json');

const SYSTEM = `Tu es Lyra, assistant d'analyse d'infrastructure.
Tu réponds en français, de façon concise.
Utilise TOUJOURS les outils pour obtenir les faits (serveurs, applications, dépendances, impacts).
N'invente aucun nom de serveur, d'application ou d'IP. Si l'information n'est pas dans les résultats des outils, dis-le.
Indique la source et la confiance des liens quand elle est inférieure à 1 (ex : "déduit de Confluence").`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_entities',
      description: "Cherche des applications, serveurs, bases… par nom, FQDN ou IP. À appeler d'abord pour obtenir l'id exact.",
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

const compact = (r) =>
  r && {
    start: { id: r.start.id, name: r.start.name, type: r.start.type },
    total: r.total,
    items: r.items.slice(0, 60).map((i) => ({ id: i.id, name: i.name, type: i.type, depth: i.depth, via: i.via })),
    truncated: r.items.length > 60,
  };

function runTool(repo, name, args) {
  switch (name) {
    case 'search_entities':
      return repo.search(String(args.query || ''), 15).map((n) => ({ id: n.id, name: n.name, type: n.type, attrs: n.attrs }));
    case 'impact_analysis':
      return compact(impactOf(repo, args.id, { maxDepth: Math.min(args.max_depth || 4, 6) })) || { error: `id inconnu : ${args.id}` };
    case 'dependencies':
      return compact(dependenciesOf(repo, args.id, { maxDepth: Math.min(args.max_depth || 3, 6) })) || { error: `id inconnu : ${args.id}` };
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
