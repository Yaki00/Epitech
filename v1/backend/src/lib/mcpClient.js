'use strict';
/**
 * Client pour la passerelle MCP interne (Confluence, ServiceNow, Bitbucket, Jira…).
 * Appel : POST {MCP_BASE_URL}/{toolName} avec les arguments en JSON.
 *
 * ⚠ À ALIGNER avec backend/utils/mcpTools.js de lyrav2 (format exact du body
 * et de la réponse). Seul `callTool` est à adapter, le reste du projet ne
 * dépend que de cette fonction.
 */
const { sleep, backoffDelay } = require('./limiter');
const { httpFetch } = require('./httpFetch');
const { createLogger } = require('./logger');

function createMcpClient(cfg, deps = {}) {
  const log = deps.logger || createLogger('mcp');
  const fetchFn = deps.fetch || httpFetch;

  async function callTool(name, args = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        const res = await fetchFn(`${cfg.baseUrl}/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
          },
          body: JSON.stringify(args),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new Error(`MCP ${name} : HTTP ${res.status} ${text.slice(0, 200)}`);
          err.retryable = res.status === 429 || res.status >= 500;
          throw err;
        }
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      } catch (err) {
        lastErr = err;
        const retryable = err.retryable ?? true;
        if (!retryable || attempt === cfg.maxRetries) break;
        const delay = backoffDelay(attempt, deps.backoffBaseMs ?? 1000);
        log.warn(`MCP ${name} : nouvel essai dans ${delay} ms`, { raison: err.message });
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  /**
   * Recherche qui contourne une limite de N résultats par requête :
   * si une fenêtre de dates renvoie `cap` résultats, on la coupe en deux.
   * `fetchWindow(from, to)` doit renvoyer un tableau d'éléments ayant un `id`.
   */
  async function fetchAllByWindows(fetchWindow, { from, to, cap = 200, minWindowMs = 3600_000 }) {
    const seen = new Map();
    const stack = [[from.getTime(), to.getTime()]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const items = await fetchWindow(new Date(a), new Date(b));
      if (items.length >= cap && b - a > minWindowMs) {
        const mid = Math.floor((a + b) / 2);
        stack.push([a, mid], [mid, b]);
        continue;
      }
      if (items.length >= cap) log.warn('fenêtre minimale atteinte, résultats possiblement tronqués', { from: new Date(a), to: new Date(b) });
      for (const it of items) seen.set(it.id, it);
    }
    return [...seen.values()];
  }

  return { callTool, fetchAllByWindows };
}

module.exports = { createMcpClient };
