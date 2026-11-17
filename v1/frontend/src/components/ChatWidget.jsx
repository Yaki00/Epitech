import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { ChatIcon, CloseIcon, SendIcon } from './Icons';

const SUGGESTIONS = ['Que se passe-t-il si srvalto01 redémarre ?', 'Sur quels serveurs tourne ALTO ?', 'Quelles applis utilisent la base ORA_ALTO ?'];

const TOOL_LABELS = { search_entities: 'recherche', impact_analysis: "analyse d'impact", dependencies: 'dépendances' };

/** Bulle de chat flottante (bas droite) reliée à POST /api/ask. */
export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    // bloc explicite : les navigateurs récents renvoient une Promise depuis scrollIntoView
    endRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages, busy]);

  async function send(text) {
    const question = text.trim();
    if (!question || busy) return;
    const history = messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: 'user', content: question }]);
    setInput('');
    setBusy(true);
    try {
      const r = await api.ask(question, history);
      setMessages((m) => [...m, { role: 'assistant', content: r.answer, tools: r.toolTrace }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', content: err.message, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {open && (
        <div className="fixed bottom-28 right-8 z-40 flex h-[560px] w-[420px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-200 bg-blue-600 px-5 py-4 text-white">
            <div>
              <div className="font-semibold">Assistant Lyra</div>
              <div className="text-xs text-blue-100">Réponses basées sur le graphe d'infrastructure</div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Fermer" className="rounded-lg p-1 hover:bg-blue-500">
              <CloseIcon />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {!messages.length && (
              <div className="space-y-2">
                <div className="text-sm text-slate-500">Posez une question sur une application, un serveur ou une IP :</div>
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="block w-full rounded-xl border border-slate-200 px-3 py-2 text-left text-sm text-slate-700 hover:border-blue-300 hover:bg-blue-50">
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm ${
                    m.role === 'user' ? 'bg-blue-600 text-white' : m.error ? 'border border-red-200 bg-red-50 text-red-800' : 'bg-slate-100 text-slate-800'
                  }`}
                >
                  {m.content}
                  {m.tools?.length > 0 && (
                    <div className="mt-2 border-t border-slate-200 pt-1.5 text-xs text-slate-500">
                      Sources : {m.tools.map((t) => TOOL_LABELS[t.tool] || t.tool).join(', ')}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex gap-1 px-2 py-2">
                {[0, 150, 300].map((d) => (
                  <span key={d} className="h-2 w-2 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 border-t border-slate-200 p-3"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Votre question…"
              className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
            <button type="submit" disabled={busy || !input.trim()} aria-label="Envoyer" className="rounded-xl bg-blue-600 p-2.5 text-white hover:bg-blue-700 disabled:opacity-40">
              <SendIcon width={18} height={18} />
            </button>
          </form>
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Ouvrir l'assistant"
        className="fixed bottom-8 right-8 z-40 flex h-16 w-16 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-600/30 transition hover:bg-blue-700"
      >
        {open ? <CloseIcon width={26} height={26} /> : <ChatIcon width={26} height={26} />}
      </button>
    </>
  );
}
