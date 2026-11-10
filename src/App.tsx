import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ArrowUpRight,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Database,
  Globe2,
  History,
  LoaderCircle,
  Menu,
  MessageCircle,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { AgentEvent, AppConfig, Conversation, Source, Turn } from '../shared/types';
import { api, readEvents } from './api';
import { Answer } from './Answer';

const EXAMPLES = [
  {
    icon: History,
    label: 'Pick up where we left off',
    text: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    short: 'Did anything change with our CRM shortlist?',
  },
  {
    icon: Clock3,
    label: 'Revisit an earlier answer',
    text: 'What did I ask you on 3 November? Is your answer still correct today?',
    short: 'Is your answer from last week still correct?',
  },
  {
    icon: Database,
    label: 'Check what changed',
    text: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    short: 'Has Postgres hosting pricing changed?',
  },
];
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`mark ${small ? 'small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <path d="M11 13h13a6 6 0 0 1 0 12h-8a4 4 0 0 1 0-8h9M20 8v24" />
      </svg>
    </span>
  );
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [chats, setChats] = useState<Conversation[]>([]);
  const [chat, setChat] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState<{ turn: Turn; sourceId?: string; memory?: boolean } | null>(
    null,
  );
  const [setup, setSetup] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const loadSequence = useRef(0);

  useEffect(() => {
    // Establish the identity cookie before loading owner-scoped resources.
    api<AppConfig>('/api/config')
      .then(async (value) => {
        setConfig(value);
        setChats(await api<Conversation[]>('/api/conversations'));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ behavior: 'instant' });
  }, [turns, status]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = 'auto';
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`;
    }
  }, [draft]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPanel(null);
        setSetup(false);
        setSidebar(false);
        setDeleteId(null);
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  useEffect(() => {
    if (!setup && !deleteId && !panel) return;
    const overlay = document.querySelector<HTMLElement>('[role="dialog"], .evidence-panel');
    if (!overlay) return;
    const previous = document.activeElement as HTMLElement | null;
    const background = [...document.querySelectorAll<HTMLElement>('.main, .sidebar')];
    background.forEach((element) => {
      element.inert = true;
    });
    const focusable = () => [
      ...overlay.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input, textarea, [tabindex="0"]',
      ),
    ];
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    overlay.addEventListener('keydown', trap);
    return () => {
      overlay.removeEventListener('keydown', trap);
      background.forEach((element) => {
        element.inert = false;
      });
      previous?.focus();
    };
  }, [setup, deleteId, panel]);

  const refreshChats = async () => setChats(await api<Conversation[]>('/api/conversations'));
  const openChat = async (id: string) => {
    if (busy) return;
    const sequence = ++loadSequence.current;
    try {
      const value = await api<{ conversation: Conversation; turns: Turn[] }>(
        `/api/conversations/${id}`,
      );
      if (sequence !== loadSequence.current) return;
      setChat(value.conversation);
      setTurns(value.turns);
      setError('');
      setSidebar(false);
      setPanel(null);
      setDraft('');
      follow.current = true;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const newChat = () => {
    if (busy) return;
    loadSequence.current++;
    setChat(null);
    setTurns([]);
    setDraft('');
    setError('');
    setPanel(null);
    setSidebar(false);
    textarea.current?.focus();
  };
  const walkthrough = async () => {
    if (busy) return;
    try {
      const value = await api<Conversation>('/api/demo', { method: 'POST' });
      await refreshChats();
      await openChat(value.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const removeChat = async (id: string) => {
    try {
      await api(`/api/conversations/${id}`, { method: 'DELETE' });
      setDeleteId(null);
      if (chat?.id === id) newChat();
      await refreshChats();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const send = async (message = draft) => {
    if (!message.trim() || busy) return;
    if (!config?.live && !chat?.demo) {
      setSetup(true);
      return;
    }
    setBusy(true);
    setError('');
    setDraft('');
    setStatus('Connecting');
    setPanel(null);
    follow.current = true;
    const abort = new AbortController();
    controller.current = abort;
    let current = chat;
    let id = '';
    let completed = false;
    try {
      if (!current) {
        current = await api<Conversation>('/api/conversations', { method: 'POST' });
        setChat(current);
      }
      id = crypto.randomUUID();
      const pending: Turn = {
        id,
        conversationId: current.id,
        question: message.trim(),
        answer: '',
        createdAt: new Date().toISOString(),
        status: 'pending',
        sources: [],
        memory: [],
        searches: [],
        warnings: [],
        stats: null,
      };
      setTurns((prev) => [...prev, pending]);
      const update = (fn: (turn: Turn) => Turn) =>
        setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));
      const onEvent = (event: AgentEvent) => {
        switch (event.type) {
          case 'status':
            setStatus(event.message);
            break;
          case 'delta':
            update((t) => ({ ...t, answer: t.answer + event.text }));
            break;
          case 'answer':
            update((t) => ({ ...t, answer: event.text }));
            break;
          case 'sources':
            update((t) => ({ ...t, sources: event.sources }));
            break;
          case 'memory':
            update((t) => ({ ...t, memory: event.references }));
            if (event.note) setStatus(event.note);
            break;
          case 'search':
            update((t) => ({
              ...t,
              searches: [...t.searches.filter((s) => s.query !== event.search.query), event.search],
            }));
            setStatus(
              event.search.status === 'searching'
                ? `Searching · ${event.search.query}`
                : 'Reading the evidence',
            );
            break;
          case 'warning':
            update((t) => ({ ...t, warnings: [...t.warnings, event.message] }));
            break;
          case 'error':
            setError(event.message);
            break;
          case 'done':
            completed = true;
            update(() => event.turn);
            break;
        }
      };
      const response = await fetch(`/api/conversations/${current.id}/turns`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, message: message.trim(), timezone }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || 'Request failed.');
      }
      if (!response.body) throw new Error('Streaming is unavailable in this browser.');
      await readEvents(response.body, onEvent);
      if (!completed)
        throw new Error(
          'The connection ended before the response was saved. Reopen the conversation to check its status.',
        );
    } catch (e) {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id && t.status === 'pending'
            ? { ...t, answer: '', status: abort.signal.aborted ? 'cancelled' : 'failed' }
            : t,
        ),
      );
      if (!abort.signal.aborted) {
        setError((e as Error).message);
        setDraft(message);
      }
    } finally {
      controller.current = null;
      setBusy(false);
      setStatus('');
      await refreshChats().catch(() => {});
      textarea.current?.focus();
    }
  };
  const copy = async (turn: Turn) => {
    try {
      await navigator.clipboard.writeText(turn.answer);
      setCopied(turn.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Clipboard access was unavailable. You can select and copy the answer.');
    }
  };
  const activeTurn = turns.findLast((t) => t.status === 'pending');
  const panelTurn = panel ? (turns.find((t) => t.id === panel.turn.id) ?? panel.turn) : null;

  const google = config?.model.startsWith('gemini-');
  const modelProvider =
    config?.provider === 'agentrouter' ? 'AgentRouter' : google ? 'Google Gemini' : 'OpenAI';
  return (
    <div className="app-shell">
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? 'is-open' : ''}`}>
        <button className="brand" onClick={newChat} aria-label="Thread home">
          <Mark />
          <span>
            thread<span className="brand-dot">.</span>
          </span>
        </button>
        <button className="new-chat" onClick={newChat} disabled={busy}>
          <Plus size={17} /> New conversation <span>↗</span>
        </button>
        <div className="sidebar-section">
          YOUR CONVERSATIONS{' '}
          <span>{chats.length ? String(chats.length).padStart(2, '0') : ''}</span>
        </div>
        <nav className="chat-list" aria-label="Conversation history">
          {loading ? (
            <div className="sidebar-empty">Loading conversations…</div>
          ) : chats.length ? (
            chats.map((c) => (
              <div className={`chat-row ${chat?.id === c.id ? 'selected' : ''}`} key={c.id}>
                <button className="chat-link" disabled={busy} onClick={() => void openChat(c.id)}>
                  <MessageCircle size={15} />
                  <span>
                    {c.title}
                    <small>{c.demo ? 'Sample conversation' : dateLabel(c.updatedAt)}</small>
                  </span>
                </button>
                <button
                  className="delete-chat"
                  title="Delete conversation"
                  aria-label={`Delete ${c.title}`}
                  disabled={busy}
                  onClick={() => setDeleteId(c.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="sidebar-empty">
              <span>A little space for your big questions.</span>
              <p>Your conversations will live here.</p>
            </div>
          )}
        </nav>
        <button className="walkthrough-card" onClick={() => void walkthrough()} disabled={busy}>
          <span className="walkthrough-icon">
            <BookOpen size={19} />
          </span>
          <strong>
            See the whole story <ArrowUpRight size={15} />
          </strong>
          <span>
            One conversation. A week later.
            <br />A better-informed answer.
          </span>
          <small>EXPLORE THE WALKTHROUGH</small>
        </button>
        <div className="sidebar-footer">
          <span className="avatar">Y</span>
          <div>
            Personal workspace<small>History saved on this server</small>
          </div>
          <button
            className="icon-button"
            aria-label="Connection settings"
            onClick={() => setSetup(true)}
          >
            <Settings2 size={16} />
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </button>
            <span className="workspace-label">
              {chat?.demo ? 'The walkthrough' : 'Your research companion'}
            </span>
            <span className="topbar-divider" />
            <span className="web-label">
              <Globe2 size={13} /> Web search
            </span>
          </div>
          <button
            className={`connection ${config?.live ? 'connected' : ''}`}
            onClick={() => setSetup(true)}
          >
            <span />
            {config?.live ? 'Live' : 'Preview mode'}
            <ChevronDown size={12} />
          </button>
        </header>
        {chat?.demo && (
          <div className="demo-banner">
            <Sparkles size={14} />
            <span>
              <strong>Sample conversation</strong> · Fictional data, fixed at 10 Nov 2026. No live
              API calls.
            </span>
            <button onClick={newChat} disabled={busy}>
              Start fresh <ArrowRight size={13} />
            </button>
          </div>
        )}
        <div
          className="conversation-scroll"
          ref={scroller}
          onScroll={() => {
            const el = scroller.current;
            if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
          }}
        >
          {!turns.length ? (
            <section className="welcome">
              <div className="welcome-eyebrow">
                <span className="tiny-star">✳</span> A LITTLE CONTEXT GOES A LONG WAY
              </div>
              <h1>
                Good questions deserve
                <br />
                <em>a little follow-through.</em>
              </h1>
              <p className="welcome-copy">
                Ask something new. Revisit an old decision.
                <br />
                I’ll keep the context and check what’s changed.
              </p>
              <div className="capabilities">
                <span>
                  <History size={14} /> Remembers the conversation
                </span>
                <i />
                <span>
                  <Globe2 size={14} /> Checks the web
                </span>
                <i />
                <span>
                  <ShieldCheck size={14} /> Shows its sources
                </span>
              </div>
              <div className="examples-label">
                A FEW PLACES TO START <span>↙</span>
              </div>
              <div className="example-grid">
                {EXAMPLES.map(({ icon: Icon, label, short, text }) => (
                  <button
                    key={label}
                    className="example-card"
                    onClick={() => {
                      if (!config?.live) void walkthrough().then(() => setDraft(text));
                      else {
                        setDraft(text);
                        textarea.current?.focus();
                      }
                    }}
                  >
                    <Icon size={19} strokeWidth={1.6} />
                    <small>{label}</small>
                    <strong>{short}</strong>
                    <ArrowUpRight className="example-arrow" size={16} />
                  </button>
                ))}
              </div>
              <div className="welcome-note">
                <span className="note-line" />
                <span>Built for the next question, too.</span>
                <span className="note-line" />
              </div>
            </section>
          ) : (
            <section className="messages" aria-label="Conversation">
              {turns.map((turn) => (
                <article className="turn" key={turn.id} data-turn={turn.id}>
                  <div className="user-message">
                    <div className="user-label">
                      You <span>{dateLabel(turn.createdAt)}</span>
                    </div>
                    <div>{turn.question}</div>
                  </div>
                  <div className="assistant-message">
                    <div className="assistant-heading">
                      <Mark small />
                      <strong>Thread</strong>
                      {turn.status === 'pending' && (
                        <span className="working-label">Working on it</span>
                      )}
                    </div>
                    {!!turn.memory.length && (
                      <button
                        className="memory-pill"
                        onClick={() => setPanel({ turn, memory: true })}
                      >
                        <History size={12} /> Recalled{' '}
                        {turn.memory.length === 1
                          ? `your ${dateLabel(turn.memory[0]!.createdAt)} conversation`
                          : `${turn.memory.length} earlier exchanges`}
                        <ArrowUpRight size={12} />
                      </button>
                    )}
                    {turn.status === 'pending' && (
                      <div className="activity" role="status">
                        <LoaderCircle size={14} className="spin" />
                        <span>{status || 'Thinking'}</span>
                      </div>
                    )}
                    {turn.answer ? (
                      <Answer
                        text={turn.answer}
                        sources={turn.sources}
                        onSource={(source) => setPanel({ turn, sourceId: source.id })}
                      />
                    ) : turn.status === 'failed' || turn.status === 'cancelled' ? (
                      <p className="interrupted">
                        {turn.status === 'cancelled'
                          ? 'You stopped this response.'
                          : 'This response was not completed.'}{' '}
                        <button onClick={() => void send(turn.question)} disabled={busy}>
                          Try again
                        </button>
                      </p>
                    ) : null}
                    {!!turn.warnings.length && !chat?.demo && (
                      <div className="answer-warnings">
                        {turn.warnings.map((warning, i) => (
                          <p key={i}>{warning}</p>
                        ))}
                      </div>
                    )}
                    {turn.status === 'complete' && (
                      <div className="answer-footer">
                        <div className="answer-tools">
                          <button
                            title="Copy answer"
                            aria-label="Copy answer"
                            onClick={() => void copy(turn)}
                          >
                            {copied === turn.id ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                          {!!turn.sources.length && (
                            <button className="sources-button" onClick={() => setPanel({ turn })}>
                              <Globe2 size={13} /> {turn.sources.length} sources{' '}
                              <ArrowUpRight size={12} />
                            </button>
                          )}
                          {!!turn.searches.length && (
                            <button onClick={() => setPanel({ turn })}>
                              <Search size={13} /> Search details
                            </button>
                          )}
                        </div>
                        {turn.stats && (
                          <span className="timing">
                            {chat?.demo
                              ? 'Illustrative answer'
                              : `${(turn.stats.durationMs / 1000).toFixed(1)}s · ${turn.stats.searchQueries} searches`}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )}
          <div ref={bottom} />
        </div>
        <div className="composer-area">
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError('')}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {chat?.demo && !busy && (
            <div className="demo-questions">
              {EXAMPLES.map((example, i) => (
                <button key={example.label} onClick={() => void send(example.text)}>
                  {
                    ['Recheck our CRM shortlist', 'Revisit 3 November', 'Compare Postgres pricing'][
                      i
                    ]
                  }
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          )}
          <form
            className={`composer ${busy ? 'is-busy' : ''}`}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label className="sr-only" htmlFor="message">
              Your message
            </label>
            <textarea
              id="message"
              ref={textarea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={chat ? 'Keep the conversation going…' : 'What are you thinking about?'}
              rows={1}
              maxLength={12000}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!busy) void send();
                }
              }}
            />
            <div className="composer-toolbar">
              <span className="search-mode">
                <Globe2 size={14} /> Search when it helps
              </span>
              <div>
                <span className="keyboard-hint">Shift + Enter for a new line</span>
                {busy ? (
                  <button
                    className="send-button stop"
                    type="button"
                    aria-label="Stop response"
                    onClick={() => controller.current?.abort()}
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    type="submit"
                    aria-label="Send message"
                    disabled={!draft.trim() || loading}
                  >
                    <ArrowUp size={19} />
                  </button>
                )}
              </div>
            </div>
          </form>
          <div className="composer-note">
            {chat?.demo ? (
              <>
                <span className="status-dot" /> Sample data. Real context. Explore how an answer
                evolves.
              </>
            ) : (
              <>
                <span className="status-dot" />{' '}
                {config?.live ? (
                  'Answers with evidence. Room for uncertainty.'
                ) : (
                  <button onClick={() => setSetup(true)}>
                    Add your API keys to start a live conversation <ArrowRight size={11} />
                  </button>
                )}
              </>
            )}
            <span className="timezone">{timezone.replaceAll('_', ' ')}</span>
          </div>
        </div>
      </main>

      {panel && panelTurn && (
        <>
          <button
            className="panel-scrim"
            aria-label="Close evidence panel"
            onClick={() => setPanel(null)}
          />
          <aside className="evidence-panel" aria-label="Evidence panel">
            <header>
              <div>
                <span className="eyebrow">BEHIND THE ANSWER</span>
                <h2>{panel.memory ? 'Remembered context' : 'Sources & evidence'}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close evidence"
                onClick={() => setPanel(null)}
              >
                <X size={19} />
              </button>
            </header>
            <div className="panel-body">
              {chat?.demo && (
                <p className="panel-notice">
                  These are fictional source excerpts for the walkthrough. Links are placeholders.
                </p>
              )}
              {!!panelTurn.memory.length && (
                <section className="memory-section">
                  <h3>
                    <History size={14} /> From your conversations
                  </h3>
                  {panelTurn.memory.map((ref) => (
                    <div className="memory-reference" key={ref.turnId}>
                      <small>
                        {new Date(ref.createdAt).toLocaleString()} · {ref.reason} match
                      </small>
                      <p>{ref.question}</p>
                      <button
                        onClick={() => {
                          setPanel(null);
                          if (ref.conversationId !== chat?.id) void openChat(ref.conversationId);
                          else
                            document
                              .querySelector(`[data-turn="${ref.turnId}"]`)
                              ?.scrollIntoView({ behavior: 'smooth' });
                        }}
                        disabled={busy}
                      >
                        Open conversation <ArrowUpRight size={12} />
                      </button>
                    </div>
                  ))}
                </section>
              )}
              {panelTurn.sources.map((source) => (
                <section
                  key={source.id}
                  className={`source-card ${panel.sourceId === source.id ? 'highlighted' : ''}`}
                >
                  <div className="source-kicker">
                    <span>{source.id}</span>
                    <small className={source.historical ? 'historical-tag' : ''}>
                      {source.historical
                        ? 'Saved observation'
                        : chat?.demo
                          ? 'Sample observation'
                          : 'Retrieved this turn'}
                    </small>
                  </div>
                  <h3>{source.title}</h3>
                  <a href={source.url} target="_blank" rel="noopener noreferrer">
                    {new URL(source.url).hostname} <ArrowUpRight size={12} />
                  </a>
                  <blockquote>{source.excerpt}</blockquote>
                  <dl>
                    <dt>Observed</dt>
                    <dd>{new Date(source.observedAt).toLocaleString()}</dd>
                    {source.publishedAt && (
                      <>
                        <dt>Published</dt>
                        <dd>{source.publishedAt}</dd>
                      </>
                    )}
                  </dl>
                </section>
              ))}
              {!!panelTurn.searches.length && (
                <section className="search-log">
                  <h3>Search activity</h3>
                  {panelTurn.searches.map((search, i) => (
                    <div key={i}>
                      <span className={search.status === 'failed' ? 'failed' : ''}>
                        {search.status === 'failed' ? <X size={14} /> : <Check size={14} />}
                      </span>
                      <p>
                        {search.query}
                        <small>
                          {search.error ||
                            `${search.resultCount ?? 0} excerpts · ${((search.elapsedMs ?? 0) / 1000).toFixed(1)}s`}
                        </small>
                      </p>
                    </div>
                  ))}
                </section>
              )}
              {panelTurn.stats && (
                <div className="run-stats">
                  <h3>This response</h3>
                  <dl>
                    <dt>Model calls</dt>
                    <dd>{panelTurn.stats.modelCalls}</dd>
                    <dt>Search queries</dt>
                    <dd>{panelTurn.stats.searchQueries}</dd>
                    <dt>Input / output tokens</dt>
                    <dd>
                      {panelTurn.stats.inputTokens.toLocaleString()} /{' '}
                      {panelTurn.stats.outputTokens.toLocaleString()}
                    </dd>
                    <dt>Total time</dt>
                    <dd>{(panelTurn.stats.durationMs / 1000).toFixed(1)}s</dd>
                  </dl>
                </div>
              )}
            </div>
          </aside>
        </>
      )}
      {setup && (
        <div className="modal-backdrop" onClick={() => setSetup(false)}>
          <section
            className="setup-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="setup-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close settings"
              onClick={() => setSetup(false)}
            >
              <X size={18} />
            </button>
            <Mark />
            <span className="eyebrow">YOUR CONNECTION</span>
            <h2 id="setup-title">
              {config?.live ? 'Ready for a good question.' : 'Make room for real research.'}
            </h2>
            <p>
              {config?.live
                ? `Live chat is configured for ${config.model} through ${modelProvider}, with Tavily web search.`
                : 'Add your OpenAI and Tavily keys to the server’s .env file, then restart with npm run dev.'}
            </p>
            <div className="provider-row">
              <span>{modelProvider}</span>
              <small>
                {config?.missingKeys.some((key) => key !== 'TAVILY_API_KEY')
                  ? 'Key needed'
                  : 'Configured'}
              </small>
            </div>
            <div className="provider-row">
              <span>Tavily</span>
              <small>
                {config?.missingKeys.includes('TAVILY_API_KEY') ? 'Key needed' : 'Configured'}
              </small>
            </div>
            <p className="privacy-note">
              <ShieldCheck size={15} />
              Keys stay on the server. Relevant conversation context goes to {modelProvider}; public
              search queries go to Tavily.
            </p>
            <button
              className="primary-button"
              onClick={() => {
                setSetup(false);
                if (!config?.live) void walkthrough();
              }}
            >
              {config?.live ? 'Back to the conversation' : 'Try the offline walkthrough'}
              <ArrowRight size={16} />
            </button>
          </section>
        </div>
      )}
      {deleteId && (
        <div className="modal-backdrop">
          <section
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <h2 id="delete-title">Delete this conversation?</h2>
            <p>Its messages and saved evidence will be removed from this workspace.</p>
            <div>
              <button className="secondary-button" onClick={() => setDeleteId(null)}>
                Keep it
              </button>
              <button className="danger-button" onClick={() => void removeChat(deleteId)}>
                Delete conversation
              </button>
            </div>
          </section>
        </div>
      )}
      {activeTurn && (
        <span className="sr-only" role="status">
          A response is in progress
        </span>
      )}
    </div>
  );
}
