"use client";

import { useEffect, useRef } from "react";
import { formatRange } from "@/lib/transcript/time";
import type { ClientSource } from "./types";
import { Badge, Button, cx, EmptyHint, SectionLabel } from "./ui";

/**
 * The evidence panel. Every claim in an answer points here, and every card points
 * to a moment in a transcript. Being able to go from a sentence in the answer to
 * the exact turn that supports it in two clicks is the feature that makes the tool
 * trustworthy; everything else is convenience.
 */

interface Props {
  sources: ClientSource[];
  highlighted: string | null;
  onOpenTranscript: (meetingId: string, turnIndex: number) => void;
}

export function SourcePanel({ sources, highlighted, onOpenTranscript }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlighted) return;
    const element = containerRef.current?.querySelector(`[data-source-label="${highlighted}"]`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  if (sources.length === 0) {
    return <EmptyHint>Ask a question and the transcript excerpts behind the answer appear here.</EmptyHint>;
  }

  const retrieved = sources.filter((source) => !source.viaNeighbour).length;

  return (
    <div ref={containerRef} className="space-y-3">
      <SectionLabel>
        {sources.length} source{sources.length === 1 ? "" : "s"}
        {sources.length > retrieved ? ` \u00b7 ${sources.length - retrieved} pulled in as context` : ""}
      </SectionLabel>

      {sources.map((source) => (
        <article
          key={source.id}
          data-source-label={source.label}
          className={cx(
            "rounded-lg border bg-panel p-3 transition-colors",
            highlighted === source.label ? "border-accent source-flash" : "border-line hover:border-line-bright",
          )}
        >
          <header className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="rounded border border-accent/40 bg-accent-soft px-1.5 py-px font-mono text-[10px] font-semibold text-accent">
                  {source.label}
                </span>
                <h3 className="truncate text-xs font-medium text-ink">{source.meetingTitle}</h3>
              </div>
              <p className="mt-1 font-mono text-[11px] text-ink-faint">
                {source.meetingDate ?? "undated"} · {formatRange(source.startMs, source.endMs)}
              </p>
            </div>
            {source.viaNeighbour ? (
              <Badge tone="neutral" title="Adjacent chunk, added so the exchange is not cut in half">
                context
              </Badge>
            ) : null}
          </header>

          <p className="mb-2 truncate text-[11px] text-ink-muted" title={source.speakers.join(", ")}>
            {source.speakers.join(", ")}
          </p>

          <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap rounded border border-line bg-canvas/60 p-2 font-mono text-[11px] leading-relaxed text-ink/85">
            {source.text}
          </pre>

          <footer className="mt-2 flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1 font-mono text-[10px] text-ink-faint">
              {/* Showing which retriever found a chunk makes the hybrid setup debuggable from the UI. */}
              <span title="Reciprocal rank fusion score">rrf {source.fusedScore.toFixed(4)}</span>
              {source.denseRank !== null ? <span title="Rank in dense (vector) results">· dense #{source.denseRank}</span> : null}
              {source.lexicalRank !== null ? <span title="Rank in lexical (BM25) results">· bm25 #{source.lexicalRank}</span> : null}
              <span>· {source.tokenCount} tok</span>
            </div>
            <Button size="sm" variant="ghost" onClick={() => onOpenTranscript(source.meetingId, source.firstTurnIndex)}>
              Open in transcript
            </Button>
          </footer>
        </article>
      ))}
    </div>
  );
}
