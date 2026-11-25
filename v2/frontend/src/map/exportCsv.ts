/**
 * Export CSV de la simulation de panne (Excel : séparateur « ; », BOM UTF-8, fins de ligne CRLF,
 * comme les rapports du serveur). Une cellule qui commence par = + - @ est préfixée d'une apostrophe
 * pour qu'Excel ne l'exécute pas comme une formule.
 */
import type { SimulateResult } from '../lib/api';
import type { TFunction } from '../lib/i18n';

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export interface SimOrigin {
  id: string;
  name: string;
  type: string;
}

/** Lignes : d'abord les éléments choisis (niveau 0), puis les éléments touchés par niveau. */
export function simulationCsv(origins: readonly SimOrigin[], result: SimulateResult, t: TFunction, nameOf: (id: string) => string): string {
  const typeLabel = (type: string) => t(`type.${['application', 'server', 'database', 'document'].includes(type) ? type : 'unknown'}` as 'type.server');
  const header = [t('map.csv.role'), t('map.csv.type'), t('map.csv.name'), t('map.csv.id'), t('map.csv.depth'), t('map.csv.via'), t('map.csv.link'), t('map.csv.source'), t('map.csv.confidence')];
  const rows: unknown[][] = [header];
  for (const o of origins) rows.push([t('map.csv.origin'), typeLabel(o.type), o.name, o.id, 0, '', '', '', '']);
  for (const i of result.impacted) {
    rows.push([
      t('map.csv.impacted'),
      typeLabel(i.type),
      i.name,
      i.id,
      i.depth,
      i.via ? nameOf(i.via.from) : '',
      i.via ? t(`map.edge.${i.via.edgeType}` as 'map.edge.calls') : '',
      i.via?.source ?? '',
      i.via ? Math.round(i.via.confidence * 100) : '',
    ]);
  }
  return toCsv(rows);
}

/** Fait télécharger un texte (CSV) au navigateur. */
export function downloadText(text: string, filename: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Date du jour pour les noms de fichiers (AAAA-MM-JJ, heure locale). */
export function fileDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
