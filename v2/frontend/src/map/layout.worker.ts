/**
 * Web Worker de disposition : calcule les positions de la carte hors du fil de l'interface.
 * Message reçu : { id, input: LayoutInput } ; réponse : { id, result } ou { id, error }.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import { computeLayout } from './layoutCore';
import type { LayoutInput } from './buildGraph';

const elk = new ELK();
const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };

// la version groupée d'elkjs s'inscrit elle-même sur onmessage quand elle tourne dans un worker :
// on remplace ce gestionnaire par le nôtre (affectation faite après le chargement du module)
scope.onmessage = (e: MessageEvent<{ id: number; input: LayoutInput }>) => {
  const { id, input } = e.data;
  computeLayout(input, elk).then(
    (result) => scope.postMessage({ id, result }),
    (err: unknown) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
};
