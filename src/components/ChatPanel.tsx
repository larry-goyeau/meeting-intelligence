"use client";

import { useEffect, useRef, useState } from "react";
import { AnswerText } from "./AnswerText";
import type { Message } from "./types";
import { Badge, Button, cx, Spinner } from "./ui";

/**
 * The conversation. Answers stream in, citations are clickable, and the footer of
 * each answer carries the numbers that let you judge it: which route was taken,
 * how long it took, what it cost and how much of it was actually cited.
 */

const SUGGESTIONS = [
  "What did we decide about the analytics storage?",
  "Which decision was later reversed, and why?",
  "What are Tom's action items across every meeting?",
  "Was DynamoDB rejected, and on what grounds?",
  "What is still unresolved about multi-region?",
];

interface Props {
  messages: Message[];
  streaming: boolean;
  corpusEmpty: boolean;
  scopeLabel: string;
  highlighted: string | null;
  onSend: (question: string) => void;
  onStop: () => void;
  onCite: (label: string) => void;
  onSeed: () => void;
  seeding: boolean;
}

export function ChatPanel(props: Props) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pinnedToBottom = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the stream, but stop fighting the user if they scroll up to read.
  useEffect(() => {
    if (pinnedToBottom.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [props.messages]);

  const submit = () => {
    const question = draft.trim();
    if (question.length === 0 || props.streaming) return;
    props.onSend(question);
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto px-6 py-6"
      >
        <div className="mx-auto max-w-3xl space-y-6">
          {props.messages.length === 0 ? (
            <EmptyState corpusEmpty={props.corpusEmpty} onSeed={props.onSeed} seeding={props.seeding} onPick={props.onSend} />
          ) : null}

          {props.messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-sm border border-line-bright bg-panel-raised px-4 py-2.5 text-[13.5px] leading-relaxed text-ink">
                  {message.content}
                </p>
              </div>
            ) : (
              <AssistantMessage key={message.id} message={message} highlighted={props.highlighted} onCite={props.onCite} />
            ),
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-line bg-panel/60 px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-xl border border-line bg-panel p-2 focus-within:border-accent/50">
            <textarea
              ref={textareaRef}
              value={draft}
              rows={1}
              onChange={(event) => {
                setDraft(event.target.value);
                const element = event.target;
                element.style.height = "auto";
                element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={props.corpusEmpty ? "Load or upload a meeting first…" : "Ask about decisions, owners, disagreements…"}
              className="max-h-44 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
            />
            {props.streaming ? (
              <Button variant="secondary" onClick={props.onStop}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" onClick={submit} disabled={draft.trim().length === 0}>
                Ask
              </Button>
            )}
          </div>
          <p className="mt-2 px-1 text-[11px] text-ink-faint">
            {props.scopeLabel} · Enter to send, Shift+Enter for a new line
          </p>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  corpusEmpty,
  onSeed,
  seeding,
  onPick,
}: {
  corpusEmpty: boolean;
  onSeed: () => void;
  seeding: boolean;
  onPick: (question: string) => void;
}) {
  return (
    <div className="fade-rise space-y-6 pt-10">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Ask your meetings anything.</h1>
        <p className="max-w-xl text-[13.5px] leading-relaxed text-ink-muted">
          Every answer cites the transcript excerpts it came from, with speaker and timestamp, so you can check it in two clicks. Decisions,
          action items and open questions are extracted when a transcript is ingested.
        </p>
      </div>

      {corpusEmpty ? (
        <div className="rounded-xl border border-accent/30 bg-accent-soft/40 p-4">
          <p className="text-[13px] text-ink">Nothing is indexed yet.</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
            Load the five bundled sample meetings — a project running from kickoff through an incident postmortem, including one decision that
            gets reversed later — or upload your own.
          </p>
          <Button variant="primary" onClick={onSeed} disabled={seeding} className="mt-3">
            {seeding ? <Spinner /> : null}
            Load sample corpus
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">Try</p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onPick(suggestion)}
                className="rounded-full border border-line bg-panel px-3 py-1.5 text-left text-[12px] text-ink-muted transition-colors hover:border-accent/50 hover:text-accent"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AssistantMessage({
  message,
  highlighted,
  onCite,
}: {
  message: Message;
  highlighted: string | null;
  onCite: (label: string) => void;
}) {
  const validLabels = new Set((message.meta?.sources ?? []).map((source) => source.label));
  const verdict = message.done?.verdict;
  const lowCoverage = verdict?.flags.includes("low-citation-coverage");

  return (
    <div className="fade-rise space-y-2.5">
      {message.error ? (
        <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">{message.error}</p>
      ) : (
        <div className={cx(message.streaming && "streaming-caret")}>
          <AnswerText text={message.content} validLabels={validLabels} onCite={onCite} highlighted={highlighted} />
        </div>
      )}

      {lowCoverage ? (
        <p className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-[11.5px] leading-relaxed text-warn">
          Only {Math.round((verdict?.citationCoverage ?? 0) * 100)}% of the assertions in this answer carry a citation. Check the sources
          before relying on it.
        </p>
      ) : null}

      {message.done ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Badge tone={message.meta?.route === "refused" ? "warn" : "neutral"} title="Which answering strategy was used">
            {message.meta?.route === "whole-meeting" ? "full transcript" : message.meta?.route === "refused" ? "no evidence" : "hybrid retrieval"}
          </Badge>
          {message.meta && message.meta.sources.length > 0 ? (
            <Badge title="Excerpts placed in the prompt">{message.meta.sources.length} sources</Badge>
          ) : null}
          <Badge title="End-to-end latency">{(message.done.totalMs / 1000).toFixed(1)}s</Badge>
          <Badge title="Prompt + output + embedding tokens">
            {(message.done.usage.promptTokens + message.done.usage.completionTokens).toLocaleString()} tok
          </Badge>
          {message.done.usage.estimatedCostUsd > 0 ? (
            <Badge title="Estimated from a static price table">${message.done.usage.estimatedCostUsd.toFixed(5)}</Badge>
          ) : null}
          {!lowCoverage && verdict && verdict.citationCoverage >= 1 && validLabels.size > 0 ? (
            <Badge tone="good" title="Every assertion carries a citation">
              fully cited
            </Badge>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
