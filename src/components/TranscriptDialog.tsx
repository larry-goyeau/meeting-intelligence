"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, formatTimecode } from "@/lib/transcript/time";
import type { MeetingWithTurns } from "./types";
import { Badge, Button, cx } from "./ui";

/**
 * Full transcript viewer, opened from a citation or a brief entry and scrolled to
 * the exact turn. This closes the verification loop: an answer says something, you
 * click, and you are looking at the words that were actually spoken.
 */

interface Props {
  meeting: MeetingWithTurns | null;
  focusTurnIndex: number | null;
  onClose: () => void;
}

export function TranscriptDialog({ meeting, focusTurnIndex, onClose }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (focusTurnIndex === null || !meeting) return;
    // The dialog mounts and paints before this runs, so the target row exists.
    const target = scrollRef.current?.querySelector(`[data-turn="${focusTurnIndex}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [focusTurnIndex, meeting]);

  const speakerTones = useMemo(() => {
    if (!meeting) return new Map<string, string>();
    const palette = ["text-accent", "text-good", "text-warn", "text-danger", "text-ink", "text-ink-muted"];
    const speakers = [...new Set(meeting.turns.map((turn) => turn.speaker))];
    return new Map(speakers.map((speaker, index) => [speaker, palette[index % palette.length] ?? "text-ink"]));
  }, [meeting]);

  if (!meeting) return null;

  const needle = filter.trim().toLowerCase();
  const visible = needle.length === 0 ? meeting.turns : meeting.turns.filter((turn) => turn.text.toLowerCase().includes(needle) || turn.speaker.toLowerCase().includes(needle));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8" role="dialog" aria-modal aria-label={`Transcript: ${meeting.title}`}>
      <button type="button" aria-label="Close transcript" onClick={onClose} className="absolute inset-0 bg-canvas/85 backdrop-blur-sm" />

      <div className="fade-rise relative flex h-full max-h-[860px] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line-bright bg-panel shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink">{meeting.title}</h2>
            <p className="mt-1 font-mono text-[11px] text-ink-faint">
              {meeting.date ?? "undated"} · {formatDuration(meeting.durationMs)} · {meeting.turnCount} turns ·{" "}
              {meeting.tokenCount.toLocaleString()} tokens
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {meeting.participants.map((participant) => (
                <Badge key={participant}>{participant}</Badge>
              ))}
            </div>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </header>

        {meeting.warnings.length > 0 ? (
          <ul className="space-y-1 border-b border-warn/20 bg-warn-soft px-5 py-3 text-[11.5px] text-warn">
            {meeting.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}

        <div className="border-b border-line px-5 py-2.5">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter turns by text or speaker…"
            className="w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-faint"
          />
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
          <ol className="space-y-2.5">
            {visible.map((turn) => (
              <li
                key={turn.index}
                data-turn={turn.index}
                className={cx(
                  "rounded-md px-2 py-1.5 transition-colors",
                  focusTurnIndex === turn.index ? "bg-accent-soft ring-1 ring-accent/50" : "hover:bg-panel-raised",
                )}
              >
                <div className="mb-0.5 flex items-baseline gap-2">
                  {turn.startMs !== null ? (
                    <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">{formatTimecode(turn.startMs, true)}</span>
                  ) : null}
                  <span className={cx("text-[11.5px] font-semibold", speakerTones.get(turn.speaker))}>{turn.speaker}</span>
                </div>
                <p className="text-[13px] leading-relaxed text-ink/90">{turn.text}</p>
              </li>
            ))}
          </ol>
          {visible.length === 0 ? <p className="py-8 text-center text-xs text-ink-faint">No turns match that filter.</p> : null}
        </div>
      </div>
    </div>
  );
}
