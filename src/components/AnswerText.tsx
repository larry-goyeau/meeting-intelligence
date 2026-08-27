"use client";

import type { ReactNode } from "react";
import { cx } from "./ui";

/**
 * Renders an answer: light markdown plus citation markers turned into buttons.
 *
 * A markdown library would be heavier than this and would still need custom
 * handling for the citations, which are the only part that matters here. The
 * model is instructed to emit prose and short lists, so bold, inline code, lists
 * and paragraphs are the whole grammar. Nothing is parsed as HTML, so there is no
 * injection surface.
 */

interface Props {
  text: string;
  /** Labels that resolve to a real source; anything else is rendered as plain text. */
  validLabels: Set<string>;
  onCite: (label: string) => void;
  highlighted?: string | null;
}

const INLINE = /(\[S\d+(?:\s*,\s*S\d+)*\])|(\*\*[^*]+\*\*)|(`[^`]+`)/g;

function renderInline(text: string, props: Props, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;

  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [token] = match;

    if (token.startsWith("[S")) {
      const labels = token.slice(1, -1).split(/\s*,\s*/);
      nodes.push(
        <span key={`${keyPrefix}-cite-${match.index}`} className="inline-flex gap-0.5 align-baseline">
          {labels.map((label) =>
            props.validLabels.has(label) ? (
              <button
                key={label}
                type="button"
                onClick={() => props.onCite(label)}
                title={`Show source ${label}`}
                className={cx(
                  "mx-px inline-flex h-[18px] items-center rounded border px-1 font-mono text-[10px] font-semibold transition-colors",
                  props.highlighted === label
                    ? "border-accent bg-accent text-canvas"
                    : "border-accent/40 bg-accent-soft text-accent hover:border-accent hover:bg-accent/20",
                )}
              >
                {label}
              </button>
            ) : (
              <span key={label} className="text-ink-faint">
                [{label}]
              </span>
            ),
          )}
        </span>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${match.index}`} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <code key={`${keyPrefix}-c-${match.index}`} className="rounded bg-panel-raised px-1 py-0.5 font-mono text-[0.85em] text-accent">
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function AnswerText(props: Props) {
  const blocks = props.text.split(/\n{2,}/).filter((block) => block.trim().length > 0);

  return (
    <div className="space-y-3 text-[13.5px] leading-relaxed text-ink/95">
      {blocks.map((block, blockIndex) => {
        const lines = block.split("\n");
        const isList = lines.every((line) => /^\s*([-*\u2022]|\d+\.)\s+/.test(line));

        if (isList) {
          return (
            <ul key={blockIndex} className="space-y-1.5 pl-1">
              {lines.map((line, lineIndex) => (
                <li key={lineIndex} className="flex gap-2">
                  <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-accent/60" />
                  <span>{renderInline(line.replace(/^\s*([-*\u2022]|\d+\.)\s+/, ""), props, `${blockIndex}-${lineIndex}`)}</span>
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={blockIndex} className="whitespace-pre-wrap">
            {renderInline(block, props, String(blockIndex))}
          </p>
        );
      })}
    </div>
  );
}
