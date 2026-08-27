"use client";

import type { Message } from "./types";
import { Badge, EmptyHint, LatencyBar, SectionLabel } from "./ui";

/**
 * Trace inspector for the most recent answer.
 *
 * This is the observability story made visible instead of buried in logs. It
 * answers the question you actually have when an answer is wrong: was the query
 * rewritten badly, did retrieval find nothing, was the right chunk dropped for
 * budget, or did the model ignore what it was given?
 */

interface Props {
  message: Message | null;
}

export function TracePanel({ message }: Props) {
  if (!message?.meta) return <EmptyHint>Ask a question to inspect its pipeline.</EmptyHint>;

  const { meta, done } = message;
  const totalMs = done?.totalMs ?? 0;
  const generate = done?.stages.find((stage) => stage.stage === "generate");
  const firstTokenMs = generate?.detail?.firstTokenMs;
  const retrieveDetail = done?.stages.find((stage) => stage.stage === "retrieve")?.detail ?? {};

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <SectionLabel>Route</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={meta.route === "refused" ? "warn" : "accent"}>{meta.route}</Badge>
          <Badge tone={meta.remote ? "good" : "warn"}>{meta.remote ? meta.provider : "offline (no LLM)"}</Badge>
          {done?.verdict.flags.map((flag) => (
            <Badge key={flag} tone="warn">
              {flag}
            </Badge>
          ))}
        </div>
        <p className="rounded-lg border border-line bg-panel p-3 text-[12px] text-ink-muted">
          {meta.route === "whole-meeting"
            ? "The selected transcript fits the context budget, so it was passed in full instead of being retrieved over. Nothing was dropped."
            : meta.route === "refused"
              ? "Nothing scored above the relevance floor, so the model was never called. No tokens were spent on generation."
              : "Hybrid retrieval: dense and BM25 candidates fused by reciprocal rank, diversified with MMR, then packed chronologically into the context budget."}
        </p>
      </section>

      <section className="space-y-2">
        <SectionLabel>Query sent to retrieval</SectionLabel>
        <p className="rounded-lg border border-line bg-panel p-3 font-mono text-[11.5px] leading-relaxed text-ink/85">
          {meta.standaloneQuestion}
        </p>
        {meta.standaloneQuestion.trim() !== message.content.trim() ? (
          <p className="px-1 text-[11px] text-ink-faint">Rewritten from the original message to resolve context.</p>
        ) : null}
      </section>

      {done ? (
        <>
          <section className="space-y-2.5">
            <SectionLabel>Latency · {totalMs} ms total</SectionLabel>
            <div className="space-y-2.5 rounded-lg border border-line bg-panel p-3">
              {done.stages.map((stage) => (
                <LatencyBar key={stage.stage} label={stage.stage} ms={stage.ms} total={totalMs} />
              ))}
              {typeof firstTokenMs === "number" ? (
                <p className="pt-1 text-[11px] text-ink-faint">First token after {firstTokenMs} ms of generation.</p>
              ) : null}
            </div>
          </section>

          <section className="space-y-2">
            <SectionLabel>Retrieval</SectionLabel>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-line bg-panel p-3 text-[11.5px]">
              {Object.entries(retrieveDetail).map(([key, value]) => (
                <div key={key} className="flex items-baseline justify-between gap-2">
                  <dt className="text-ink-faint">{key}</dt>
                  <dd className="font-mono text-ink">{String(value)}</dd>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-faint">in prompt</dt>
                <dd className="font-mono text-ink">{meta.sources.length}</dd>
              </div>
            </dl>
          </section>

          <section className="space-y-2">
            <SectionLabel>Cost & grounding</SectionLabel>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-line bg-panel p-3 text-[11.5px]">
              <Row label="prompt tokens" value={done.usage.promptTokens.toLocaleString()} />
              <Row label="output tokens" value={done.usage.completionTokens.toLocaleString()} />
              <Row label="embedding tokens" value={done.usage.embeddingTokens.toLocaleString()} />
              <Row
                label="est. cost"
                value={done.usage.estimatedCostUsd > 0 ? `$${done.usage.estimatedCostUsd.toFixed(5)}` : "$0 (offline)"}
              />
              <Row label="citation coverage" value={`${Math.round(done.verdict.citationCoverage * 100)}%`} />
              <Row label="invalid citations" value={String(done.verdict.invalidCitations.length)} />
            </dl>
            <p className="px-1 text-[11px] text-ink-faint">
              Cost is estimated from a static price table and a characters/4 token approximation.
            </p>
          </section>

          <p className="px-1 font-mono text-[10px] text-ink-faint">trace {done.traceId}</p>
        </>
      ) : (
        <EmptyHint>Streaming…</EmptyHint>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="font-mono text-ink">{value}</dd>
    </div>
  );
}
