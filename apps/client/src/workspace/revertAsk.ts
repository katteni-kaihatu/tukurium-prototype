import type { DiffEntry } from "./diffView";

/** 戻す範囲を、確認の文に出す */
function revertWhat(entry: DiffEntry): string {
  const line = entry.lines.length === 1 ? entry.lines[0] : undefined;
  if (line?.section) return `${entry.name} の ${line.section.label} の ${line.label}`;
  if (line) return `${entry.name} の ${line.label}`;
  const sections = [...new Set(entry.lines.flatMap((l) => (l.section ? [l.section.label] : [])))];
  if (sections.length === 1 && entry.lines.every((l) => l.section)) {
    return `${entry.name} の ${sections[0]}`;
  }
  return entry.name;
}

/**
 * 戻す前の確認。新しいものは消える、消えたものは戻る、変わったものは保存した形に戻る。
 * 中身がまだ読めていないときは、範囲を言わずに聞く。
 */
export function revertAsk(entry: DiffEntry | null): string {
  if (!entry) return "最後に保存した形に戻しますか？";
  const what = revertWhat(entry);
  if (entry.kind === "added") return `${what} は最後の保存にありません。消しますか？`;
  if (entry.kind === "removed") return `消えた ${what} を、戻しますか？`;
  return `${what} を、最後に保存した形に戻しますか？`;
}
