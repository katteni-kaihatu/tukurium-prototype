import type { DiagnosticView, Severity } from "@tukurium/repo-model";

/**
 * 問題パネルの絞り込みとまとめ方（計画 §8.2）。画面から切り離した純粋関数にして、テストで守る。
 * 対象の名前・フォルダ・アウトプットは、制作データを知っている呼び出し側が ProblemContext で渡す。
 */

export type ProblemGroupBy = "none" | "resource" | "folder" | "output" | "provider" | "code";

export interface ProblemFilter {
  /** メッセージ・場所・コードのどれかに含まれる文字（大文字・小文字は区別しない） */
  text: string;
  severities: readonly Severity[];
  phases: readonly ("authoring" | "runtime")[];
  /** 編集前の古い結果も出す */
  showStale: boolean;
  /** このアウトプットに関係するものだけにする（null なら絞らない） */
  outputId: string | null;
}

export interface ProblemContext {
  /** 一覧に出す場所の文字（「Shoot.js 4 行目」「/Combat/States/Gun.koko」など） */
  placeOf(d: DiagnosticView): string;
  /** 問題の対象のリソースの呼び方（行番号などを含まない。リソースでまとめたときの見出し） */
  subjectOf(d: DiagnosticView): string;
  /**
   * 問題の対象が属するアウトプット。どのアウトプットにも属さない対象（KokoState・素材など、
   * いくつものアウトプットで使われうるもの）は空にし、アウトプットで絞っても残す。
   */
  outputsOf(d: DiagnosticView): readonly string[];
  /** 対象が入っているフォルダの論理パス。フォルダに入らない対象（Entity・アウトプット）は null */
  folderOf(d: DiagnosticView): string | null;
  outputName(id: string): string;
}

export const DEFAULT_FILTER: ProblemFilter = {
  text: "",
  severities: ["error", "warning", "info"],
  phases: ["authoring", "runtime"],
  showStale: true,
  outputId: null,
};

/** 診断の担い手の、画面での呼び方 */
export const PROVIDER_LABEL: Record<string, string> = {
  structure: "構造",
  references: "参照",
  packages: "ライブラリ",
  script: "スクリプト",
  runtime: "実行",
};

export const GROUP_LABEL: Record<ProblemGroupBy, string> = {
  none: "まとめない",
  resource: "リソース",
  folder: "フォルダ",
  output: "アウトプット",
  provider: "出どころ",
  code: "種類のコード",
};

export function filterProblems(
  items: readonly DiagnosticView[],
  filter: ProblemFilter,
  ctx: ProblemContext,
): DiagnosticView[] {
  const text = filter.text.trim().toLowerCase();
  return items.filter((d) => {
    if (!filter.severities.includes(d.severity)) return false;
    if (!filter.phases.includes(d.phase)) return false;
    if (!filter.showStale && d.freshness === "stale") return false;
    if (filter.outputId !== null) {
      const outputs = ctx.outputsOf(d);
      if (outputs.length > 0 && !outputs.includes(filter.outputId)) return false;
    }
    if (text !== "") {
      const hay = `${d.message}\n${ctx.placeOf(d)}\n${d.code}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}

export interface ProblemGroup {
  key: string;
  label: string;
  items: DiagnosticView[];
}

/** まとめ方に合わせて分ける。グループは名前の順、中の並びは元の順のまま */
export function groupProblems(
  items: readonly DiagnosticView[],
  by: ProblemGroupBy,
  ctx: ProblemContext,
): ProblemGroup[] {
  if (by === "none") return items.length === 0 ? [] : [{ key: "", label: "", items: [...items] }];
  const groups = new Map<string, ProblemGroup>();
  const add = (key: string, label: string, d: DiagnosticView) => {
    let g = groups.get(key);
    if (!g) {
      g = { key, label, items: [] };
      groups.set(key, g);
    }
    g.items.push(d);
  };
  for (const d of items) {
    switch (by) {
      case "resource":
        add(`${d.subject.kind}:${d.subject.id}`, ctx.subjectOf(d), d);
        break;
      case "folder": {
        const folder = ctx.folderOf(d);
        add(folder ?? "", folder ?? "（フォルダの外）", d);
        break;
      }
      case "output": {
        const outputs = ctx.outputsOf(d);
        if (outputs.length === 0) add("", "（アウトプットに属さない）", d);
        else for (const id of outputs) add(id, ctx.outputName(id), d);
        break;
      }
      case "provider":
        add(d.provider, PROVIDER_LABEL[d.provider] ?? d.provider, d);
        break;
      case "code":
        add(d.code, d.code, d);
        break;
    }
  }
  // 「フォルダの外」「アウトプットに属さない」（key が空）は最後に置く
  return [...groups.values()].sort(
    (a, b) => Number(a.key === "") - Number(b.key === "") || a.label.localeCompare(b.label, "ja"),
  );
}

/** 論理パスから、入っているフォルダのパス（いちばん上なら "/"） */
export function folderOfPath(path: string | null): string | null {
  if (path === null) return null;
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}
