/**
 * Cartographie (composant partagé par la page /map et l'onglet « Cartographie » de la fiche application).
 *
 * - Données : /api/map pour les trois environnements d'un coup ; les zones affichées suivent le filtre
 *   d'environnements partagé (PRD et STG par défaut, DEV d'un clic), sans nouvel appel.
 * - États en direct : relève partagée (useLiveStatus) ; un rafraîchissement ne change que les couleurs,
 *   la disposition (Web Worker, ELK) n'est recalculée que si la structure change.
 * - Simulation : clic sur un ou plusieurs éléments, POST /api/simulate, éléments touchés en surbrillance,
 *   liste par type et export CSV.
 */
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeMouseHandler } from '@xyflow/react';
import { ImageDown, LoaderCircle, Maximize, Network, SearchX, Zap } from 'lucide-react';
import { ApiError, api, useApi, type Env, type MapData, type SimulateResult } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useLiveStatus } from '../lib/live';
import { useTheme } from '../lib/theme';
import { useEnvFilter } from '../lib/envFilter';
import { TONE_CLASSES, stateMeta } from '../lib/status';
import { cn } from '../lib/cn';
import { Button, EmptyState, ErrorState, Skeleton } from '../components/ui';
import { CheckToggle } from '../components/filters';
import { EnvFilter } from '../components/EnvFilter';
import { NODE_SIZE, buildGraph, envCounts, layoutInputOf, type MapFlowEdge, type MapFlowNode } from './buildGraph';
import { runLayout } from './layout';
import type { LayoutResult } from './layoutCore';
import { nodeTypes } from './nodes';
import { EdgeMarkers, edgeTypes } from './edges';
import { exportMapPng } from './exportPng';
import { downloadText, fileDate, simulationCsv } from './exportCsv';
import { DetailPanel, SimPanel } from './MapSidePanel';
import { MapLegend } from './MapLegend';

const ALL_ENVS: Env[] = ['PRD', 'STG', 'DEV'];

export interface MapViewProps {
  /** 'perimeter' ou `app:<id>` */
  scope: string;
  /** dans un onglet : carte moins haute */
  embedded?: boolean;
  /** éléments ajoutés en tête de la barre d'outils (sélecteur de périmètre de la page) */
  toolbarStart?: ReactNode;
  /** action proposée quand l'application demandée est introuvable */
  notFoundAction?: ReactNode;
}

export function MapView(props: MapViewProps) {
  return (
    <ReactFlowProvider>
      <MapViewInner {...props} />
    </ReactFlowProvider>
  );
}

