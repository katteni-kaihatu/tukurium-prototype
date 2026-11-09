import type { DiagnosticSummary } from "@tukurium/repo-model";
import styles from "./ResourcesPanel.module.css";

export interface Badge {
  tone: "error" | "warning" | "nestedError" | "nestedWarning";
  label: string;
}

/**
 * 問題の印の中身（計画 §8.6）。自分の問題（塗りつぶし）と、中や関係するものの問題（輪郭）を分ける。
 * `inside` は「中」の呼び方（Resources は「中や関係するもの」、Hierarchy は「中」）。
 */
export function badgeFor(
  s: DiagnosticSummary | undefined,
  inside = "中や関係するもの",
): Badge | null {
  if (!s) return null;
  if (s.errors > 0) return { tone: "error", label: `エラー ${s.errors} 件` };
  if (s.warnings > 0) return { tone: "warning", label: `注意 ${s.warnings} 件` };
  if (s.nestedErrors > 0)
    return { tone: "nestedError", label: `${inside}にエラー ${s.nestedErrors} 件` };
  if (s.nestedWarnings > 0)
    return { tone: "nestedWarning", label: `${inside}に注意 ${s.nestedWarnings} 件` };
  return null;
}

/** 問題の印（色だけに頼らず、title と aria-label で件数を伝える） */
export function BadgeDot({ badge, inline }: { badge: Badge | null; inline?: boolean }) {
  if (!badge) return null;
  return (
    <span
      className={inline ? styles.badgeInline : styles.errorDot}
      data-tone={badge.tone}
      role="img"
      aria-label={badge.label}
      title={badge.label}
    />
  );
}
