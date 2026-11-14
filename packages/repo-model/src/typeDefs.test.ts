import { conformValue, type ValueSchema, validateValue } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ProjectDependencyGraph, usersOf } from "./dependencyGraph";
import { checkProjectReferences } from "./diagnostics/references";
import { collectSelection, extractInto } from "./extract";
import { checkFieldValues } from "./fieldTypes";
import { fromFiles, toFiles } from "./files";
import { librarySnapshot, packageKokoStates, packageTypeDefs } from "./packageDependency";
import { packageManifest } from "./packageManifest";
import { ProjectDoc } from "./projectDoc";
import { ResourcePathIndex } from "./resourcePath";
import { emptyProject } from "./samples";
import type { ProjectSnapshot } from "./schema";

const CODE = "export interface Card { suit: string; rank: number }\n";

function project(): ProjectSnapshot {
  const p = emptyProject("型の定義");
  p.types = [{ id: "td_cards", name: "Cards", code: CODE }];
  p.kokostates = [
    {
      id: "ks_hand",
      name: "Hand",
      typeDefs: ["td_cards"],
      fields: [{ id: "f_cards", name: "cards", type: "Card[]", default: [] }],
    },
  ];
  p.folders = [{ id: "fld_types", name: "Types", parent: null }];
  p.placement = { td_cards: "fld_types" };
  return p;
}

const selection = (patch: Partial<Parameters<typeof collectSelection>[1]> = {}) => ({
  outputs: [],
  kokostates: [],
  systems: [],
  materials: [],
  assets: [],
  ...patch,
});

describe("型の定義のリソース（ADR 0065）", () => {
  it("Git には types/<ID>.d.ts で保存し、読み込むと元どおりに戻る", () => {
    const snap = project();
    const files = toFiles(snap);
    expect(files["types/td_cards.d.ts"]).toBe(CODE);
    expect(JSON.parse(files["types/td_cards.json"] ?? "{}")).toEqual({
      id: "td_cards",
      name: "Cards",
    });
    expect(JSON.parse(files["kokostates/ks_hand.json"] ?? "{}").typeDefs).toEqual(["td_cards"]);
    const back = fromFiles(files);
    expect(back.types).toEqual(snap.types);
    expect(back.kokostates).toEqual(snap.kokostates);
  });

  it("論理パスを持つ（拡張子は .types）", () => {
    const index = ResourcePathIndex.fromSnapshot(project());
    expect(index.pathOf("td_cards")).toBe("/Types/Cards.types");
    expect(index.resolve("/Types/Cards.types", "ks_hand")).toMatchObject({
      ok: true,
      id: "td_cards",
      kind: "typedef",
    });
  });

  it("作る・名前を変える・動かす・消す。共同編集でも同じ中身になる", () => {
    const a = new ProjectDoc();
    a.load(project());
    const id = a.addTypeDef("Pieces", "export type Piece = string;\n");
    a.moveResource(id, "fld_types");
    expect(() => a.renameTypeDef(id, "Cards")).toThrow(/同じ場所/);
    a.renameTypeDef(id, "Board");
    a.code(id)?.insert(0, "// 盤\n");
    const hand = a.kokostate("ks_hand");
    if (hand) a.updateKokoState({ ...hand, typeDefs: ["td_cards", id] });

    const b = new ProjectDoc();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.snapshot().types?.find((t) => t.id === id)).toEqual({
      id,
      name: "Board",
      code: "// 盤\nexport type Piece = string;\n",
    });
    expect(ResourcePathIndex.fromSnapshot(b.snapshot()).pathOf(id)).toBe("/Types/Board.types");

    // 消すと、使っていた KokoState の一覧からも外れる
    a.removeTypeDef(id);
    expect(a.typeDef(id)).toBeUndefined();
    expect(a.code(id)).toBeUndefined();
    expect(a.kokostate("ks_hand")?.typeDefs).toEqual(["td_cards"]);
    // 保存した形に戻せる
    a.restoreTypeDef({ id, name: "Board" }, "export type Piece = number;\n");
    expect(a.code(id)?.toString()).toBe("export type Piece = number;\n");
    const again = new ProjectDoc();
    again.load(a.snapshot());
    expect(again.snapshot()).toEqual(a.snapshot());
  });

  it("依存グラフ：KokoState から、使う型の定義へ辺を張る。ない型の定義は問題にする", () => {
    const snap = project();
    const graph = ProjectDependencyGraph.fromSnapshot(snap);
    expect(usersOf(graph, { kind: "typedef", id: "td_cards" })).toEqual([
      { kind: "kokostate", id: "ks_hand" },
    ]);
    expect(checkProjectReferences(snap)).toEqual([]);
    snap.types = [];
    expect(checkProjectReferences(snap).map((d) => [d.code, d.subject, d.location])).toEqual([
      [
        "missing-typedef",
        { kind: "kokostate", id: "ks_hand" },
        { kind: "property", path: ["typeDefs"] },
      ],
    ]);
  });

  it("抽出：KokoState が使う型の定義も一緒に持っていく。ID を振り直したら、KokoState の一覧も付け替える", () => {
    const src = project();
    expect(collectSelection(src, selection({ kokostates: ["ks_hand"] })).types).toEqual([
      "td_cards",
    ]);
    // 取り込み先に、同じ ID の別の型の定義がある
    const dst = emptyProject("先");
    dst.types = [{ id: "td_cards", name: "Other", code: "export type Other = 1;\n" }];
    const merged = extractInto(
      src,
      selection({ kokostates: ["ks_hand"] }),
      { repoId: "r", repoName: "元", commit: "c" },
      dst,
    );
    const moved = merged.types?.find((t) => t.name === "Cards");
    expect(moved?.id).not.toBe("td_cards");
    expect(moved?.code).toBe(CODE);
    expect(merged.kokostates.find((k) => k.name === "Hand")?.typeDefs).toEqual([moved?.id]);
    // 同じ中身なら、二重に入れない
    const again = extractInto(
      src,
      selection({ kokostates: ["ks_hand"] }),
      { repoId: "r", repoName: "元", commit: "c" },
      emptyProject("空"),
    );
    expect(again.types).toEqual(src.types);
    expect(ResourcePathIndex.fromSnapshot(again).pathOf("td_cards")).toBe("/Types/Cards.types");
  });

  it("ライブラリ：含めた KokoState が使う型の定義も配る。使う側では、Package と版で区切った ID になる", () => {
    const lib = project();
    lib.outputs = [
      {
        id: "out_lib",
        name: "cards",
        kind: "library",
        systems: [],
        keep: [],
        resources: ["ks_hand"],
      },
    ];
    const manifest = packageManifest(lib, "out_lib");
    expect(manifest.exports.map((e) => `${e.kind}:${e.path}`)).toEqual([
      "kokostate:/Hand.koko",
      "typedef:/Types/Cards.types",
    ]);
    const dependency = { alias: "cards", packageId: "w1", version: 2, contentHash: "h" };
    const ready = { status: "ready" as const, dependency, manifest };
    expect(packageKokoStates([ready])[0]?.typeDefs).toEqual(["pkg:w1@2/td_cards"]);
    expect(packageTypeDefs([ready])).toEqual([
      {
        id: "pkg:w1@2/td_cards",
        name: "Cards",
        code: CODE,
        alias: "cards",
        path: "/Types/Cards.types",
      },
    ]);
    const inside = librarySnapshot(ready);
    expect(inside.types).toEqual([{ id: "pkg:w1@2/td_cards", name: "Cards", code: CODE }]);
    expect(inside.kokostates[0]?.typeDefs).toEqual(["pkg:w1@2/td_cards"]);
  });
});

