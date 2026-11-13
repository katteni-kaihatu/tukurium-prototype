import type { FieldValue, KokoStateDef } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BUILTIN } from "./builtins";
import { fromFiles, toFiles } from "./files";
import { stableStringify } from "./packageManifest";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";
import type { ProjectSnapshot } from "./schema";

/**
 * 広げた値（undefined・Date・Map・Set・bigint・NaN・Infinity）を、型の確かめを通さずに入れる。
 * フィールドの型でこれらを書けるようになるのは、型を TypeScript の型の文にしてから（ADR 0065）。
 * ここでは、保存と共同編集が値をそのまま運べることだけを確かめる。
 */
const rich = (v: unknown) => v as FieldValue;

const richValues = () => ({
  f_none: rich(undefined),
  f_nan: rich(Number.NaN),
  f_inf: rich(Number.POSITIVE_INFINITY),
  f_ninf: rich(Number.NEGATIVE_INFINITY),
  f_big: rich(12345678901234567890n),
  f_at: rich(new Date("2026-11-10T00:00:00.000Z")),
  f_board: rich(
    new Map<unknown, unknown>([
      ["a1", { kind: "pawn", moved: undefined }],
      [7, [1, undefined, 3]],
    ]),
  ),
  f_tags: rich(new Set<unknown>(["x", 2n])),
  f_hand: rich([
    { suit: "spade", rank: 1 },
    { suit: "heart", rank: 12, joker: undefined },
  ]),
  f_tagged: rich({ $t: "ふつうのオブジェクト" }),
});

function richProject(): ProjectSnapshot {
  const p = emptyProject("値");
  const out = p.outputs[0]?.id ?? "out";
  const fields = Object.entries(richValues()).map(([id, value]) => ({
    id,
    name: id.slice(2),
    type: "string" as const,
    default: value as string,
  }));
  p.kokostates = [{ id: "ks_rich", name: "Rich", fields }];
  p.entities = [
    {
      id: "ent_a",
      name: "a",
      parent: null,
      output: out,
      order: 0,
      states: {
        ks_rich: richValues(),
        [BUILTIN.Mesh]: {
          shape: "box",
          size: [1, 1, 1],
          material: undefined,
          color: "#ffffff",
          model: undefined,
        },
      },
    },
  ];
  return p;
}

/** undefined の値がキーごと残っているか（toEqual は、undefined のキーと「キーなし」を区別しない） */
function expectKeys(snap: ProjectSnapshot): void {
  const e = snap.entities.find((x) => x.id === "ent_a");
  expect(Object.keys(e?.states.ks_rich ?? {}).sort()).toEqual(Object.keys(richValues()).sort());
  expect(Object.keys(e?.states[BUILTIN.Mesh] ?? {})).toContain("material");
  const hand = e?.states.ks_rich?.f_hand as unknown as Record<string, unknown>[];
  expect(Object.keys(hand[1] ?? {})).toContain("joker");
  expect(Object.keys(snap.kokostates[0]?.fields[0] ?? {})).toContain("default");
}

describe("広げた値を保存・復元する（ADR 0065）", () => {
  it("Git のファイルに書いて読むと、元どおりに戻る", () => {
    const snap = richProject();
    const files = toFiles(snap);
    const back = fromFiles(files);
    expect(back.entities).toEqual(snap.entities);
    expect(back.kokostates).toEqual(snap.kokostates);
    expectKeys(back);

    // ファイルはふつうの JSON で、表せない値だけが "$t" のタグになる
    const out = snap.outputs[0]?.id ?? "";
    const saved = JSON.parse(files[`outputs/${out}/entities/ent_a.json`] ?? "{}");
    expect(saved.states[BUILTIN.Mesh]).toEqual({
      shape: "box",
      size: [1, 1, 1],
      material: { $t: "undefined" },
      color: "#ffffff",
      model: { $t: "undefined" },
    });
    expect(saved.states.ks_rich.f_big).toEqual({ $t: "bigint", v: "12345678901234567890" });
    expect(saved.states.ks_rich.f_at).toEqual({ $t: "Date", v: "2026-11-10T00:00:00.000Z" });
    expect(saved.states.ks_rich.f_tagged).toEqual({
      $t: "object",
      v: { $t: "ふつうのオブジェクト" },
    });
    const koko = JSON.parse(files["kokostates/ks_rich.json"] ?? "{}");
    expect(koko.fields[0].default).toEqual({ $t: "undefined" });
  });

  it("Yjs に入れて別の Doc へ送ると、元どおりに戻る", () => {
    const snap = richProject();
    const a = new ProjectDoc();
    a.load(snap);
    expect(a.snapshot().entities).toEqual(snap.entities);

    const b = new ProjectDoc();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const back = b.snapshot();
    expect(back.entities).toEqual(snap.entities);
    expect(back.kokostates).toEqual(snap.kokostates);
    expectKeys(back);
  });

  it("フィールドを一つ書き換えても、広げた値がそのまま入る", () => {
    const a = new ProjectDoc();
    a.load(richProject());
    const board = new Map<unknown, unknown>([[new Date(0), new Set([1n])]]);
    a.setField("ent_a", "ks_rich", "f_board", rich(board));
    a.setField("ent_a", "ks_rich", "f_big", rich(undefined));
    const b = new ProjectDoc();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const values = b.entity("ent_a")?.states.ks_rich ?? {};
    expect(values.f_board).toEqual(board);
    expect("f_big" in values).toBe(true);
    expect(values.f_big).toBeUndefined();
  });
});

