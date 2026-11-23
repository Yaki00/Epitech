/**
 * Accès à l'API Lyra v2 : types des réponses, fonctions d'appel et hook useApi.
 * En développement, Vite relaie /api vers le backend (port 3002) ; en production, même origine.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from './i18n';

// ---------- types communs ----------

export type Env = 'PRD' | 'STG' | 'DEV';
/** `unknown` = pas de relève disponible ; `not_monitored` = relève disponible mais serveur absent. */
export type ServerState = 'ok' | 'warning' | 'critical' | 'down' | 'unknown' | 'maintenance' | 'not_monitored';
export type AppState = 'ok' | 'degraded' | 'down' | 'unknown';
export type NaemonSource = 'off' | 'thruk' | 'csv' | 'mock';
/** Code d'état d'un service Naemon : 0 OK, 1 alerte, 2 critique, 3 inconnu. */
export type ServiceCode = 0 | 1 | 2 | 3;
export type NodeType = 'application' | 'server' | 'database' | 'filesystem' | 'queue' | 'url' | 'document' | 'team' | string;
export type Attrs = Record<string, unknown>;

export interface Ref {
  id: string;
  name: string;
}

export interface AtRisk {
  /** id de l'application en panne qui menace celle-ci */
  because: string;
  /** chemin d'ids d'applications */
  path: string[];
}

export interface AppStatus {
  state: AppState;
  byEnv: Partial<Record<Env, AppState>>;
  atRisk: AtRisk | null;
}

export interface DocScorePart {
  key: 'architecture' | 'architectureClean' | 'serversDocumented' | 'summary' | string;
  points: number;
  max: number;
  /** texte en français fourni par le serveur */
  detail: string;
}

export interface DocScore {
  score: number;
  parts: DocScorePart[];
}

export interface Service {
  description: string;
  state: ServiceCode;
  output: string;
  lastCheck: number | null;
  ack: boolean;
  downtime: boolean;
}

export interface ChangeAttr {
  id: string;
  attr: string;
  before: unknown;
  after: unknown;
}

/** Changement entre deux imports. Ids de nœuds `type:clé`, ids de liens `src|dst|type|source`. */
export interface Change {
  at: string;
  source: string;
  added: string[];
  removed: string[];
  changed: ChangeAttr[];
  labels: Record<string, string>;
  /** Accueil seulement : listes tronquées, ces totaux restent exacts. */
  counts?: ChangeCounts;
  truncated?: boolean;
}

export interface ChangeCounts {
  addedNodes: number;
  removedNodes: number;
  addedLinks: number;
  removedLinks: number;
  changed: number;
}

// ---------- /api/config ----------

export interface UiConfig {
  demo: boolean;
  naemonSource: NaemonSource;
  version: string | null;
  naemonUrlTemplate: string | null;
  sources: { servicenow: boolean; bitbucket: boolean };
}

// ---------- applications ----------

export interface ApplicationSummary {
  id: string;
  name: string;
  inPerimeter: boolean;
  criticality: string | null;
  owner: string | null;
  supportTeam: string | null;
  description: string | null;
  summary: string | null;
  environments: Env[];
  /** serveurs non retirés */
  servers: number;
  /** bases non retirées */
  databases: number;
  lastSync: string | null;
  retired: boolean;
  status: AppStatus;
  docScore: DocScore;
}

export interface LinkedNode {
  id: string;
  name: string;
  type: NodeType;
  attrs: Attrs;
  retired: boolean;
  confidence: number;
  sources: string[];
}

export interface LinkedServer extends LinkedNode {
  env: Env | null;
  state: ServerState;
}

export interface DocAudit {
  [key: string]: unknown;
}

export interface AppDocument {
  id: string;
  name: string;
  url: string | null;
  architecture: boolean;
  audit: DocAudit | null;
}

export interface ApplicationDetail extends ApplicationSummary {
  attrs: Attrs;
  serverList: LinkedServer[];
  databaseList: LinkedNode[];
  callsList: LinkedNode[];
  usedBy: Ref[];
  documents: AppDocument[];
}

// ---------- serveurs ----------

export interface ServerApp extends Ref {
  criticality: string | null;
}

export interface ServerSummary {
  id: string;
  name: string;
  attrs: Attrs;
  env: Env | null;
  retired: boolean;
  state: ServerState;
  applications: ServerApp[];
}

export interface ServerDetail {
  id: string;
  name: string;
  attrs: Attrs;
  env: Env | null;
  retired: boolean;
  state: ServerState;
  ack: boolean;
  output: string;
  /** epoch en secondes */
  lastCheck: number | null;
  services: Service[];
  applications: (ServerApp & { state: AppState })[];
  documents: { id: string; name: string; url: string | null; architecture: boolean }[];
  changes: Omit<Change, 'labels'>[];
}

