"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Small presentational primitives, hand-rolled: a component library would be more code than this. */

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

type Tone = "neutral" | "accent" | "warn" | "danger" | "good";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-line bg-panel-raised text-ink-muted",
  accent: "border-accent/40 bg-accent-soft text-accent",
  warn: "border-warn/40 bg-warn-soft text-warn",
  danger: "border-danger/40 bg-danger-soft text-danger",
  good: "border-good/40 bg-good/10 text-good",
};

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium",
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

const VARIANT_CLASSES = {
  primary: "bg-accent text-canvas hover:bg-accent/85 disabled:bg-accent/40",
  secondary: "border border-line-bright bg-panel-raised text-ink hover:border-accent/50 hover:text-accent",
  ghost: "text-ink-muted hover:bg-panel-raised hover:text-ink",
  danger: "border border-danger/40 text-danger hover:bg-danger-soft",
} as const;

export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
        VARIANT_CLASSES[variant],
        className,
      )}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx("size-4 animate-spin", className)} aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">{children}</h2>
      {action}
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-ink-faint">{children}</p>;
}

/** A horizontal bar chart of stage latencies. Reads faster than a list of numbers. */
export function LatencyBar({ label, ms, total }: { label: string; ms: number; total: number }) {
  const width = total > 0 ? Math.max(2, Math.round((ms / total) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-ink-muted">{label}</span>
        <span className="font-mono text-ink-faint">{ms} ms</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-raised">
        <div className="h-full rounded-full bg-accent/70" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
