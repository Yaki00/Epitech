'use strict';
/**
 * Assistant simulé du mode démo : mockHandler pour createLlmClient (LLM_MOCK).
 * Il choisit un outil d'après la question, laisse ask() l'exécuter (runTool sur le graphe de démonstration),
 * puis rédige la réponse à partir du résultat. Toute réponse commence par « [démo] ».
 * Fonctionne en function calling (tools) comme en mode json.
 */
const { runTool } = require('../assistant/ask');

const PREFIX = '[démo]';
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const completion = (message) => ({ choices: [{ message }], usage: { prompt_tokens: 0, completion_tokens: 0 }, model: 'demo' });

function createChatMock(repo) {
  /** Entité citée dans la question : nom de serveur, nom ou sigle d'une application (celle du périmètre d'abord). */
  function findEntity(question) {
    const q = norm(question);
    const srv = q.match(/srv-[a-z]+-[a-z]+\d+|srv-[a-z]+-util\d+/);
    if (srv) {
      const hit = runTool(repo, 'search_entities', { query: srv[0] }).find((n) => n.type === 'server');
      if (hit) return hit;
    }
    const apps = repo.listByType('application').sort((a, b) => Number(Boolean(b.attrs.perimeter)) - Number(Boolean(a.attrs.perimeter)));
    for (const a of apps) if (q.includes(norm(a.name))) return { id: a.id, name: a.name, type: 'application' };
    // sigle écrit en majuscules (ATP, HLC...)
    for (const sigle of String(question).match(/\b[A-Z]{3}\b/g) || []) {
      const hit = repo.resolve(sigle).find((n) => n.type === 'application');
      if (hit) return { id: hit.id, name: hit.name, type: 'application' };
    }
    return null;
  }

  const wantsDependencies = (q) => /depend|besoin|utilise|appelle|repose|necessite|dependenc|rely|depends|needs|uses/.test(norm(q));
  const names = (items, type) => items.filter((i) => i.type === type).map((i) => i.name);
  const list = (arr, max = 8) => (arr.length > max ? `${arr.slice(0, max).join(', ')} et ${arr.length - max} autres` : arr.join(', '));

  function compose(toolName, result, english) {
    if (!result || result.error) return `${PREFIX} ${result && result.error ? result.error : english ? 'No result.' : 'Aucun résultat.'}`;
    if (toolName === 'search_entities') {
      if (!result.length) return `${PREFIX} ${english ? 'Nothing found in the demo graph.' : 'Je ne trouve rien de correspondant dans le graphe de démonstration.'}`;
      const found = result.map((n) => `${n.name} (${n.type})`);
      return `${PREFIX} ${english ? 'Found' : 'Trouvé'} : ${list(found, 6)}.`;
    }
    const apps = names(result.items || [], 'application');
    const srvs = names(result.items || [], 'server');
    const dbs = names(result.items || [], 'database');
    const start = result.start.name;
    const parts = [];
    if (apps.length) parts.push(`${english ? 'applications' : 'applications'} ${list(apps)}`);
    if (dbs.length) parts.push(`${english ? 'databases' : 'bases'} ${list(dbs)}`);
    if (srvs.length) parts.push(`${english ? 'servers' : 'serveurs'} ${list(srvs, 6)}`);
    if (toolName === 'impact_analysis') {
      if (!result.total) return `${PREFIX} ${english ? `If ${start} stops, nothing else depends on it in the graph.` : `Si ${start} s'arrête, aucune autre application ou serveur n'en dépend dans le graphe.`}`;
      return `${PREFIX} ${english ? `If ${start} is down, ${result.total} elements are affected` : `Si ${start} tombe, ${result.total} éléments sont touchés`} : ${parts.join(' ; ')}. ${english ? 'Computed from the graph (inventories and diagrams).' : 'Calculé à partir du graphe (inventaires et schémas).'}`;
    }
    if (!result.total) return `${PREFIX} ${english ? `${start} has no known dependency.` : `${start} n'a aucune dépendance connue.`}`;
    return `${PREFIX} ${english ? `${start} needs ${result.total} elements` : `${start} a besoin de ${result.total} éléments`} : ${parts.join(' ; ')}. ${english ? 'Computed from the graph (inventories and diagrams).' : 'Calculé à partir du graphe (inventaires et schémas).'}`;
  }

  const HELP = (english) =>
    `${PREFIX} ${english ? 'This is the demo assistant. Try: "What happens if Atlas Paiements goes down?" or "What does Helios Commandes depend on?".' : 'Ceci est l\'assistant de démonstration. Essayez : « Que se passe-t-il si Atlas Paiements tombe ? » ou « De quoi dépend Helios Commandes ? ».'}`;

  return function mockHandler(endpoint, body) {
    if (endpoint === '/embeddings') return { data: (body.input || []).map((_, index) => ({ index, embedding: [0] })) };
    const messages = body.messages || [];
    const english = /Answer in English/.test((messages[0] && messages[0].content) || '');
    const jsonMode = !body.tools;
    const last = messages[messages.length - 1] || {};

    // 2e temps : le résultat de l'outil est revenu
    let toolName = null;
    let toolResult = null;
    if (last.role === 'tool') {
      const call = [...messages].reverse().find((m) => m.tool_calls);
      toolName = call && call.tool_calls[0].function.name;
      toolResult = JSON.parse(last.content);
    } else if (last.role === 'user' && /^Résultat de /.test(String(last.content))) {
      const m = String(last.content).match(/^Résultat de (\w+) :\n([\s\S]*)$/);
      toolName = m && m[1];
      toolResult = m && JSON.parse(m[2]);
    }
    if (toolName) {
      const answer = compose(toolName, toolResult, english);
      return completion({ role: 'assistant', content: jsonMode ? JSON.stringify({ answer }) : answer });
    }

    // 1er temps : choix de l'outil
    const question = String(last.content || '');
    const entity = findEntity(question);
    if (!entity) {
      const answer = HELP(english);
      return completion({ role: 'assistant', content: jsonMode ? JSON.stringify({ answer }) : answer });
    }
    const name = wantsDependencies(question) ? 'dependencies' : 'impact_analysis';
    const args = { id: entity.id, max_depth: 4 };
    if (jsonMode) return completion({ role: 'assistant', content: JSON.stringify({ tool: name, arguments: args }) });
    return completion({ role: 'assistant', content: '', tool_calls: [{ id: 'call_demo_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  };
}

module.exports = { createChatMock };
