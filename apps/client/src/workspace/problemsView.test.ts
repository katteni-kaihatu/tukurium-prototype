import { type DiagnosticView, makeDiagnostic, type ResourceRef } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTER,
  filterProblems,
  folderOfPath,
  groupProblems,
  type ProblemContext,
  problemDetail,
} from "./problemsView";

const view = (
  over: Partial<{
    subject: ResourceRef;
    severity: "error" | "warning";
    phase: "authoring" | "runtime";
    provider: string;
    code: string;
    message: string;
    freshness: "current" | "stale";
  }> = {},
): DiagnosticView => ({
  ...makeDiagnostic({
    code: over.code ?? "x",
    severity: over.severity ?? "error",
    phase: over.phase ?? "authoring",
    provider: over.provider ?? "script",
    subject: over.subject ?? { kind: "system", id: "sys_a" },
    location: null,
    related: [],
    message: over.message ?? "問題",
  }),
  freshness: over.freshness ?? "current",
});

/** sys_a は out_gun、ent_1 は out_range。KokoState はどのアウトプットにも属さない */
const ctx: ProblemContext = {
  placeOf: (d) =>
    ({
      sys_a: "Shoot.ts 4 行目",
      ent_1: "Entity「的」",
      k_gun: "/Combat/States/Gun.koko",
    })[d.subject.id] ?? d.subject.id,
  subjectOf: (d) => (d.subject.id === "sys_a" ? "/Combat/Shoot.ts" : ctx.placeOf(d)),
  outputsOf: (d) =>
    ({ sys_a: ["out_gun"], ent_1: ["out_range"] })[d.subject.id as "sys_a" | "ent_1"] ?? [],
  folderOf: (d) =>
    ({ sys_a: "/Combat", k_gun: "/Combat/States" })[d.subject.id as "sys_a" | "k_gun"] ?? null,
  refName: (r) => (r.id === "k_gun" ? "/Combat/States/Gun.koko" : r.id),
  outputName: (id) => ({ out_gun: "銃", out_range: "射撃場" })[id as "out_gun"] ?? id,
};

const sys = view({ message: "構文の誤り", subject: { kind: "system", id: "sys_a" } });
const ent = view({
  message: "マテリアルが見つかりません",
  provider: "references",
  code: "missing-material",
  severity: "warning",
  subject: { kind: "entity", id: "ent_1" },
});
const koko = view({
  message: "同じ名前があります",
  provider: "structure",
  code: "name-collision",
  subject: { kind: "kokostate", id: "k_gun" },
});
const stopped = view({
  message: "止まりました",
  provider: "runtime",
  phase: "runtime",
  freshness: "stale",
  subject: { kind: "system", id: "sys_a" },
});
const all = [sys, ent, koko, stopped];

describe("filterProblems", () => {
  it("初めの設定では、すべて出す", () => {
    expect(filterProblems(all, DEFAULT_FILTER, ctx)).toEqual(all);
  });

  it("種類・時点で絞る", () => {
    expect(filterProblems(all, { ...DEFAULT_FILTER, severities: ["warning"] }, ctx)).toEqual([ent]);
    expect(filterProblems(all, { ...DEFAULT_FILTER, phases: ["runtime"] }, ctx)).toEqual([stopped]);
  });

  it("古い結果を隠せる", () => {
    expect(filterProblems(all, { ...DEFAULT_FILTER, showStale: false }, ctx)).toEqual([
      sys,
      ent,
      koko,
    ]);
  });

  it("アウトプットで絞っても、どのアウトプットにも属さない対象は残す", () => {
    expect(filterProblems(all, { ...DEFAULT_FILTER, outputId: "out_range" }, ctx)).toEqual([
      ent,
      koko,
    ]);
  });

  it("メッセージ・場所・コードから、大文字と小文字を区別せずに探す", () => {
    const f = (text: string) => filterProblems(all, { ...DEFAULT_FILTER, text }, ctx);
    expect(f("マテリアル")).toEqual([ent]);
    expect(f("states/gun")).toEqual([koko]);
    expect(f("NAME-COLLISION")).toEqual([koko]);
    expect(f("  ")).toEqual(all);
  });
});

describe("groupProblems", () => {
  const labels = (by: Parameters<typeof groupProblems>[1]) =>
    groupProblems(all, by, ctx).map((g) => [g.label, g.items.length]);

  it("まとめないときは、一つのグループにそのまま入れる", () => {
    expect(groupProblems(all, "none", ctx)).toEqual([{ key: "", label: "", items: all }]);
    expect(groupProblems([], "none", ctx)).toEqual([]);
  });

  it("リソースごとにまとめる（同じ System の問題は一つに）", () => {
    expect(labels("resource")).toEqual([
      ["/Combat/Shoot.ts", 2],
      ["/Combat/States/Gun.koko", 1],
      ["Entity「的」", 1],
    ]);
  });

  it("フォルダごと・アウトプットごと・出どころごとにまとめる", () => {
    expect(labels("folder")).toEqual([
      ["/Combat", 2],
      ["/Combat/States", 1],
      ["（フォルダの外）", 1],
    ]);
    expect(labels("output")).toEqual([
      ["射撃場", 1],
      ["銃", 2],
      ["（アウトプットに属さない）", 1],
    ]);
    expect(labels("provider")).toEqual([
      ["スクリプト", 1],
      ["構造", 1],
      ["参照", 1],
      ["実行", 1],
    ]);
  });
});

describe("folderOfPath", () => {
  it("入っているフォルダのパスを返す", () => {
    expect(folderOfPath("/Combat/States/Gun.koko")).toBe("/Combat/States");
    expect(folderOfPath("/Gun.koko")).toBe("/");
    expect(folderOfPath(null)).toBeNull();
  });
});

describe("problemDetail", () => {
  it("対象・場所・関係するもの・時点・出どころ・コードを、分かるものだけ出す", () => {
    const d: DiagnosticView = {
      ...makeDiagnostic({
        code: "query-kokostate-missing",
        severity: "error",
        phase: "authoring",
        provider: "script",
        subject: { kind: "system", id: "sys_a" },
        location: { kind: "script", line: 4, symbol: "Gun" },
        related: [{ kind: "kokostate", id: "k_gun" }],
        message: "見つかりません",
      }),
      freshness: "stale",
    };
    expect(problemDetail(d, ctx)).toEqual([
      ["対象", "/Combat/Shoot.ts"],
      ["場所", "4 行目 「Gun」"],
      ["関係するもの", "/Combat/States/Gun.koko"],
      ["時点", "作っている途中（編集前の結果）"],
      ["出どころ", "スクリプト"],
      ["種類のコード", "query-kokostate-missing"],
    ]);
  });

  it("欄の場所はパスでつなぐ", () => {
    const rows = problemDetail(
      { ...ent, location: { kind: "property", path: ["Mesh", "material"] } },
      ctx,
    );
    expect(rows).toContainEqual(["場所", "Mesh › material"]);
  });
});
