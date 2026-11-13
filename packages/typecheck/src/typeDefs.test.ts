import {
  emptyProject,
  type PackageDependency,
  type PackageResolution,
  type ProjectSnapshot,
  packageManifest,
} from "@tukurium/repo-model";
import { hostApiDeclarations } from "@tukurium/runtime";
import { describe, expect, it } from "vitest";
import { TypeChecker } from "./checker";
import { exportedTypeNames } from "./declarations";
import { nodeTypeCheckerOptions } from "./node";

const checker = new TypeChecker(nodeTypeCheckerOptions());
const host = hostApiDeclarations();
const run = (snapshot: ProjectSnapshot, packages = new Map<string, PackageResolution>()) =>
  checker.checkAll({ snapshot, packages, hostDeclarations: host });

const CARDS = [
  'export type Suit = "spade" | "heart";',
  "export interface Card {",
  "  suit: Suit;",
  "  rank: number;",
  "  joker?: boolean;",
  "}",
  "/** 型の引数を持つ型 */",
  "export type Box<T> = { value: T };",
  "type Hidden = number;",
].join("\n");

/** 型の定義「Cards」と、それを使う KokoState「Hand」 */
function project(patch: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  const p = emptyProject("型の定義");
  p.types = [{ id: "td_cards", name: "Cards", code: CARDS }];
  p.kokostates = [
    {
      id: "ks_hand",
      name: "Hand",
      typeDefs: ["td_cards"],
      fields: [
        { id: "f_cards", name: "cards", type: "Card[]", default: [] },
        { id: "f_box", name: "box", type: "Box<Suit>", default: { value: "spade" } },
      ],
    },
  ];
  return { ...p, ...patch };
}

const messages = (snapshot: ProjectSnapshot) => run(snapshot).diagnostics.map((d) => d.message);

