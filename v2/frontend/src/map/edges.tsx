/**
 * Liens de la cartographie, stylés par type :
 * - hébergement (application vers serveur) : trait fin à la couleur de l'environnement du serveur ;
 * - appel entre applications : trait plein avec flèche ;
 * - accès base : pointillés ronds avec flèche ;
 * - lien retiré : tirets gris ;
 * - lien à valider : pointillés courts à la couleur d'alerte ;
 * - lien ancien ou cible : trait gris estompé.
 * En simulation, les liens entre éléments touchés passent en couleur d'accent, les autres s'effacent.
 */
import { memo } from 'react';
import { BaseEdge, ViewportPortal, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { EdgeData, MapFlowEdge } from './buildGraph';
import type { EnvKey } from '../lib/status';

const ENV_STROKE: Record<EnvKey, string> = {
  PRD: 'var(--color-env-prd)',
  STG: 'var(--color-env-stg)',
  DEV: 'var(--color-env-dev)',
  none: 'var(--color-env-none)',
};

export interface EdgeLook {
  stroke: string;
  width: number;
  dash?: string;
  opacity: number;
  marker?: 'calls' | 'uses_db' | 'hot';
}

/** Apparence d'un lien (utilisée aussi par la légende). */
export function edgeLook(d: Pick<EdgeData, 'type' | 'retired' | 'mark' | 'env' | 'hot' | 'dim'>): EdgeLook {
  let look: EdgeLook;
  if (d.type === 'calls') look = { stroke: 'var(--color-ink-2)', width: 1.75, opacity: 0.9, marker: 'calls' };
  else if (d.type === 'uses_db') look = { stroke: 'var(--color-ink-3)', width: 1.6, dash: '0.5 4.5', opacity: 0.95, marker: 'uses_db' };
  else look = { stroke: ENV_STROKE[d.env ?? 'none'], width: 1.2, opacity: 0.42 };
  const mark = d.mark === undefined ? (d.retired ? 'retired' : null) : d.mark;
  if (mark === 'toValidate' || mark === 'otherApp') look = { ...look, stroke: 'var(--color-warn)', dash: '3 4', opacity: 0.85 };
  else if (mark === 'past' || mark === 'target') look = { ...look, stroke: 'var(--color-unmon)', opacity: 0.4 };
  else if (mark) look = { ...look, stroke: 'var(--color-unmon)', dash: '7 5', opacity: 0.55 };
  if (d.hot) look = { ...look, stroke: 'var(--color-accent)', width: look.width + 1, opacity: 1, marker: look.marker ? 'hot' : undefined };
  if (d.dim) look = { ...look, opacity: 0.07 };
  return look;
}

export const LyraEdge = memo(function LyraEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<MapFlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.3 });
  const look = edgeLook(data ?? { type: 'runs_on', retired: false });
  return (
    <BaseEdge
      id={id}
      path={path}
      interactionWidth={0}
      markerEnd={look.marker ? `url(#lyra-arrow-${look.marker})` : undefined}
      style={{
        stroke: look.stroke,
        strokeWidth: look.width,
        strokeDasharray: look.dash,
        strokeLinecap: look.dash?.startsWith('0.5') ? 'round' : undefined,
        opacity: look.opacity,
        transition: 'opacity 200ms, stroke 200ms',
      }}
    />
  );
});

export const edgeTypes = { lyra: LyraEdge };

/** Pointes de flèche, placées dans la vue (incluses dans l'export PNG). */
export function EdgeMarkers() {
  const marker = (id: string, fill: string) => (
    <marker key={id} id={`lyra-arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
      <path d="M0,1 L10,5 L0,9 z" style={{ fill }} />
    </marker>
  );
  return (
    <ViewportPortal>
      <svg aria-hidden width="0" height="0" style={{ position: 'absolute', overflow: 'hidden' }}>
        <defs>
          {marker('calls', 'var(--color-ink-2)')}
          {marker('uses_db', 'var(--color-ink-3)')}
          {marker('hot', 'var(--color-accent)')}
        </defs>
      </svg>
    </ViewportPortal>
  );
}
