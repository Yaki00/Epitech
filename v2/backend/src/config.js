'use strict';
/**
 * Configuration centrale. Tout vient de l'environnement (backend/.env), rien en dur.
 * Compatible Node 16 : le fichier .env est lu par le package dotenv.
 * Les chemins relatifs sont résolus par rapport au dossier backend/ (Windows et Linux).
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// quiet : dotenv 17 affiche sinon une ligne d'information à chaque démarrage
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const env = (key, def) => {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
};
const int = (key, def) => Number.parseInt(env(key, String(def)), 10);
const bool = (key, def) => ['1', 'true', 'yes'].includes(String(env(key, def)).toLowerCase());

const config = {
  root: ROOT,
  port: int('PORT', 3002),
  // 127.0.0.1 = accessible seulement depuis ce poste ; 0.0.0.0 sur un serveur
  host: env('HOST', '127.0.0.1'),
  // données du graphe (fichiers JSON) : supprimables, reconstruites par les synchros
  dataDir: path.resolve(ROOT, env('DATA_DIR', './data/store')),
  // mode démo : jeu fictif généré au démarrage dans demoDir (jamais mélangé avec dataDir), aucun appel réseau
  demo: bool('DEMO_MODE', 'false'),
  demoDir: path.resolve(ROOT, './data/demo-store'),
  // frontend compilé (npm run build sur une machine Node >= 20), servi par le backend
  frontendDist: path.resolve(ROOT, env('FRONTEND_DIST', '../frontend/dist')),

  llm: {
    baseUrl: env('LLM_BASE_URL', 'https://llm.example.local/v1/openai'),
    token: env('LLM_TOKEN', ''),
    // Un modèle par tâche : on compare et on change sans toucher au code.
    models: {
      extract: env('LLM_MODEL_EXTRACT', 'qwen3.6-35b-a3b'),
      chat: env('LLM_MODEL_CHAT', 'qwen3.8-27b'),
      summary: env('LLM_MODEL_SUMMARY', 'qwen3.8-27b'),
      vision: env('LLM_MODEL_VISION', 'gemma-4-31b'),
      ocr: env('LLM_MODEL_OCR', 'mistral-ocr-4'),
      embed: env('LLM_MODEL_EMBED', 'qwen3-embedding-8b'),
      rerank: env('LLM_MODEL_RERANK', 'bge-reranker-v2-m3'),
    },
    timeoutMs: int('LLM_TIMEOUT_MS', 120000),
    maxRetries: int('LLM_MAX_RETRIES', 3),
    // Réflexion des modèles qui en ont une (ex : none) : vide = rien n'est envoyé.
    reasoningEffort: env('LLM_REASONING_EFFORT', ''),
    // Place de réponse par tâche (la lecture des pages passe maxTokens.extract).
    // reasoning : place minimale de chaque réponse tant que la réflexion n'est pas coupée (réglage vide ou refusé).
    maxTokens: { extract: int('LLM_MAX_TOKENS_EXTRACT', 4096), reasoning: int('LLM_MAX_TOKENS_REASONING', 8192) },
    concurrency: int('LLM_CONCURRENCY', 4),
    mock: bool('LLM_MOCK', 'false'),
    // avec LLM_MOCK : lectures de pages préparées ({ "<titre>": lecture }), sinon lectures vides
    mockReadingsFile: env('LLM_MOCK_READINGS', '') ? path.resolve(ROOT, env('LLM_MOCK_READINGS', '')) : '',
    cacheDir: path.resolve(ROOT, env('LLM_CACHE_DIR', './data/cache/llm')),
    // Certaines passerelles n'acceptent pas response_format : on peut le couper.
    jsonMode: bool('LLM_JSON_MODE', 'true'),
    // native = champ "tools" (function calling) ; json = repli si la passerelle ne gère pas les outils
    toolsMode: env('LLM_TOOLS_MODE', 'native') === 'json' ? 'json' : 'native',
  },

  // Recherche dans les fiches : reclassement par la passerelle IA, éteint par défaut (non testable sur le banc).
  knowledge: {
    rerank: bool('KNOWLEDGE_RERANK', 'false'),
    // chemin relatif à LLM_BASE_URL
    rerankPath: env('KNOWLEDGE_RERANK_PATH', '/rerank'),
  },

  mcp: {
    baseUrl: env('MCP_BASE_URL', 'https://mcp.example.local/api/mcp/tools'),
    token: env('MCP_TOKEN', ''),
    timeoutMs: int('MCP_TIMEOUT_MS', 60000),
    maxRetries: int('MCP_MAX_RETRIES', 3),
  },

  confluence: {
    // export local : un dossier par page (metadata.json + page.html), écrit par scripts/fetch-confluence.js
    exportDir: path.resolve(ROOT, env('CONFLUENCE_EXPORT_DIR', './data/raw/confluence')),
    // récupération (scripts/fetch-confluence.js) : API REST Confluence Server / Data Center
    // false : la v2 lit l'export mais ne récupère jamais (récupération assurée par la v1)
    fetch: bool('CONFLUENCE_FETCH', 'true'),
    baseUrl: env('CONFLUENCE_BASE_URL', ''),
    token: env('CONFLUENCE_TOKEN', ''),
    user: env('CONFLUENCE_USER', ''),
    password: env('CONFLUENCE_PASSWORD', ''),
    spaces: env('CONFLUENCE_SPACES', '')
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    concurrency: int('CONFLUENCE_CONCURRENCY', 4),
    timeoutMs: int('CONFLUENCE_TIMEOUT_MS', 60000),
    downloadImages: bool('CONFLUENCE_DOWNLOAD_IMAGES', 'true'),
    maxAttachmentMb: int('CONFLUENCE_MAX_ATTACHMENT_MB', 20),
  },

  inventory: {
    mappingFile: path.resolve(ROOT, env('INVENTORY_MAPPING', './config/mappings.json')),
  },

  // applications suivies (liste fermée) : absent = tout est analysé
  perimeterFile: path.resolve(ROOT, env('PERIMETER_FILE', './config/perimeter.json')),
  // lecture des pages par l'IA : taille d'un morceau de page (caractères) envoyé en un appel
  reading: { chunkChars: Math.max(1000, int('READING_CHUNK_CHARS', 12000) || 12000) },
  // consignes de lecture pour l'IA (texte libre, facultatif)
  consignesFile: path.resolve(ROOT, env('CONSIGNES_FILE', './config/consignes-ia.md')),
  // rapports lisibles dans Excel (pages par application, orthographes rencontrées)
  reportsDir: path.resolve(ROOT, env('REPORTS_DIR', './data/rapports')),

  // nombre d'imports d'inventaire conservés dans changes.json
  history: { keep: int('HISTORY_KEEP', 50) },

  // supervision Naemon : off (défaut), thruk (API REST), csv (export Thruk) ; mock en mode démo
  naemon: {
    // « mock » n'existe qu'en démo (le serveur branche alors son propre simulateur) : ailleurs il vaut « off »
    source: ['thruk', 'csv'].includes(env('NAEMON_SOURCE', 'off').trim().toLowerCase()) ? env('NAEMON_SOURCE', 'off').trim().toLowerCase() : 'off',
    thrukUrl: env('NAEMON_THRUK_URL', ''),
    token: env('NAEMON_TOKEN', ''),
    user: env('NAEMON_USER', ''),
    password: env('NAEMON_PASSWORD', ''),
    csvFile: env('NAEMON_CSV_FILE', ''),
    pollMinutes: Math.max(1, int('NAEMON_POLL_MINUTES', 5) || 5),
    // lien du bouton « Monitoring Naemon » ({app} = nom de l'application)
    urlTemplate: env('NAEMON_URL_TEMPLATE', ''),
  },

  // synchros lançables depuis la page Synchronisation de l'interface
  allowUiSync: bool('ALLOW_UI_SYNC', 'true'),

  logLevel: env('LOG_LEVEL', 'info'),
};

module.exports = config;
