"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, cx, Spinner } from "./ui";

/**
 * Three ways in: files, pasted text, and audio.
 *
 * The audio path deliberately stops at the text and hands it to the paste tab
 * rather than ingesting straight away. Speech-to-text gives no speaker identity,
 * so an auto-ingested recording produces a transcript where every citation says
 * "Speaker" — technically working, practically useless. Making the user fix the
 * labels is the honest design.
 */

type Tab = "files" | "paste" | "audio";

/**
 * Mounted only while open, so closing it discards the draft, the error and the
 * busy flag by unmounting. Keeping it mounted and clearing that state in an
 * effect would be the same behaviour with an extra render pass and a second place
 * for the reset to be forgotten.
 */
interface Props {
  transcriptionAvailable: boolean;
  onClose: () => void;
  onIngested: () => void;
}

export function UploadDialog({ transcriptionAvailable, onClose, onIngested }: Props) {
  const [tab, setTab] = useState<Tab>("files");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const uploadFiles = async (files: FileList | File[]) => {
    const list = [...files];
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      for (const file of list) form.append("files", file);
      const response = await fetch("/api/meetings", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Upload failed");
      const failures = (payload.errors ?? []) as { filename: string; error: string }[];
      if (failures.length > 0) {
        setError(failures.map((failure) => `${failure.filename}: ${failure.error}`).join("\n"));
      }
      if ((payload.ingested ?? []).length > 0) {
        onIngested();
        if (failures.length === 0) onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const submitPasted = async () => {
    if (pasted.trim().length === 0) {
      setError("Paste a transcript first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: title.trim().length > 0 ? `${title.trim()}.txt` : "pasted-transcript.txt",
          content: pasted,
          ...(title.trim().length > 0 ? { title: title.trim() } : {}),
          ...(date.trim().length > 0 ? { date: date.trim() } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Ingestion failed");
      onIngested();
      setPasted("");
      setTitle("");
      setDate("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ingestion failed");
    } finally {
      setBusy(false);
    }
  };

  const transcribe = async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("audio", file);
      const response = await fetch("/api/transcribe", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Transcription failed");
      setPasted(payload.transcript ?? "");
      setTitle(file.name.replace(/\.[^.]+$/, ""));
      setTab("paste");
      setNotice(payload.note ?? "Transcribed. Replace the generic speaker labels before ingesting.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Transcription failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal aria-label="Add meetings">
      <button type="button" aria-label="Close" onClick={() => !busy && onClose()} className="absolute inset-0 bg-canvas/85 backdrop-blur-sm" />

      <div className="fade-rise relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line-bright bg-panel shadow-2xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Add meetings</h2>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </header>

        <nav className="flex gap-1 border-b border-line px-4 pt-3">
          {(["files", "paste", "audio"] as Tab[]).map((candidate) => (
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
              {candidate === "audio" && !transcriptionAvailable ? " (needs key)" : ""}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "files" ? (
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void uploadFiles(event.dataTransfer.files);
              }}
              className={cx(
                "flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors",
                dragging ? "border-accent bg-accent-soft/40" : "border-line",
              )}
            >
              <p className="text-[13px] text-ink">Drop transcript files here</p>
              <p className="max-w-md text-[11.5px] leading-relaxed text-ink-faint">
                Plain text, Markdown, WebVTT or SRT. Recognised layouts include <code className="font-mono">[00:12:34] Alice: …</code>,{" "}
                <code className="font-mono">Alice (00:12:34): …</code> and <code className="font-mono">Alice: …</code>. The format that was
                detected is shown on each meeting so a bad parse is visible.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".txt,.md,.vtt,.srt,text/plain"
                className="hidden"
                onChange={(event) => event.target.files && void uploadFiles(event.target.files)}
              />
              <Button variant="primary" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                {busy ? <Spinner /> : null}
                Choose files
              </Button>
            </div>
          ) : null}

          {tab === "paste" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-[11px] text-ink-muted">Title (optional)</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Weekly sync"
                    className="w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-faint"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-ink-muted">Date (optional)</span>
                  <input
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                    placeholder="2026-02-14"
                    className="w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-faint"
                  />
                </label>
              </div>
              <textarea
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                rows={14}
                spellCheck={false}
                placeholder={"[00:00:04] Priya: Let's start with the release plan.\n[00:00:11] Daniel: I'd rather cut scope than the date."}
                className="w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed text-ink placeholder:text-ink-faint"
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-ink-faint">{pasted.length.toLocaleString()} characters</p>
                <Button variant="primary" onClick={submitPasted} disabled={busy}>
                  {busy ? <Spinner /> : null}
                  Ingest transcript
                </Button>
              </div>
            </div>
          ) : null}

          {tab === "audio" ? (
            <div className="space-y-3">
              {!transcriptionAvailable ? (
                <p className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2.5 text-[12px] leading-relaxed text-warn">
                  Audio transcription needs a real provider. Set <code className="font-mono">OPENAI_API_KEY</code> and restart.
                </p>
              ) : null}
              <label
                className={cx(
                  "flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed border-line px-6 py-10 text-center",
                  !transcriptionAvailable && "pointer-events-none opacity-50",
                )}
              >
                <span className="text-[13px] text-ink">Choose an audio file</span>
                <span className="max-w-md text-[11.5px] leading-relaxed text-ink-faint">
                  Up to 25 MB. You get back a timestamped transcript with every line labelled{" "}
                  <code className="font-mono">Speaker</code>, because speech-to-text does not tell speakers apart. Rename them in the paste
                  tab, then ingest — otherwise every citation attributes to nobody.
                </span>
                <input
                  type="file"
                  accept="audio/*,video/mp4,video/webm"
                  className="hidden"
                  disabled={!transcriptionAvailable || busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void transcribe(file);
                  }}
                />
                {busy ? <Spinner className="text-accent" /> : <Badge tone="accent">select file</Badge>}
              </label>
            </div>
          ) : null}

          {notice ? (
            <p className="mt-4 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2.5 text-[12px] leading-relaxed text-accent">{notice}</p>
          ) : null}
          {error ? (
            <p className="mt-4 whitespace-pre-wrap rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-[12px] leading-relaxed text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