describe("参照の「なし」は undefined（ADR 0065）", () => {
  const refDef = (def: string | undefined): KokoStateDef => ({
    id: "ks_ref",
    name: "Ref",
    fields: [{ id: "f_target", name: "target", type: "entity", default: def }],
  });

  function refProject() {
    const p = emptyProject("参照");
    const out = p.outputs[0]?.id ?? "out";
    p.kokostates = [refDef("ent_b")];
    p.materials = [{ id: "mat_a", name: "赤", color: "#ff0000", roughness: 0.5, metalness: 0 }];
    p.entities = ["ent_a", "ent_b"].map((id, order) => ({
      id,
      name: id,
      parent: null,
      output: out,
      order,
      states: {
        ks_ref: { f_target: id === "ent_a" ? undefined : "ent_a" },
        [BUILTIN.Mesh]: { shape: "box", material: "mat_a" },
      },
    }));
    const doc = new ProjectDoc();
    doc.load(p);
    return doc;
  }

  it("値を渡さなかったフィールドは初期値、undefined を渡したフィールドは undefined になる", () => {
    const doc = refProject();
    const out = doc.outputs()[0]?.id ?? "";
    const filled = doc.addEntity({ output: out, name: "c", states: { ks_ref: {} } });
    const cleared = doc.addEntity({
      output: out,
      name: "d",
      states: { ks_ref: { f_target: undefined } },
    });
    expect(doc.entity(filled)?.states.ks_ref?.f_target).toBe("ent_b");
    expect(doc.entity(cleared)?.states.ks_ref).toEqual({ f_target: undefined });
    expect("f_target" in (doc.entity(cleared)?.states.ks_ref ?? {})).toBe(true);
  });

  it("定義を変えても、undefined の値を初期値に戻さない", () => {
    const doc = refProject();
    const def = refDef("ent_b");
    doc.updateKokoState({ ...def, fields: def.fields.map((f) => ({ ...f, name: "aim" })) });
    const values = doc.entity("ent_a")?.states.ks_ref ?? {};
    expect("f_target" in values).toBe(true);
    expect(values.f_target).toBeUndefined();
    expect(doc.entity("ent_b")?.states.ks_ref?.f_target).toBe("ent_a");
  });

  it("マテリアルを消すと、指していたフィールドは undefined になる（キーは残る）", () => {
    const doc = refProject();
    doc.removeMaterial("mat_a");
    const mesh = doc.entity("ent_a")?.states[BUILTIN.Mesh] ?? {};
    expect("material" in mesh).toBe(true);
    expect(mesh.material).toBeUndefined();
    // 保存したファイルでも「なし」と分かる
    const files = toFiles(doc.snapshot());
    const out = doc.outputs()[0]?.id ?? "";
    const saved = JSON.parse(files[`outputs/${out}/entities/ent_a.json`] ?? "{}");
    expect(saved.states[BUILTIN.Mesh].material).toEqual({ $t: "undefined" });
  });
});

describe("stableStringify と広げた値", () => {
  it("同じ中身なら、作り方によらず同じ文字列になる", () => {
    const a = { at: new Date(5), m: new Map([["k", { b: 1, a: [undefined, 2n] }]]) };
    const b = { m: new Map([["k", { a: [undefined, 2n], b: 1 }]]), at: new Date(5) };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toContain('"$t":"bigint"');
  });

  it("値が undefined のプロパティは、ないのと同じに書く", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify({ a: 1 })).toBe('{"a":1}');
  });

  it('"$t" のキーを持つふつうのオブジェクトを、タグと取り違えない', () => {
    expect(stableStringify({ $t: "Date", v: "x" })).toBe(
      '{"$t":"object","v":{"$t":"Date","v":"x"}}',
    );
    expect(stableStringify(new Date(0))).toBe('{"$t":"Date","v":"1970-01-01T00:00:00.000Z"}');
  });
});
