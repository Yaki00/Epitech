/**
 * Bulle de l'assistant (bas droite, toutes les pages) reliée à POST /api/ask.
 * - Conversation gardée en mémoire tant que la page n'est pas rechargée (rien n'est enregistré).
 * - Entrée envoie, Maj+Entrée va à la ligne ; Échap ferme ; le focus revient sur la bulle.
 * - Réponses : retours à la ligne gardés, adresses web et noms d'applications cliquables, fiches consultées
 *   par l'assistant ; en démo, badge « Réponse simulée » (réponse qui commence par « [démo] »).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { AppWindow, ExternalLink, FlaskConical, MessageSquare, RotateCcw, SendHorizontal, Server, X } from 'lucide-react';
import { ApiError, api, type AskResult } from '../lib/api';
import { useI18n, type Key } from '../lib/i18n';
import { useConfig } from '../lib/config';
import { historyOf, parseAnswer, splitAnswer, traceEntities, traceTools, type ChatMessage } from '../lib/chat';
import { nodeLabel } from '../lib/applications';
import { appHref, serverHref } from '../lib/links';
import { cn } from '../lib/cn';
import { Badge } from './ui';
import { KnowledgeBadges } from './KnowledgeBadges';
import { sourceView, type SourceItem } from '../lib/knowledge';
import { formatDate } from '../lib/format';

interface Message extends ChatMessage {
  toolTrace?: AskResult['toolTrace'];
  sources?: SourceItem[];
}

interface Examples {
  app: string | null;
  server: string | null;
  apps: { id: string; name: string }[];
}

/** Applications connues (liens dans les réponses) et exemples de questions tirés du graphe. */
async function loadExamples(): Promise<Examples> {
  const [apps, servers] = await Promise.all([api.applications(), api.servers(undefined, 1)]);
  const live = apps.filter((a) => !a.retired);
  const app = live.find((a) => a.inPerimeter && a.servers > 0) ?? live[0];
  return { app: app?.name ?? null, server: servers[0]?.name ?? null, apps: live.map((a) => ({ id: a.id, name: a.name })) };
}

/** Le serveur préfixe son erreur 502 par « IA indisponible : » ; le préfixe est réécrit dans la langue choisie. */
const stripUnavailable = (msg: string) => msg.replace(/^IA indisponible\s*:\s*/i, '');

