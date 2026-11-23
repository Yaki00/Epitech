/**
 * Export de la carte entière en image PNG (html-to-image), quel que soit le zoom à l'écran :
 * la vue est redessinée hors écran à l'échelle de l'image, sur le fond du thème courant.
 */
import { toPng } from 'html-to-image';
import { getViewportForBounds, type Rect } from '@xyflow/react';

/** Côté maximal de l'image (px) : au-delà, certains navigateurs refusent de créer le canevas. */
const MAX_SIDE = 7000;

export async function exportMapPng(container: HTMLElement, bounds: Rect, filename: string): Promise<void> {
  const viewport = container.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport) throw new Error('viewport');
  const pad = 48;
  const scale = Math.min(2, MAX_SIDE / Math.max(bounds.width + 2 * pad, bounds.height + 2 * pad));
  const width = Math.round((bounds.width + 2 * pad) * scale);
  const height = Math.round((bounds.height + 2 * pad) * scale);
  const vp = getViewportForBounds(bounds, width, height, 0.01, 4, `${Math.round(pad * scale)}px`);
  const background = getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim() || '#ffffff';
  const dataUrl = await toPng(viewport, {
    backgroundColor: background,
    width,
    height,
    pixelRatio: 1,
    skipFonts: true,
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
  });
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
