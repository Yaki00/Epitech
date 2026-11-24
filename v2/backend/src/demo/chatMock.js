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

/**
 * Sens de la question : ce dont X a besoin (dependencies) ou ce qui est touché si X tombe (impact_analysis).
 * X sujet de « dépendre » (« De quoi dépend X ? », « X dépend de quoi ? », « What does X depend on? ») : dependencies.
 * X complément (« Qu'est-ce qui dépend de X ? », « Qui utilise X ? », « What depends on X? ») : impact_analysis.
 * Formulation ambiguë : impact_analysis.
 */
const DEPENDENCY_PATTERNS = [
  // français : X est sujet
  /\bde quoi\b.*\b(depend|a besoin|ont besoin|a-t-il besoin|a-t-elle besoin)/,
  /\bdepend(ent)? de quoi\b/,
  /\bbesoin de quoi\b/,
  /\bsur quoi\b.*\b(repose|reposent|s'appuie|tourne)/,
  /\b(les |ses )?dependances (de|d')/,
  /\bqu'?est-ce qu'?(e )?\S+.*\b(utilise|appelle|necessite)\b/,
  /\bque (utilise|appelle|necessite)\b/,
  /\b(sur )?quels? (serveurs?|bases?)\b/,
  // anglais : X est sujet
  /\bwhat (does|do|did)\b.*\b(depend|need|use|rely|call)/,
  /\bdepends? on what\b/,
  /\bdependencies (of|for)\b/,
  /'s dependencies\b/,
  /\bwhich (servers?|databases?)\b/,
];
const IMPACT_PATTERNS = [/\bqu'?est-ce qui\b/, /\bqui (utilise|appelle|depend)/, /\bwhat (depends|uses|calls|relies)\b/, /\bwho (depends|uses|calls)\b/];

function askedDependencies(q) {
  if (IMPACT_PATTERNS.some((re) => re.test(q))) return false;
  return DEPENDENCY_PATTERNS.some((re) => re.test(q));
}

/** « Qui s'occupe de X ? », « Qui est responsable de X ? », « Who owns X ? » : outil owners_of. */
const OWNER_PATTERNS = [/\bqui (s'occupe|est responsable|gere|est le responsable|est la responsable|possede|pilote)\b/, /\bresponsables? (de|d')/, /\bwho (owns|is responsible|manages|runs|looks after|is in charge)\b/, /\bowners? of\b/];
const askedOwners = (q) => OWNER_PATTERNS.some((re) => re.test(q));

/** « Comment… », « Erreur… », « Incident… » : question de dépannage ou de procédure, réponse tirée des fiches. */
const DOC_PATTERNS = [/^(comment|how)\b/, /\b(erreur|error)\b/, /\bincident\b/, /\bprocedure\b/];
const askedDocumentation = (q) => DOC_PATTERNS.some((re) => re.test(q));

const question2text = (q) => norm(q).replace(/[\u2019`]/g, "'").replace(/\s+/g, ' ');

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

  const wantsDependencies = (q) => askedDependencies(question2text(q));
  const names = (items, type) => items.filter((i) => i.type === type).map((i) => i.name);
  const list = (arr, max = 8) => (arr.length > max ? `${arr.slice(0, max).join(', ')} et ${arr.length - max} autres` : arr.join(', '));

  function compose(toolName, result, english) {
    if (!result || result.error) return `${PREFIX} ${result && result.error ? result.error : english ? 'No result.' : 'Aucun résultat.'}`;
    if (toolName === 'search_knowledge') {
      const top = (result.fiches || [])[0] || null;
      if (!top) return `${PREFIX} ${english ? 'Nothing found in the documentation.' : 'Je n\'ai rien trouvé dans la documentation.'}`;
      const flags = `${top.old ? (english ? ' (old)' : ' (ancienne)') : ''}${top.replaced ? (english ? ' (replaced)' : ' (remplacée)') : ''}`;
      const apps = top.appNames && top.appNames.length ? ` ${english ? 'for' : 'pour'} ${top.appNames.join(', ')}` : '';
      return `${PREFIX} ${english ? 'The most relevant fiche is' : 'La fiche la plus pertinente est'} « ${top.title} »${flags}${apps}. ${english ? 'Link' : 'Lien'} : ${top.url}`;
    }
    if (toolName === 'search_entities') {
      if (!result.length) return `${PREFIX} ${english ? 'Nothing found in the demo graph.' : 'Je ne trouve rien de correspondant dans le graphe de démonstration.'}`;
      const found = result.map((n) => `${n.name} (${n.type})`);
      return `${PREFIX} ${english ? 'Found' : 'Trouvé'} : ${list(found, 6)}.`;
    }
    if (toolName === 'owners_of') {
      const label = (o) => `${o.name} (${o.kind === 'team' ? (english ? 'team' : 'équipe') : english ? 'person' : 'personne'}, ${o.role}${o.period && o.period !== 'current' ? `, ${o.period === 'past' ? (english ? 'former' : 'ancien') : o.period}` : ''})`;
      if (result.owners) {
        if (!result.owners.length) return `${PREFIX} ${english ? `No owner is known for ${result.application.name}.` : `Aucun responsable connu pour ${result.application.name}.`}`;
        return `${PREFIX} ${english ? `${result.application.name} is looked after by` : `${result.application.name} est suivie par`} : ${list(result.owners.map(label), 8)}.`;
      }
      const who = result.person || result.team;
      return `${PREFIX} ${who.name} ${english ? 'looks after' : 's\'occupe de'} : ${list((result.applications || []).map((a) => a.name), 8) || (english ? 'nothing known' : 'rien de connu')}.`;
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
    if (askedDocumentation(question2text(question))) {
      const args = { query: question };
      if (jsonMode) return completion({ role: 'assistant', content: JSON.stringify({ tool: 'search_knowledge', arguments: args }) });
      return completion({ role: 'assistant', content: '', tool_calls: [{ id: 'call_demo_1', type: 'function', function: { name: 'search_knowledge', arguments: JSON.stringify(args) } }] });
    }
    const entity = findEntity(question);
    if (!entity) {
      const answer = HELP(english);
      return completion({ role: 'assistant', content: jsonMode ? JSON.stringify({ answer }) : answer });
    }
    if (askedOwners(question2text(question))) {
      const args = { id: entity.id };
      if (jsonMode) return completion({ role: 'assistant', content: JSON.stringify({ tool: 'owners_of', arguments: args }) });
      return completion({ role: 'assistant', content: '', tool_calls: [{ id: 'call_demo_1', type: 'function', function: { name: 'owners_of', arguments: JSON.stringify(args) } }] });
    }
    const name = wantsDependencies(question) ? 'dependencies' : 'impact_analysis';
    const args = { id: entity.id, max_depth: 4 };
    if (jsonMode) return completion({ role: 'assistant', content: JSON.stringify({ tool: name, arguments: args }) });
    return completion({ role: 'assistant', content: '', tool_calls: [{ id: 'call_demo_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  };
}

module.exports = { createChatMock, askedDependencies: (q) => askedDependencies(question2text(q)) };
