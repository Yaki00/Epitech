/** Accès à l'API Lyra (proxy Vite /api -> backend :3001). */
import { t } from '../lib/i18n';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw new ApiError(t('common.backendUnreachable'), 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || `Erreur ${res.status}`, res.status);
  return body;
}

const enc = encodeURIComponent;

export const api = {
  health: () => request('/health'),
  config: () => request('/config'),
  applications: () => request('/applications'),
  application: (id) => request(`/applications/${enc(id)}`),
  servers: (q) => request(`/servers?q=${enc(q || '')}`),
  teams: () => request('/teams'),
  graph: (id, depth = 2) => request(`/graph/${enc(id)}?depth=${depth}`),
  impact: (id, { depth = 4, minConfidence = 0.5 } = {}) => request(`/impact/${enc(id)}?depth=${depth}&minConfidence=${minConfidence}`),
  syncRuns: () => request('/sync/runs?limit=50'),
  syncErrors: (runId) => request(`/sync/runs/${runId}/errors`),
  syncJobs: () => request('/sync/jobs'),
  startSyncJob: (job) => request('/sync/jobs', { method: 'POST', body: JSON.stringify({ job }) }),
  ask: (question, history, lang = 'fr') => request('/ask', { method: 'POST', body: JSON.stringify({ question, history, lang }) }),
};