// ---------- /api/status ----------

export interface ServerLive {
  state: ServerState;
  ack: boolean;
  output: string;
  lastCheck: number | null;
  services: Service[];
}

export interface LiveStatus {
  source: NaemonSource;
  fetchedAt: string | null;
  lastOk: string | null;
  lastError: string | null;
  nextAt: string | null;
  servers: Record<string, ServerLive>;
  apps: Record<string, { state: AppState; byEnv: Partial<Record<Env, AppState>> }>;
  atRisk: Record<string, AtRisk>;
  unmatchedHosts: string[];
}

// ---------- /api/overview ----------

export interface OverviewAlert {
  serverId: string;
  name: string;
  state: 'down' | 'critical' | 'warning';
  output: string;
  ack: boolean;
  apps: Ref[];
}

export interface Overview {
  counts: {
    applications: number;
    servers: number;
    serversByEnv: { PRD: number; STG: number; DEV: number; unspecified: number };
    retiredServers: number;
    databases: number;
    documents: number;
  };
  apps: { id: string; name: string; state: AppState; criticality: string | null; docScore: number }[];
  /** non pris en charge d'abord, puis par gravité */
  alerts: OverviewAlert[];
  atRisk: { appId: string; name: string; because: Ref; path: Ref[] }[];
  /** status : success | error | running... (synchros), « démo », pour naemon : ok | error | pending | off | démo */
  sources: { source: string; lastRun: string | null; status: string }[];
  recentChanges: Change[];
  gaps: { counts: GapCounts; available: boolean };
  lowestDocs: { id: string; name: string; docScore: number }[];
  naemon: { source: NaemonSource; lastOk: string | null; lastError: string | null };
}

// ---------- /api/gaps ----------

export interface GapCounts {
  notMonitored: number;
  unknownMonitored: number;
  citedNotInInventory: number;
}

export interface Gaps {
  /** false sans relève : listes de supervision non fiables */
  available: boolean;
  notMonitored: { id: string; name: string; env: Env | null; ip: string | null }[];
  unknownMonitored: string[];
  citedNotInInventory: string[];
  counts: GapCounts;
}

// ---------- /api/simulate ----------

export interface SimulateRequest {
  nodeIds: string[];
  includeRetired?: boolean;
  depth?: number;
}

export interface SimulateResult {
  impacted: {
    id: string;
    name: string;
    type: NodeType;
    depth: number;
    via: { edgeType: string; from: string; source: string; confidence: number } | null;
  }[];
  byType: Record<string, string[]>;
  unknown: string[];
}

// ---------- /api/map ----------

export type MapEdgeType = 'runs_on' | 'uses_db' | 'calls';

export interface MapNode {
  id: string;
  type: 'application' | 'server' | 'database';
  label: string;
  /** serveurs seulement */
  env: Env | null;
  /** null pour les bases */
  state: ServerState | AppState | null;
  criticality: string | null;
  retired: boolean;
  /** serveurs : applications présentes sur la carte qui les hébergent */
  appIds: string[];
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  type: MapEdgeType;
  retired: boolean;
}

export interface MapData {
  nodes: MapNode[];
  edges: MapEdge[];
}

export interface MapQuery {
  /** 'perimeter' ou `app:<id>` */
  scope?: string;
  envs?: Env[];
  includeRetired?: boolean;
}

// ---------- routes v1 conservées ----------

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  attrs: Attrs;
  updatedAt?: string;
}

export interface Edge {
  src: string;
  dst: string;
  type: string;
  source: string;
  confidence: number;
  attrs: Attrs;
}

export interface NodeDetail extends GraphNode {
  outgoing: (Edge & { dstName: string })[];
  incoming: (Edge & { srcName: string })[];
}

export interface SyncRun {
  id: number;
  source: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'error' | string;
  stats: Record<string, unknown>;
  error: string | null;
}

export interface SyncRunError {
  run_id: number;
  source: string;
  ref: string | null;
  step: string;
  message: string;
  [key: string]: unknown;
}

export interface SyncJobRun {
  id: number;
  job: string;
  label: string;
  status: 'running' | 'success' | 'error' | string;
  startedAt: string;
  finishedAt: string | null;
  steps: { name: string; status: string; code?: number | null }[];
  lines: string[];
}

