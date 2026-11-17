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
  port: int('PORT', 3001),
  // 127.0.0.1 = accessible seulement depuis ce poste ; 0.0.0.0 sur un serveur
  host: env('HOST', '127.0.0.1'),
  // données du graphe (fichiers JSON) : supprimables, reconstruites par les synchros
  dataDir: path.resolve(ROOT, env('DATA_DIR', './data/store')),
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
    concurrency: int('LLM_CONCURRENCY', 4),
    mock: bool('LLM_MOCK', 'false'),
    cacheDir: path.resolve(ROOT, env('LLM_CACHE_DIR', './data/cache/llm')),
    // Certaines passerelles n'acceptent pas response_format : on peut le couper.
    jsonMode: bool('LLM_JSON_MODE', 'true'),
    // native = champ "tools" (function calling) ; json = repli si la passerelle ne gère pas les outils
    toolsMode: env('LLM_TOOLS_MODE', 'native') === 'json' ? 'json' : 'native',
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
  // rapports lisibles dans Excel (pages par application, orthographes rencontrées)
  reportsDir: path.resolve(ROOT, env('REPORTS_DIR', './data/rapports')),

  logLevel: env('LOG_LEVEL', 'info'),
};

module.exports = config;
