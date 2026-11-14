import type { FormulaDiagnostic } from "@t2code/shared/formula";

/** 1-based line and column of a UTF-16 offset. */
export function positionOf(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  const line = before.split("\n").length;
  return { line, column: before.length - (before.lastIndexOf("\n") + 1) + 1 };
}

export interface Segment {
  readonly text: string;
  readonly message?: string;
}

/** Splits the source at diagnostic spans so the backdrop can underline them; first message wins on overlap. */
export function segmentsOf(
  source: string,
  diagnostics: ReadonlyArray<Pick<FormulaDiagnostic, "start" | "end" | "message">>,
): ReadonlyArray<Segment> {
  const spans = [...diagnostics]
    .map((entry) => ({
      start: Math.max(0, Math.min(entry.start, source.length)),
      end: Math.max(0, Math.min(entry.end, source.length)),
      message: entry.message,
    }))
    .filter((entry) => entry.end > entry.start)
    .sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let at = 0;
  for (const span of spans) {
    const start = Math.max(span.start, at);
    if (span.end <= start) continue;
    if (start > at) out.push({ text: source.slice(at, start) });
    out.push({ text: source.slice(start, span.end), message: span.message });
    at = span.end;
  }
  if (at < source.length) out.push({ text: source.slice(at) });
  return out;
}

export interface MappedDetail {
  readonly start: number;
  readonly end: number;
  readonly message: string;
}

const DETAIL = /^(\d+):(\d+) ([\s\S]*)$/;
const WORD_END = /[\s(),."]/;

/**
 * Maps the server's `"{line}:{column} {message}"` refusal back to a span of the source it was
 * given. The span runs to the end of the word at that position, at least one character.
 */
export function mapServerDetail(detail: string, source: string): MappedDetail | null {
  const match = DETAIL.exec(detail);
  if (match === null) return null;
  const line = Number(match[1]);
  const column = Number(match[2]);
  const lines = source.split("\n");
  if (line < 1 || line > lines.length) return null;
  let start = 0;
  for (let index = 0; index < line - 1; index++) start += lines[index]!.length + 1;
  start += Math.min(column - 1, lines[line - 1]!.length);
  let end = start + 1;
  if (source[start] === '"') {
    const close = source.indexOf('"', start + 1);
    end = close === -1 ? source.length : close + 1;
  } else while (end < source.length && !WORD_END.test(source[end]!)) end++;
  return { start, end: Math.min(end, source.length), message: match[3]! };
}

export const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