export interface SyncJobs {
  enabled: boolean;
  jobs: { id: string; label: string; description?: string }[];
  current: SyncJobRun | null;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskResult {
  answer: string;
  toolTrace: unknown[];
  toolsMode: 'native' | 'json';
}

// ---------- appels ----------

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

/** Appel JSON ; lève ApiError (status 0 = serveur injoignable). */
export async function request<T>(path: string, { method = 'GET', body, signal }: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(t('common.backendUnreachable'), 0);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : t('common.httpError', { status: res.status });
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;
const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

type Opts = { signal?: AbortSignal };

export const api = {
  config: (o?: Opts) => request<UiConfig>('/config', o),
  overview: (o?: Opts) => request<Overview>('/overview', o),
  status: (o?: Opts) => request<LiveStatus>('/status', o),
  applications: (o?: Opts) => request<ApplicationSummary[]>('/applications', o),
  application: (id: string, o?: Opts) => request<ApplicationDetail>(`/applications/${enc(id)}`, o),
  /** sans `q` : tous les serveurs (dans la limite) ; `q` cherche aussi par IP et alias */
  servers: (q?: string, limit?: number, o?: Opts) => request<ServerSummary[]>(`/servers${qs({ q, limit })}`, o),
  server: (id: string, o?: Opts) => request<ServerDetail>(`/servers/${enc(id)}`, o),
  gaps: (o?: Opts) => request<Gaps>('/gaps', o),
  /** lien de téléchargement du rapport d'écarts (CSV) */
  gapsCsvUrl: () => '/api/gaps?format=csv',
  changes: (limit?: number, o?: Opts) => request<Change[]>(`/changes${qs({ limit })}`, o),
  simulate: (body: SimulateRequest, o?: Opts) => request<SimulateResult>('/simulate', { method: 'POST', body, ...o }),
  map: ({ scope, envs, includeRetired }: MapQuery = {}, o?: Opts) =>
    request<MapData>(`/map${qs({ scope, envs: envs?.join(','), includeRetired })}`, o),
  search: (q: string, limit?: number, o?: Opts) => request<GraphNode[]>(`/search${qs({ q, limit })}`, o),
  node: (id: string, o?: Opts) => request<NodeDetail>(`/nodes/${enc(id)}`, o),
  syncRuns: (limit = 50, o?: Opts) => request<SyncRun[]>(`/sync/runs${qs({ limit })}`, o),
  syncErrors: (runId: number, o?: Opts) => request<SyncRunError[]>(`/sync/runs/${runId}/errors`, o),
  syncJobs: (o?: Opts) => request<SyncJobs>('/sync/jobs', o),
  startSyncJob: (job: string) => request<SyncJobs>('/sync/jobs', { method: 'POST', body: { job } }),
  ask: (question: string, history: ChatTurn[], lang: 'fr' | 'en') => request<AskResult>('/ask', { method: 'POST', body: { question, history, lang } }),
};

// ---------- hook ----------

/** Rafraîchissement des états : toutes les minutes. */
export const REFRESH_MS = 60_000;

export interface UseApiOptions {
  /** recharge en arrière-plan toutes les `refreshMs` millisecondes (onglet visible seulement) */
  refreshMs?: number;
  /** false : ne charge pas (ex. paramètre manquant) */
  enabled?: boolean;
}

export interface UseApiResult<T> {
  data: T | null;
  error: ApiError | Error | null;
  /** premier chargement (ou rechargement après changement de paramètres) en cours */
  loading: boolean;
  /** rechargement en arrière-plan en cours (les données précédentes restent affichées) */
  refreshing: boolean;
  /** recharge maintenant, sans effacer les données affichées */
  reload: () => void;
}

/**
 * Charge une ressource : `useApi((signal) => api.application(id, { signal }), [id], { refreshMs: REFRESH_MS })`.
 * - Changement de `deps` : nouveau chargement (requête précédente annulée).
 * - Rafraîchissement périodique et `reload()` : les données restent affichées pendant l'appel ;
 *   une erreur de rafraîchissement est exposée dans `error` sans effacer `data`.
 */
export function useApi<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], { refreshMs, enabled = true }: UseApiOptions = {}): UseApiResult<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean; refreshing: boolean }>({
    data: null,
    error: null,
    loading: enabled,
    refreshing: false,
  });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const ctrlRef = useRef<AbortController | null>(null);

  const run = useCallback((background: boolean) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setState((s) => (background ? { ...s, refreshing: true } : { data: null, error: null, loading: true, refreshing: false }));
    fetcherRef
      .current(ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ data, error: null, loading: false, refreshing: false });
      })
      .catch((error: unknown) => {
        if (ctrl.signal.aborted) return;
        const err = error instanceof Error ? error : new Error(String(error));
        setState((s) => ({ data: background ? s.data : null, error: err, loading: false, refreshing: false }));
      });
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false, refreshing: false });
      return undefined;
    }
    run(false);
    return () => ctrlRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run, ...deps]);

  useEffect(() => {
    if (!enabled || !refreshMs) return undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') run(true);
    };
    const id = window.setInterval(tick, refreshMs);
    // retour sur l'onglet après une longue absence : données fraîches tout de suite
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > refreshMs) run(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshMs, run, ...deps]);

  const reload = useCallback(() => run(true), [run]);
  return { ...state, reload };
}
