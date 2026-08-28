"use client";

import type { ReactNode } from "react";
import { CITATION_PATTERN, parseCitationToken } from "@/lib/sources";
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

// Built from the shared citation pattern so the renderer and the grader agree on
// what a citation is; drifting apart once already cost every timestamped citation
// its clickable pill.
const INLINE = new RegExp(`(${CITATION_PATTERN.source})|(\\*\\*[^*]+\\*\\*)|(\`[^\`]+\`)`, "g");

function renderInline(text: string, props: Props, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;

  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [token] = match;

    if (token.startsWith("[")) {
      // Rendered in written order, so a span stays next to the label it belongs to.
      const { items } = parseCitationToken(token);
      nodes.push(
        <span key={`${keyPrefix}-cite-${match.index}`} className="inline-flex items-baseline gap-0.5 align-baseline">
          {items.map((item, itemIndex) =>
            item.kind === "timecode" ? (
              <span key={itemIndex} className="mr-0.5 font-mono text-[10px] text-ink-faint">
                {item.value}
              </span>
            ) : props.validLabels.has(item.value) ? (
              <button
                key={itemIndex}
                type="button"
                onClick={() => props.onCite(item.value)}
                title={`Show source ${item.value}`}
                className={cx(
                  "mx-px inline-flex h-[18px] items-center rounded border px-1 font-mono text-[10px] font-semibold transition-colors",
                  props.highlighted === item.value
                    ? "border-accent bg-accent text-canvas"
                    : "border-accent/40 bg-accent-soft text-accent hover:border-accent hover:bg-accent/20",
                )}
              >
                {item.value}
              </button>
            ) : (
              <span key={itemIndex} className="text-ink-faint">
                [{item.value}]
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