describe("型の定義のリソース（ADR 0065）", () => {
  it("公開している型の名前を読む", () => {
    expect(exportedTypeNames(CARDS)).toEqual(["Suit", "Card", "Box"]);
  });

  it("KokoState のフィールドの型から、使う型の定義の型を使える", () => {
    const { schemas, diagnostics } = run(project());
    expect(diagnostics.map((d) => d.message)).toEqual([]);
    const suit = {
      kind: "union",
      options: [
        { kind: "literal", value: "spade" },
        { kind: "literal", value: "heart" },
      ],
    };
    expect(schemas.ks_hand?.f_cards).toEqual({
      kind: "list",
      item: {
        kind: "record",
        fields: [
          { name: "suit", optional: false, schema: suit },
          { name: "rank", optional: false, schema: { kind: "number" } },
          {
            name: "joker",
            optional: true,
            schema: { kind: "union", options: [{ kind: "boolean" }, { kind: "undefined" }] },
          },
        ],
      },
    });
    expect(schemas.ks_hand?.f_box).toEqual({
      kind: "record",
      fields: [{ name: "value", optional: false, schema: suit }],
    });
  });

  it("使う型の定義に入れていない型は、知らない名前になる", () => {
    const p = project();
    const hand = p.kokostates[0];
    if (hand) hand.typeDefs = [];
    expect(messages(p).some((m) => /cards の型：.*'Card'/.test(m))).toBe(true);
  });

  it("名前を変えたり、フォルダへ動かしたりしても、使っている所は切れない", () => {
    const p = project();
    const t = p.types?.[0];
    if (t) t.name = "Playing Cards";
    p.folders = [{ id: "fld", name: "Types", parent: null }];
    p.placement = { td_cards: "fld" };
    const { schemas, diagnostics } = run(p);
    expect(diagnostics.map((d) => d.message)).toEqual([]);
    expect(schemas.ks_hand?.f_cards?.kind).toBe("list");
  });

  it("System から型のとおりに読み書きでき、打ち間違いが型エラーになる。型の定義を import もできる", () => {
    const code = [
      'import Hand from "./Hand.koko";',
      'import type { Card } from "./Cards.types";',
      "export default system({",
      "  query: { with: [Hand] },",
      "  onUpdate(e) {",
      "    const h = e.get(Hand);",
      '    const card: Card = { suit: "spade", rank: 1 };',
      "    h.cards.push(card);",
      '    h.cards.push({ suit: "club", rank: 2 });',
      "    h.cards[0]!.rnak = 3;",
      '    h.box.value = "heart";',
      "  },",
      "});",
    ].join("\n");
    const found = run(project({ systems: [{ id: "sys_a", name: "A", code }] })).diagnostics;
    expect(found.map((d) => (d.location?.kind === "script" ? d.location.line : d.message))).toEqual(
      [9, 10],
    );
  });

  it("型の定義には type と interface だけを書ける。公開する型は、保存できる型に限る", () => {
    const p = project();
    const t = p.types?.[0];
    if (t)
      t.code = [
        CARDS,
        "declare function shuffle(cards: Card[]): Card[];",
        "export type OnDraw = (card: Card) => void;",
        "export interface Deck { cards: Card[]; draw(): Card }",
        "export type Broken = Missing[];",
      ].join("\n");
    const found = run(p).diagnostics.filter((d) => d.subject.kind === "typedef");
    expect(found.map((d) => [d.code, d.location?.kind === "script" && d.location.line])).toEqual([
      ["ts2304", 13],
      ["typedef-unsupported", 10],
      ["typedef-unsaveable", 11],
      ["typedef-unsaveable", 12],
    ]);
    expect(found[2]?.message).toMatch(/OnDraw：関数は保存できません/);
    expect(found[3]?.message).toMatch(/Deck：draw：関数は保存できません/);
    // 型の定義に問題があっても、問題のない型を使うフィールドは使える
    expect(run(p).schemas.ks_hand?.f_cards?.kind).toBe("list");
  });

  it("二つの型の定義が同じ名前の型を公開していたら、使う KokoState の問題にする", () => {
    const p = project();
    p.types?.push({ id: "td_other", name: "Other", code: "export type Card = string;" });
    const hand = p.kokostates[0];
    if (hand) hand.typeDefs = ["td_cards", "td_other"];
    const found = run(p).diagnostics.filter(
      (d) => d.location?.kind === "property" && d.location.path[0] === "typeDefs",
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.subject).toEqual({ kind: "kokostate", id: "ks_hand" });
  });

  it("ライブラリの型の定義を、使う側の KokoState から使える。ライブラリの KokoState の型も読める", () => {
    const lib = project();
    lib.outputs = [
      {
        id: "out_lib",
        name: "cards",
        kind: "library",
        systems: [],
        keep: [],
        // 型の定義は含めていないが、含めた KokoState が使うので、一緒に入る
        resources: ["ks_hand"],
      },
    ];
    const manifest = packageManifest(lib, "out_lib");
    expect(manifest.exports.map((e) => [e.kind, e.path])).toEqual([
      ["kokostate", "/Hand.koko"],
      ["typedef", "/Cards.types"],
    ]);
    const dependency: PackageDependency = {
      alias: "cards",
      packageId: "w_cards",
      version: 1,
      contentHash: "h",
    };
    const packages = new Map<string, PackageResolution>([
      ["cards", { status: "ready", dependency, manifest }],
    ]);
    const user = emptyProject("使う側");
    user.dependencies = [dependency];
    user.kokostates = [
      {
        id: "ks_table",
        name: "Table",
        typeDefs: ["pkg:w_cards@1/td_cards"],
        fields: [{ id: "f_top", name: "top", type: "Card | undefined", default: undefined }],
      },
    ];
    user.systems = [
      {
        id: "sys_a",
        name: "A",
        code: [
          'import Hand from "@cards/Hand.koko";',
          'import Table from "./Table.koko";',
          'import type { Suit } from "@cards/Cards.types";',
          "export default system({",
          "  query: { with: [Hand, Table] },",
          "  onUpdate(e) {",
          '    const suit: Suit = "heart";',
          "    e.get(Table).top = e.get(Hand).cards[0];",
          "    e.get(Hand).cards.push({ suit, rank: 'x' });",
          "  },",
          "});",
        ].join("\n"),
      },
    ];
    const { schemas, diagnostics } = run(user, packages);
    expect(
      diagnostics.map((d) => (d.location?.kind === "script" ? d.location.line : d.message)),
    ).toEqual([9]);
    expect(schemas["pkg:w_cards@1/ks_hand"]?.f_cards?.kind).toBe("list");
    expect(schemas.ks_table?.f_top?.kind).toBe("union");
  });
});