/** Simulation : appel (différé et annulable) à chaque changement de sélection. */
function useSimulation(ids: string[], includeRetired: boolean) {
  const [state, setState] = useState<{ key: string; result: SimulateResult | null; error: Error | null; loading: boolean }>({ key: '', result: null, error: null, loading: false });
  const key = ids.length ? `${ids.join('|')}#${includeRetired}` : '';
  const idsRef = useRef(ids);
  idsRef.current = ids;
  useEffect(() => {
    if (!key) {
      setState({ key: '', result: null, error: null, loading: false });
      return undefined;
    }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(() => {
      api.simulate({ nodeIds: idsRef.current, includeRetired }, { signal: ctrl.signal }).then(
        (result) => setState({ key, result, error: null, loading: false }),
        (error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setState({ key, result: null, error: error instanceof Error ? error : new Error(String(error)), loading: false });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [key, includeRetired]);
  return state;
}

function MapViewInner({ scope, embedded = false, toolbarStart, notFoundAction }: MapViewProps) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const rf = useReactFlow();
  const [envFilter] = useEnvFilter();
  const [includeRetired, setIncludeRetired] = useState(false);
  const { data, error, loading, refreshing, reload } = useApi((signal) => api.map({ scope, envs: ALL_ENVS, includeRetired }, { signal }), [scope, includeRetired]);
  const { status: live } = useLiveStatus();

  const [simMode, setSimMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [pngBusy, setPngBusy] = useState(false);
  const [pngError, setPngError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelected([]);
    setFocus(null);
  }, [scope]);

  const sim = useSimulation(simMode ? selected : [], includeRetired);

  // états en direct (une minute) : remplacent ceux lus avec la carte
  const states = useMemo(() => {
    const s: Record<string, string> = {};
    for (const [id, v] of Object.entries(live?.servers ?? {})) s[id] = v.state;
    for (const [id, v] of Object.entries(live?.apps ?? {})) s[id] = v.state;
    return s;
  }, [live]);

  const impactedIds = useMemo(() => sim.result?.impacted.map((i) => i.id) ?? [], [sim.result]);
  const graph = useMemo(
    () =>
      data
        ? buildGraph(data, {
            envs: envFilter.envs,
            unspecified: envFilter.unspecified,
            simulate: simMode && selected.length ? { selected, impacted: impactedIds } : null,
            focus: simMode ? null : focus,
            states,
          })
        : null,
    [data, envFilter, simMode, selected, impactedIds, focus, states],
  );

  // ---- disposition (Web Worker), seulement quand la structure change ----
  const [layout, setLayout] = useState<{ key: string; result: LayoutResult } | null>(null);
  const [layoutError, setLayoutError] = useState<Error | null>(null);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const structureKey = graph?.structureKey ?? null;
  useEffect(() => {
    const g = graphRef.current;
    if (!g || structureKey === null) return undefined;
    let alive = true;
    setLayoutError(null);
    runLayout(structureKey, layoutInputOf(g)).then(
      (result) => alive && setLayout({ key: structureKey, result }),
      (err: unknown) => alive && setLayoutError(err instanceof Error ? err : new Error(String(err))),
    );
    return () => {
      alive = false;
    };
  }, [structureKey]);

  const lastFlow = useRef<{ nodes: MapFlowNode[]; edges: MapFlowEdge[] } | null>(null);
  const ready = !!graph && !!layout && layout.key === graph.structureKey;
  const flow = useMemo(() => {
    if (!ready || !graph || !layout) return lastFlow.current;
    const { positions, sizes } = layout.result;
    const nodes = graph.nodes.map((n) => {
      const size = n.type === 'zone' || n.type === 'band' || n.type === 'cluster' ? sizes[n.id] : NODE_SIZE[n.type as keyof typeof NODE_SIZE];
      return { ...n, position: positions[n.id] ?? { x: 0, y: 0 }, width: size?.w, height: size?.h } as MapFlowNode;
    });
    return { nodes, edges: graph.edges };
  }, [ready, graph, layout]);
  if (ready) lastFlow.current = flow;

  // recadrage à chaque nouvelle disposition
  const fittedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !layout || fittedKey.current === layout.key) return undefined;
    fittedKey.current = layout.key;
    const id = window.setTimeout(() => void rf.fitView({ padding: 0.06, duration: 250 }), 40);
    return () => window.clearTimeout(id);
  }, [ready, layout, rf]);

  // ---- interactions ----
  const onNodeClick: NodeMouseHandler<MapFlowNode> = useCallback(
    (_e, node) => {
      if (node.type === 'cluster') {
        // clic sur un groupe de serveurs : met en avant son application
        if (!simMode) setFocus(node.data.appId);
        return;
      }
      if (node.type === 'zone' || node.type === 'band') {
        if (!simMode) setFocus(null);
        return;
      }
      if (simMode) setSelected((sel) => (sel.includes(node.id) ? sel.filter((x) => x !== node.id) : [...sel, node.id]));
      else setFocus((f) => (f === node.id ? null : node.id));
    },
    [simMode],
  );
  const onPaneClick = useCallback(() => {
    if (!simMode) setFocus(null);
  }, [simMode]);

  const nodeById = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const nodeOf = useCallback((id: string) => nodeById.get(id), [nodeById]);
  const stateOf = useCallback((id: string) => states[id] ?? nodeById.get(id)?.state ?? null, [states, nodeById]);
  const onMap = useMemo(() => new Set((graph?.nodes ?? []).map((n) => n.id)), [graph]);

  const startSim = (ids: string[] = []) => {
    setSimMode(true);
    setSelected(ids);
    setFocus(null);
  };
  const exitSim = () => {
    setSimMode(false);
    setSelected([]);
  };

  const exportCsv = () => {
    if (!sim.result) return;
    const origins = selected.map((id) => ({ id, name: nodeById.get(id)?.label ?? id, type: nodeById.get(id)?.type ?? 'unknown' }));
    const nameOf = (id: string) => nodeById.get(id)?.label ?? sim.result?.impacted.find((i) => i.id === id)?.name ?? id;
    downloadText(simulationCsv(origins, sim.result, t, nameOf), `simulation-panne-${fileDate()}.csv`);
  };

  const exportPng = async () => {
    if (!containerRef.current || !layout) return;
    setPngBusy(true);
    setPngError(false);
    try {
      const name = scope === 'perimeter' ? 'perimetre' : (nodeById.get(scope.slice(4))?.label ?? 'application');
      const slug = name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
      await exportMapPng(containerRef.current, { x: 0, y: 0, width: layout.result.width, height: layout.result.height }, `cartographie-${slug}-${fileDate()}.png`);
    } catch {
      setPngError(true);
    } finally {
      setPngBusy(false);
    }
  };

  const counts = useMemo(() => envCounts(data), [data]);
  const focusNode = focus ? nodeById.get(focus) : undefined;
  const panelOpen = simMode || !!focusNode;
  const notFound = error instanceof ApiError && (error.status === 404 || error.status === 400);
  const canvasH = embedded ? 'h-[62dvh] min-h-[380px] lg:h-[560px]' : 'h-[64dvh] min-h-[400px] lg:h-[calc(100dvh-19rem)] lg:min-h-[520px]';

  const minimapColor = useCallback((n: Node) => {
    if (n.type === 'zone') return `var(--color-env-${String((n.data as { env: string }).env).toLowerCase()}-soft)`;
    if (n.type === 'band') return 'var(--color-surface-3)';
    if (n.type === 'cluster') return 'transparent';
    if (n.type === 'database') return 'var(--color-ink-3)';
    return `var(--color-${TONE_CLASSES[stateMeta((n.data as { state: string | null }).state).tone].dot.slice(3)})`;
  }, []);

  return (
    <section aria-label={t('map.aria')} className="overflow-hidden rounded-lg border border-line bg-surface">
      {/* barre d'outils */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2 sm:px-4">
        {toolbarStart}
        <EnvFilter counts={counts} />
        <CheckToggle checked={includeRetired} onChange={setIncludeRetired}>
          {t('map.showRetired')}
        </CheckToggle>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Button
            variant={simMode ? 'danger' : 'secondary'}
            icon={Zap}
            aria-pressed={simMode}
            onClick={() => (simMode ? exitSim() : startSim(focus ? [focus] : []))}
            className={cn(simMode && 'border-down bg-down-soft')}
          >
            {simMode ? t('map.sim.exit') : t('map.sim.toggle')}
          </Button>
          <Button icon={Maximize} iconOnly label={t('map.fit')} onClick={() => void rf.fitView({ padding: 0.06, duration: 250 })} disabled={!flow} />
          <Button icon={pngBusy ? LoaderCircle : ImageDown} label={t('map.exportPngTitle')} onClick={exportPng} disabled={!flow || pngBusy} className={cn(pngBusy && '[&>svg]:animate-spin')}>
            {t('map.exportPng')}
          </Button>
        </div>
        {pngError && (
          <p role="alert" className="w-full text-xs text-down">
            {t('map.exportPngError')}
          </p>
        )}
      </div>

      <div className={cn('flex flex-col lg:flex-row', panelOpen && 'lg:divide-x lg:divide-line')}>
        <div ref={containerRef} className={cn('relative w-full min-w-0 bg-canvas lg:flex-1', canvasH)}>
          {loading && !data ? (
            <div className="flex h-full items-center justify-center p-6">
              <Skeleton className="h-full w-full rounded-md" />
            </div>
          ) : notFound ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState icon={SearchX} title={t('map.notFound')} text={t('map.notFoundText')} action={notFoundAction} />
            </div>
          ) : error && !data ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={reload} retrying={refreshing} />
            </div>
          ) : data && data.nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState icon={Network} title={t('map.empty')} text={t('map.emptyText')} />
            </div>
          ) : (
            <ReactFlow
              nodes={flow?.nodes ?? []}
              edges={flow?.edges ?? []}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              colorMode={theme}
              zIndexMode="manual"
              minZoom={0.08}
              maxZoom={2.5}
              fitView
              fitViewOptions={{ padding: 0.06 }}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              selectionKeyCode={null}
              multiSelectionKeyCode={null}
              deleteKeyCode={null}
              zoomOnDoubleClick={false}
              attributionPosition="top-right"
              style={{ background: 'var(--color-canvas)' }}
              aria-label={t('map.aria')}
            >
              <EdgeMarkers />
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--color-line-strong)" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                ariaLabel={t('map.minimap')}
                nodeColor={minimapColor}
                nodeStrokeWidth={0}
                nodeBorderRadius={6}
                maskColor={theme === 'dark' ? 'rgb(8 11 15 / 0.62)' : 'rgb(240 243 247 / 0.7)'}
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-line)', borderRadius: 8, width: 156, height: 100 }}
                className="max-sm:!hidden"
              />
              {(!ready || layoutError) && (
                <Panel position="top-center">
                  <span role="status" className={cn('inline-flex items-center gap-2 rounded-full border bg-surface px-3 py-1 text-xs shadow-pop', layoutError ? 'border-down/40 text-down' : 'border-line text-ink-2')}>
                    {!layoutError && <LoaderCircle aria-hidden size={13} className="animate-spin" />}
                    {layoutError ? t('map.layoutError') : t('map.layouting')}
                  </span>
                </Panel>
              )}
              {simMode && ready && (
                <Panel position="top-left" className="!m-2 max-w-[calc(100%-1rem)] lg:hidden">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-down/40 bg-surface px-2.5 py-1 text-2xs text-ink-2 shadow-pop">
                    <Zap aria-hidden size={12} className="text-down" />
                    {t('map.sim.selected', { n: selected.length })}
                    {sim.result && ` · ${t('map.sim.impacted', { n: sim.result.impacted.length })}`}
                  </span>
                </Panel>
              )}
            </ReactFlow>
          )}
        </div>

        {panelOpen && data && (
          <aside className={cn('w-full shrink-0 border-t border-line bg-surface max-lg:max-h-[70dvh] lg:w-[340px] lg:border-t-0', embedded ? 'lg:h-[560px]' : 'lg:h-[calc(100dvh-19rem)] lg:min-h-[520px]')}>
            {simMode ? (
              <SimPanel
                selected={selected}
                nodeOf={nodeOf}
                stateOf={stateOf}
                onMap={onMap}
                result={sim.key ? sim.result : null}
                loading={sim.loading}
                error={sim.error}
                includeRetired={includeRetired}
                onRemove={(id) => setSelected((s) => s.filter((x) => x !== id))}
                onClear={() => setSelected([])}
                onExport={exportCsv}
                onExit={exitSim}
              />
            ) : focusNode ? (
              <DetailPanel node={focusNode} state={stateOf(focusNode.id)} map={data as MapData} scope={scope} onClose={() => setFocus(null)} onSimulate={() => startSim([focusNode.id])} />
            ) : null}
          </aside>
        )}
      </div>

      <MapLegend simulation={simMode} />
    </section>
  );
}
