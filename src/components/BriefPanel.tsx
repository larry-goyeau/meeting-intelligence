"use client";

import { formatTimecode } from "@/lib/transcript/time";
import type { DecisionStatus, MeetingWithTurns } from "@/lib/types";
import { Badge, Button, EmptyHint, SectionLabel } from "./ui";

/**
 * The meeting brief: decisions, action items and open questions extracted once at
 * ingest. This panel is why "what did we decide?" is instant and complete rather
 * than a retrieval gamble over eight chunks.
 */

const STATUS_TONE: Record<DecisionStatus, "good" | "warn" | "danger"> = {
  agreed: "good",
  tentative: "warn",
  reversed: "danger",
};

interface Props {
  meeting: MeetingWithTurns | null;
  loading: boolean;
  onJump: (turnIndex: number) => void;
}

export function BriefPanel({ meeting, loading, onJump }: Props) {
  if (loading) return <EmptyHint>Loading brief…</EmptyHint>;
  if (!meeting) return <EmptyHint>Select a single meeting in the sidebar to see its brief.</EmptyHint>;

  const brief = meeting.brief;
  if (!brief || (brief.decisions.length === 0 && brief.actionItems.length === 0 && brief.summary.length === 0)) {
    return <EmptyHint>No brief was extracted for this meeting.</EmptyHint>;
  }

  const jumpTo = (atMs: number | null) => {
    if (atMs === null) return;
    // Map a timestamp back to the nearest turn at or before it.
    const turn = [...meeting.turns].reverse().find((candidate) => (candidate.startMs ?? 0) <= atMs);
    onJump(turn?.index ?? 0);
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <SectionLabel>Summary</SectionLabel>
        <p className="rounded-lg border border-line bg-panel p-3 text-[13px] leading-relaxed text-ink/90">{brief.summary}</p>
        {brief.topics.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-1">
            {brief.topics.map((topic) => (
              <Badge key={topic}>{topic}</Badge>
            ))}
          </div>
        ) : null}
      </section>

      {brief.decisions.length > 0 ? (
        <section className="space-y-2">
          <SectionLabel>Decisions ({brief.decisions.length})</SectionLabel>
          <ul className="space-y-2">
            {brief.decisions.map((decision, index) => (
              <li key={index} className="rounded-lg border border-line bg-panel p-3">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <Badge tone={STATUS_TONE[decision.status]}>{decision.status}</Badge>
                  {decision.atMs !== null ? (
                    <Button size="sm" variant="ghost" onClick={() => jumpTo(decision.atMs)}>
                      <span className="font-mono text-[11px]">{formatTimecode(decision.atMs)}</span>
                    </Button>
                  ) : null}
                </div>
                <p className="text-[13px] leading-relaxed text-ink/90">{decision.decision}</p>
                {decision.rationale ? <p className="mt-1.5 text-[12px] text-ink-muted">{decision.rationale}</p> : null}
                {decision.owner ? <p className="mt-1.5 text-[11px] text-ink-faint">raised by {decision.owner}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {brief.actionItems.length > 0 ? (
        <section className="space-y-2">
          <SectionLabel>Action items ({brief.actionItems.length})</SectionLabel>
          <ul className="space-y-2">
            {brief.actionItems.map((item, index) => (
              <li key={index} className="rounded-lg border border-line bg-panel p-3">
                <p className="text-[13px] leading-relaxed text-ink/90">{item.task}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {/* An unstated owner is shown as unassigned rather than guessed. */}
                  <Badge tone={item.owner ? "accent" : "neutral"}>{item.owner ?? "unassigned"}</Badge>
                  {item.due ? <Badge tone="warn">{item.due}</Badge> : null}
                  {item.atMs !== null ? (
                    <button
                      type="button"
                      onClick={() => jumpTo(item.atMs)}
                      className="font-mono text-[11px] text-ink-faint hover:text-accent"
                    >
                      {formatTimecode(item.atMs)}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {brief.openQuestions.length > 0 ? (
        <section className="space-y-2">
          <SectionLabel>Open questions ({brief.openQuestions.length})</SectionLabel>
          <ul className="space-y-1.5">
            {brief.openQuestions.map((question, index) => (
              <li key={index} className="rounded-lg border border-line bg-panel px-3 py-2 text-[12.5px] text-ink/85">
                {question}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="px-1 text-[11px] text-ink-faint">Extracted by {brief.generatedBy} at ingest time.</p>
    </div>
  );
}
