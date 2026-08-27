"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BriefPanel } from "./BriefPanel";
import { ChatPanel } from "./ChatPanel";
import { MeetingList } from "./MeetingList";
import { SourcePanel } from "./SourcePanel";
import { TracePanel } from "./TracePanel";
import { TranscriptDialog } from "./TranscriptDialog";
import { UploadDialog } from "./UploadDialog";
import type { ChatDone, ChatMeta, HealthResponse, Meeting, MeetingWithTurns, Message } from "./types";
import { Badge, Button, cx, Spinner } from "./ui";

/**
 * Application shell and the only place holding state.
 *
 * State lives in one component on purpose. There are three interacting concerns —
 * corpus selection, a streaming conversation, and the inspector following the
 * latest answer — and they are all coupled. A state library or a context tree
 * would add indirection without removing any of that coupling.
 */

type PanelTab = "sources" | "brief" | "trace";

interface Props {
  initialStatus: HealthResponse;
  initialMeetings: Meeting[];
}

export function Workspace({ initialStatus, initialMeetings }: Props) {
  const [health, setHealth] = useState<HealthResponse>(initialStatus);
  const [meetings, setMeetings] = useState<Meeting[]>(initialMeetings);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<PanelTab>("sources");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [detail, setDetail] = useState<MeetingWithTurns | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [viewer, setViewer] = useState<{ meeting: MeetingWithTurns; turnIndex: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [healthResponse, meetingsResponse] = await Promise.all([fetch("/api/health"), fetch("/api/meetings")]);
      if (healthResponse.ok) setHealth(await healthResponse.json());
      if (meetingsResponse.ok) {
        const payload = await meetingsResponse.json();
        setMeetings(payload.meetings ?? []);
      }
    } catch {
      setToast("Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * The brief is per-meeting, so it is loaded when the selection narrows to
   * exactly one. Driven from the selection handler rather than an effect on
   * `selected`: selection only ever changes through a user action, so an effect
   * would be a second mechanism reacting to something already in hand.
   */
  const loadBriefFor = useCallback(async (ids: Set<string>) => {
    if (ids.size !== 1) {
      setDetail(null);
      return;
    }
    const [id] = [...ids];
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/meetings/${id}`);
      setDetail(response.ok ? ((await response.json()).meeting ?? null) : null);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const changeSelection = useCallback(
    (mutate: (current: Set<string>) => Set<string>) => {
      setSelected((current) => {
        const next = mutate(new Set(current));
        void loadBriefFor(next);
        return next;
      });
    },
    [loadBriefFor],
  );

  const latestAssistant = useMemo(() => [...messages].reverse().find((message) => message.role === "assistant") ?? null, [messages]);
  const sources = latestAssistant?.meta?.sources ?? [];

  const seed = async () => {
    setSeeding(true);
    try {
      const response = await fetch("/api/seed", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Seeding failed");
      await refresh();
      setToast(`Indexed ${payload.ingested.length} sample meetings.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Seeding failed");
    } finally {
      setSeeding(false);
    }
  };

  const removeMeeting = async (id: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      changeSelection((current) => {
        current.delete(id);
        return current;
      });
      await refresh();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  const openTranscript = async (meetingId: string, turnIndex: number) => {
    try {
      const response = await fetch(`/api/meetings/${meetingId}`);
      if (!response.ok) throw new Error("Could not load transcript");
      const payload = await response.json();
      setViewer({ meeting: payload.meeting, turnIndex });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not load transcript");
    }
  };

  const send = async (question: string) => {
    if (streaming) return;

    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: question };
    const assistantId = crypto.randomUUID();
    const history = messages.map(({ role, content }) => ({ role, content }));

    setMessages((current) => [...current, userMessage, { id: assistantId, role: "assistant", content: "", streaming: true }]);
    setStreaming(true);
    setHighlighted(null);
    setTab("sources");

    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (update: Partial<Message>) =>
      setMessages((current) => current.map((message) => (message.id === assistantId ? { ...message, ...update } : message)));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history, meetingIds: [...selected] }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({ error: "Request failed" }));
        throw new Error(payload.error ?? "Request failed");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";

      // NDJSON: accumulate and split on newlines, keeping any partial trailing line.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim().length === 0) continue;
          let event: { type: string; data: unknown };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "meta") {
            patch({ meta: event.data as ChatMeta });
          } else if (event.type === "delta") {
            text += event.data as string;
            patch({ content: text });
          } else if (event.type === "done") {
            const payload = event.data as ChatDone;
            if (payload.answer) text = payload.answer;
            patch({ done: payload, content: text, streaming: false });
          } else if (event.type === "error") {
            patch({ error: (event.data as { message: string }).message, streaming: false });
          }
        }
      }
      patch({ streaming: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        // Stopping keeps whatever streamed so far; it is usually still useful.
        patch({ streaming: false });
      } else {
        patch({ error: error instanceof Error ? error.message : "Request failed", streaming: false });
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const scopeLabel =
    selected.size === 0
      ? `Searching all ${meetings.length} meeting${meetings.length === 1 ? "" : "s"}`
      : `Scoped to ${selected.size} meeting${selected.size === 1 ? "" : "s"}`;

  return (
    <div className="flex h-full flex-col">
      <TopBar health={health} onUpload={() => setUploadOpen(true)} onSeed={seed} seeding={seeding} />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-panel/40 px-3 py-4 lg:flex">
          <Button variant="primary" onClick={() => setUploadOpen(true)} className="w-full">
            + Add meetings
          </Button>
          <MeetingList
            meetings={meetings}
            selected={selected}
            busy={busy}
            onToggle={(id) =>
              changeSelection((current) => {
                if (current.has(id)) current.delete(id);
                else current.add(id);
                return current;
              })
            }
            onClear={() => changeSelection(() => new Set())}
            onOpen={(id) => void openTranscript(id, 0)}
            onDelete={(id) => void removeMeeting(id)}
          />
          {health ? <IndexFacts health={health} /> : null}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <ChatPanel
            messages={messages}
            streaming={streaming}
            corpusEmpty={meetings.length === 0}
            scopeLabel={scopeLabel}
            highlighted={highlighted}
            onSend={(question) => void send(question)}
            onStop={() => abortRef.current?.abort()}
            onCite={(label) => {
              setTab("sources");
              setHighlighted(label);
            }}
            onSeed={seed}
            seeding={seeding}
          />
        </main>

        <aside className="hidden w-[380px] shrink-0 flex-col border-l border-line bg-panel/40 xl:flex">
          <nav className="flex gap-1 border-b border-line px-3 pt-3">
            {(["sources", "brief", "trace"] as PanelTab[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => setTab(candidate)}
                className={cx(
                  "rounded-t-md border-b-2 px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                  tab === candidate ? "border-accent text-accent" : "border-transparent text-ink-muted hover:text-ink",
                )}
              >
                {candidate}
                {candidate === "sources" && sources.length > 0 ? ` (${sources.length})` : ""}
              </button>
            ))}
          </nav>
          <div className="flex-1 overflow-y-auto px-3 py-4">
            {tab === "sources" ? (
              <SourcePanel sources={sources} highlighted={highlighted} onOpenTranscript={(id, turn) => void openTranscript(id, turn)} />
            ) : null}
            {tab === "brief" ? (
              <BriefPanel
                meeting={detail}
                loading={detailLoading}
                onJump={(turnIndex) => {
                  if (detail) setViewer({ meeting: detail, turnIndex });
                }}
              />
            ) : null}
            {tab === "trace" ? <TracePanel message={latestAssistant} /> : null}
          </div>
        </aside>
      </div>

      {uploadOpen ? (
        <UploadDialog
          transcriptionAvailable={health.provider.transcriptionAvailable}
          onClose={() => setUploadOpen(false)}
          onIngested={() => void refresh()}
        />
      ) : null}
      <TranscriptDialog meeting={viewer?.meeting ?? null} focusTurnIndex={viewer?.turnIndex ?? null} onClose={() => setViewer(null)} />

      {toast ? (
        <div className="fade-rise fixed bottom-5 left-1/2 z-60 -translate-x-1/2 rounded-lg border border-line-bright bg-panel-raised px-4 py-2.5 text-[12.5px] text-ink shadow-xl">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function TopBar({
  health,
  onUpload,
  onSeed,
  seeding,
}: {
  health: HealthResponse | null;
  onUpload: () => void;
  onSeed: () => void;
  seeding: boolean;
}) {
  const remote = health?.provider.remote ?? false;
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-panel/60 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex size-7 items-center justify-center rounded-md bg-accent/15 text-accent">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M4 6h16M4 11h10M4 16h13" />
            <circle cx="19" cy="17.5" r="3.2" />
          </svg>
        </div>
        <div>
          <h1 className="text-[13px] font-semibold tracking-tight text-ink">Meeting Intelligence</h1>
          <p className="text-[10.5px] text-ink-faint">Cited answers over meeting transcripts</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {health ? (
          <>
            <Badge tone={remote ? "good" : "warn"} title={remote ? "Answers come from a real language model" : "No API key: hashed embeddings and extractive answers"}>
              {remote ? health.provider.chatModel : "offline mode"}
            </Badge>
            <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">
              {health.corpus.meetings} meetings · {health.corpus.chunks} chunks
            </span>
          </>
        ) : (
          <Spinner className="text-ink-faint" />
        )}
        <Button size="sm" variant="ghost" onClick={onSeed} disabled={seeding}>
          {seeding ? <Spinner /> : null}
          Load samples
        </Button>
        <Button size="sm" variant="secondary" onClick={onUpload} className="lg:hidden">
          Add
        </Button>
      </div>
    </header>
  );
}

/**
 * The retrieval settings in force, visible rather than buried in a config file.
 * It is the first thing I want to see when answers look wrong.
 */
function IndexFacts({ health }: { health: HealthResponse }) {
  const rows: [string, string][] = [
    ["embeddings", `${health.provider.embeddingModel} (${health.provider.embeddingDimensions}d)`],
    ["chunk target", `${health.chunking.targetTokens} tok`],
    ["chunk overlap", `${health.chunking.overlapTokens} tok`],
    ["dense / lexical k", `${health.retrieval.denseK} / ${health.retrieval.lexicalK}`],
    ["sources in prompt", String(health.retrieval.finalK)],
    ["context budget", `${health.retrieval.contextTokenBudget} tok`],
  ];
  return (
    <div className="mt-auto space-y-1.5 rounded-lg border border-line bg-panel px-3 py-2.5">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink-faint">Pipeline</p>
      <dl className="space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2 text-[10.5px]">
            <dt className="text-ink-faint">{label}</dt>
            <dd className="truncate font-mono text-ink-muted" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