describe("型の定義を変えたあとの値を、型に合わせる（ADR 0065）", () => {
  const card = (fields: [string, ValueSchema, boolean?][]): ValueSchema => ({
    kind: "list",
    item: {
      kind: "record",
      fields: fields.map(([name, schema, optional]) => ({
        name,
        schema,
        optional: optional === true,
      })),
    },
  });
  const num: ValueSchema = { kind: "number" };
  const str: ValueSchema = { kind: "string" };
  const old = [{ suit: "spade", rank: 1 }];

  it("足したフィールドは空の値で埋め、消したフィールドは捨てる。省略できるフィールドは埋めない", () => {
    const next = card([
      ["suit", str],
      ["joker", { kind: "boolean" }],
      ["tags", { kind: "list", item: str }],
      ["note", { kind: "union", options: [str, { kind: "undefined" }] }, true],
    ]);
    const conformed = conformValue(next, old);
    expect(conformed).toEqual([{ suit: "spade", joker: false, tags: [] }]);
    expect(validateValue(next, conformed)).toBeNull();
    // 元の値は変えない
    expect(old).toEqual([{ suit: "spade", rank: 1 }]);
  });

  it("型が変わったフィールドは、そのまま残す（問題として出る）", () => {
    const next = card([
      ["suit", str],
      ["rank", str],
    ]);
    const conformed = conformValue(next, old);
    expect(conformed).toEqual(old);
    expect(validateValue(next, conformed)).toMatch(/\[0\]\.rank：文字ではありません/);
  });

  it("入れ子（マップ・Map・組み合わせ）の中も合わせる", () => {
    const item = (
      card([
        ["suit", str],
        ["rank", num],
        ["joker", { kind: "boolean" }],
      ]) as { item: ValueSchema }
    ).item;
    expect(
      conformValue({ kind: "map", value: item }, { a: { suit: "x", rank: 1, extra: 1 } }),
    ).toEqual({
      a: { suit: "x", rank: 1, joker: false },
    });
    expect(
      conformValue(
        { kind: "Map", key: str, value: item },
        new Map([["a", { suit: "x", rank: 1 }]]),
      ),
    ).toEqual(new Map([["a", { suit: "x", rank: 1, joker: false }]]));
    const optional: ValueSchema = { kind: "union", options: [item, { kind: "undefined" }] };
    expect(conformValue(optional, undefined)).toBeUndefined();
    expect(conformValue(optional, { suit: "x", rank: 1 })).toEqual({
      suit: "x",
      rank: 1,
      joker: false,
    });
  });

  it("値の確かめは、合わせた形で行う。型が変わった所だけが問題になる", () => {
    const p = project();
    const out = p.outputs[0]?.id ?? "";
    p.entities = [
      {
        id: "e",
        name: "e",
        parent: null,
        output: out,
        order: 0,
        states: { ks_hand: { f_cards: old } },
      },
    ];
    const added = card([
      ["suit", str],
      ["rank", num],
      ["joker", { kind: "boolean" }],
    ]);
    expect(checkFieldValues(p, { ks_hand: { f_cards: added } })).toEqual([]);
    const changed = card([
      ["suit", str],
      ["rank", str],
    ]);
    expect(checkFieldValues(p, { ks_hand: { f_cards: changed } }).map((d) => d.code)).toEqual([
      "value-type-mismatch",
    ]);
  });
});
