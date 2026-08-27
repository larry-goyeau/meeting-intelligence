"use client";

import { formatDuration } from "@/lib/transcript/time";
import type { Meeting } from "./types";
import { Badge, Button, cx, SectionLabel } from "./ui";

/**
 * Corpus sidebar. The checkboxes are the retrieval scope: nothing selected means
 * search everything, which is the useful default for cross-meeting questions.
 * Selecting one meeting is also what unlocks whole-transcript answering, so the
 * control does double duty and the status line says so.
 */

interface Props {
  meetings: Meeting[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  busy: boolean;
}

export function MeetingList({ meetings, selected, onToggle, onClear, onOpen, onDelete, busy }: Props) {
  return (
    <div className="space-y-2">
      <SectionLabel
        action={
          selected.size > 0 ? (
            <button type="button" onClick={onClear} className="text-[11px] text-accent hover:underline">
              clear ({selected.size})
            </button>
          ) : null
        }
      >
        Corpus · {meetings.length}
      </SectionLabel>

      {meetings.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs leading-relaxed text-ink-faint">
          No meetings indexed yet.
          <br />
          Load the sample corpus or upload a transcript.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {meetings.map((meeting) => {
            const isSelected = selected.has(meeting.id);
            return (
              <li key={meeting.id}>
                <div
                  className={cx(
                    "group rounded-lg border p-2.5 transition-colors",
                    isSelected ? "border-accent/60 bg-accent-soft/40" : "border-line bg-panel hover:border-line-bright",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggle(meeting.id)}
                      disabled={busy}
                      aria-label={`Include ${meeting.title} in searches`}
                      className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-accent)]"
                    />
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => onOpen(meeting.id)}
                        className="block w-full truncate text-left text-[12.5px] font-medium text-ink hover:text-accent"
                        title={meeting.title}
                      >
                        {meeting.title}
                      </button>
                      <p className="mt-0.5 font-mono text-[10.5px] text-ink-faint">
                        {meeting.date ?? "undated"} · {formatDuration(meeting.durationMs)} · {meeting.chunkCount} chunks
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <Badge title={`Detected transcript format: ${meeting.format}`}>{meeting.format}</Badge>
                        {meeting.source === "sample" ? <Badge tone="accent">sample</Badge> : null}
                        {meeting.warnings.length > 0 ? (
                          <Badge tone="warn" title={meeting.warnings.join("\n")}>
                            {meeting.warnings.length} warning{meeting.warnings.length === 1 ? "" : "s"}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDelete(meeting.id)}
                      disabled={busy}
                      title="Remove this meeting and its embeddings"
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      ×
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
