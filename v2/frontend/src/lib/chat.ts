/**
 * Logique pure de l'assistant : réponse simulée du mode démo, liens dans le texte, entités consultées
 * par l'assistant (outils appelés) et historique envoyé au serveur.
 */
import type { ChatTurn } from './api';
import { nodeType } from './applications';

/** Préfixe des réponses de l'assistant simulé (mode démo). */
export const DEMO_PREFIX = '[démo]';

/** Retire le préfixe « [démo] » et dit si la réponse est simulée. */
export function parseAnswer(text: string): { demo: boolean; text: string } {
  const trimmed = text.trimStart();
  if (trimmed.startsWith(DEMO_PREFIX)) return { demo: true, text: trimmed.slice(DEMO_PREFIX.length).trimStart() };
  return { demo: false, text };
}

export type TextPart = { kind: 'text'; value: string } | { kind: 'url'; value: string } | { kind: 'entity'; value: string; id: string };

const URL_RE = /https?:\/\/[^\s<>"'()[\]]+/g;

/** Découpe un texte en morceaux et adresses web (sans la ponctuation finale). */
export function linkifyParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const trail = /[.,;:!?]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    const start = m.index ?? 0;
    if (start > last) parts.push({ kind: 'text', value: text.slice(last, start) });
    parts.push({ kind: 'url', value: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Découpe une réponse en texte, adresses web et noms d'entités connues (applications...), pour les rendre
 * cliquables. Nom reconnu en entier seulement (pas au milieu d'un mot), le plus long d'abord ; 3 caractères minimum.
 */
export function splitAnswer(text: string, entities: readonly { id: string; name: string }[] = []): TextPart[] {
  const byName = new Map<string, string>();
  for (const e of entities) if (e.name && e.name.trim().length >= 3 && !byName.has(e.name)) byName.set(e.name, e.id);
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const re = names.length ? new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_-])`, 'gu') : null;
  const out: TextPart[] = [];
  for (const part of linkifyParts(text)) {
    if (part.kind !== 'text' || !re) {
      out.push(part);
      continue;
    }
    let last = 0;
    for (const m of part.value.matchAll(re)) {
      const start = m.index ?? 0;
      if (start > last) out.push({ kind: 'text', value: part.value.slice(last, start) });
      out.push({ kind: 'entity', value: m[0], id: byName.get(m[0]) ?? '' });
      last = start + m[0].length;
    }
    if (last < part.value.length) out.push({ kind: 'text', value: part.value.slice(last) });
  }
  return out;
}

export interface TraceEntity {
  id: string;
  type: 'application' | 'server';
}

/**
 * Applications et serveurs consultés par l'assistant (arguments `id` des outils appelés), sans doublon,
 * dans l'ordre d'appel. Les autres types (bases, documents) n'ont pas de fiche.
 */
export function traceEntities(toolTrace: unknown): TraceEntity[] {
  if (!Array.isArray(toolTrace)) return [];
  const out: TraceEntity[] = [];
  const seen = new Set<string>();
  for (const step of toolTrace) {
    const args = step && typeof step === 'object' ? (step as { args?: unknown }).args : null;
    const id = args && typeof args === 'object' ? (args as { id?: unknown }).id : null;
    if (typeof id !== 'string' || seen.has(id)) continue;
    const type = nodeType(id);
    if (type !== 'application' && type !== 'server') continue;
    seen.add(id);
    out.push({ id, type });
  }
  return out;
}

/** Noms des outils appelés, sans doublon. */
export function traceTools(toolTrace: unknown): string[] {
  if (!Array.isArray(toolTrace)) return [];
  const names = toolTrace.map((s) => (s && typeof s === 'object' ? (s as { tool?: unknown }).tool : null)).filter((n): n is string => typeof n === 'string');
  return [...new Set(names)];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

/** Historique envoyé au serveur : sans les messages d'erreur, au plus `max` derniers tours. */
export function historyOf(messages: readonly ChatMessage[], max = 12): ChatTurn[] {
  return messages
    .filter((m) => !m.error)
    .slice(-max)
    .map(({ role, content }) => ({ role, content }));
}