export function Chat() {
  const { t, lang } = useI18n();
  const { config } = useConfig();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [examples, setExamples] = useState<Examples | null>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // chaque nouvelle conversation ignore les réponses encore attendues de la précédente
  const generation = useRef(0);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => {
    if (open && !examples) loadExamples().then(setExamples, () => setExamples({ app: null, server: null, apps: [] }));
  }, [open, examples]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, busy, open]);

  const close = useCallback(() => {
    setOpen(false);
    bubbleRef.current?.focus();
  }, []);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    const history = historyOf(messages);
    const gen = generation.current;
    setMessages((m) => [...m, { role: 'user', content: question }]);
    setInput('');
    setBusy(true);
    try {
      const r = await api.ask(question, history, lang);
      if (gen !== generation.current) return;
      setMessages((m) => [...m, { role: 'assistant', content: r.answer, toolTrace: r.toolTrace, sources: Array.isArray(r.sources) ? r.sources : [] }]);
    } catch (err) {
      if (gen !== generation.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      const content = err instanceof ApiError && err.status === 502 ? `${t('chat.unavailable')}${t('common.colon')} ${stripUnavailable(msg)}` : msg;
      setMessages((m) => [...m, { role: 'assistant', content, error: true }]);
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  };

  const reset = () => {
    generation.current += 1;
    setMessages([]);
    setBusy(false);
    inputRef.current?.focus();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  const onInputKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };
  const onPanelKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  const server = examples?.server || t('chat.q.genericServer');
  const app = examples?.app || t('chat.q.genericApp');
  const suggestions = examples ? [t('chat.q.depends', { app }), t('chat.q.needs', { app }), t('chat.q.restart', { server })] : [];
  const appNames = useMemo(() => new Map((examples?.apps ?? []).map((a) => [a.id, a.name])), [examples]);

  return (
    <>
      {open && (
        <section
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={onPanelKey}
          className="fixed inset-x-2 bottom-20 z-40 flex h-[min(72dvh,600px)] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-pop sm:inset-x-auto sm:right-6 sm:bottom-22 sm:w-[420px]"
        >
          <header className="flex items-start gap-2 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
                {t('chat.title')}
                {config?.demo && (
                  <Badge tone="accent" icon={FlaskConical}>
                    {t('chat.demoNote')}
                  </Badge>
                )}
              </h2>
              <p className="text-xs text-ink-3">{t('chat.subtitle')}</p>
            </div>
            {messages.length > 0 && (
              <button type="button" onClick={reset} aria-label={t('chat.reset')} title={t('chat.reset')} className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink">
                <RotateCcw aria-hidden size={16} />
              </button>
            )}
            <button type="button" onClick={close} aria-label={t('chat.close')} title={t('chat.close')} className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink">
              <X aria-hidden size={16} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-ink-2">{t('chat.intro')}</p>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="rounded-md border border-line px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            <ol aria-live="polite" aria-label={t('chat.conversation')} className="flex flex-col gap-3">
              {messages.map((m, i) => (
                <MessageItem key={i} message={m} appNames={appNames} />
              ))}
            </ol>
            {busy && (
              <div role="status" className="mt-3 flex items-center gap-1 px-1">
                {[0, 150, 300].map((d) => (
                  <span key={d} aria-hidden className="size-1.5 animate-bounce rounded-full bg-ink-3" style={{ animationDelay: `${d}ms` }} />
                ))}
                <span className="sr-only">{t('chat.thinking')}</span>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-line p-3">
            <label htmlFor={`${panelId}-input`} className="sr-only">
              {t('chat.placeholder')}
            </label>
            <textarea
              id={`${panelId}-input`}
              ref={inputRef}
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onInputKey}
              placeholder={t('chat.placeholder')}
              title={t('chat.hint')}
              className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-line-strong bg-surface px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-3 focus-visible:border-accent"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label={t('chat.send')}
              title={t('chat.send')}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-ink hover:bg-accent-hover disabled:opacity-40"
            >
              <SendHorizontal aria-hidden size={16} />
            </button>
          </form>
        </section>
      )}

      <button
        ref={bubbleRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={open ? t('chat.close') : t('chat.open')}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={open ? t('chat.close') : t('chat.open')}
        className="fixed right-4 bottom-4 z-40 inline-flex size-12 items-center justify-center rounded-full bg-accent text-accent-ink shadow-pop transition-colors hover:bg-accent-hover sm:right-6 sm:bottom-6"
      >
        {open ? <X aria-hidden size={22} /> : <MessageSquare aria-hidden size={22} />}
      </button>
    </>
  );
}

function MessageItem({ message: m, appNames }: { message: Message; appNames: Map<string, string> }) {
  const { t, lang } = useI18n();
  if (m.role === 'user') {
    return (
      <li className="flex justify-end">
        <p className="max-w-[85%] rounded-lg bg-accent px-3 py-2 text-[13px] whitespace-pre-wrap text-accent-ink">
          <span className="sr-only">{t('chat.you')}{t('common.colon')} </span>
          {m.content}
        </p>
      </li>
    );
  }
  if (m.error) {
    return (
      <li className="flex justify-start">
        <p role="alert" className="max-w-[90%] rounded-lg border border-down/30 bg-down-soft px-3 py-2 text-[13px] break-words whitespace-pre-wrap text-ink">
          {m.content}
        </p>
      </li>
    );
  }
  const { demo, text } = parseAnswer(m.content);
  const entities = traceEntities(m.toolTrace);
  const sources = m.sources ?? [];
  const tools = traceTools(m.toolTrace);
  const known = [...appNames].map(([id, name]) => ({ id, name }));
  return (
    <li className="flex justify-start">
      <div className="max-w-[90%] rounded-lg bg-surface-3 px-3 py-2 text-[13px] text-ink">
        <span className="sr-only">{t('chat.assistant')}{t('common.colon')} </span>
        {demo && (
          <div className="mb-1">
            <Badge tone="accent" icon={FlaskConical} title={t('chat.simulatedTitle')}>
              {t('chat.simulated')}
            </Badge>
          </div>
        )}
        <p className="break-words whitespace-pre-wrap">
          {splitAnswer(text, known).map((p, i) =>
            p.kind === 'url' ? (
              <a key={i} href={p.value} target="_blank" rel="noreferrer noopener" className="link break-all">
                {p.value}
              </a>
            ) : p.kind === 'entity' ? (
              <Link key={i} to={appHref(p.id)} className="link">
                {p.value}
              </Link>
            ) : (
              <span key={i}>{p.value}</span>
            ),
          )}
        </p>
        {sources.length > 0 && (
          <div className="mt-2 border-t border-line pt-1.5">
            <p className="text-2xs text-ink-3">{t('knowledge.sources')}</p>
            <ul className="mt-1 flex flex-col gap-1.5">
              {sources.map((s, idx) => {
                const v = sourceView(s);
                const body = (
                  <>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge>{t(v.kindKey)}</Badge>
                      <KnowledgeBadges flags={s} />
                    </span>
                    <span className="mt-0.5 flex items-start gap-1 font-medium">
                      <span className="min-w-0 break-words">{v.title}</span>
                      {v.url && <ExternalLink aria-hidden size={12} className="mt-0.5 shrink-0" />}
                    </span>
                    {(v.apps.length > 0 || v.date) && (
                      <span className="mt-0.5 block text-2xs text-ink-3">{[v.apps.join(t('common.listSep')), v.date ? formatDate(v.date, lang) : ''].filter(Boolean).join(' · ')}</span>
                    )}
                  </>
                );
                const cls = 'block rounded-md border border-line bg-surface px-2 py-1.5 text-xs';
                return (
                  <li key={s.id ? `${s.id}:${idx}` : idx}>
                    {v.url ? (
                      <a href={v.url} target="_blank" rel="noopener noreferrer" className={cn(cls, 'text-accent hover:border-accent/50')}>
                        {body}
                      </a>
                    ) : (
                      <div className={cn(cls, 'text-ink')}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {entities.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-1.5">
            <span className="text-2xs text-ink-3">{t('chat.entities')}</span>
            {entities.map((e) => {
              const Icon = e.type === 'application' ? AppWindow : Server;
              const name = e.type === 'application' ? (appNames.get(e.id) ?? nodeLabel(e.id, undefined)) : nodeLabel(e.id, undefined);
              return (
                <Link
                  key={e.id}
                  to={e.type === 'application' ? appHref(e.id) : serverHref(e.id)}
                  className={cn('inline-flex h-6 max-w-full items-center gap-1 rounded-sm border border-line bg-surface px-1.5 text-xs text-accent hover:border-accent/50', e.type === 'server' && 'font-mono')}
                >
                  <Icon aria-hidden size={12} className="shrink-0" />
                  <span className="truncate">{name}</span>
                </Link>
              );
            })}
          </div>
        )}
        {tools.length > 0 && (
          <p className="mt-1.5 text-2xs text-ink-3">
            {t('chat.sources')}
            {t('common.colon')} {tools.map((x) => { const key = `chat.tool.${x}` as Key; const label = t(key); return label === key ? x : label; }).join(', ')}
          </p>
        )}
      </div>
    </li>
  );
}
