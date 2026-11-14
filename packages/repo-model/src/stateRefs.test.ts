import {
  type FieldSchemas,
  mapRefs,
  type ValueSchema,
  validateValue,
  visitRefs,
} from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import { checkProjectReferences } from "./diagnostics/references";
import { parseFieldSchemas } from "./fieldTypes";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";
import type { ProjectSnapshot } from "./schema";
import { renameTypeName } from "./typeText";

const stateRef: ValueSchema = { kind: "kokoRef", koko: "ks_health" };
const hpRef: ValueSchema = { kind: "fieldRef", value: { kind: "number" } };
/** TypeScript で作ったスキーマの代わり（`KokoStateRef<Health> | undefined` と `FieldRef<number>`） */
const schemas: FieldSchemas = {
  ks_gauge: {
    f_owner: { kind: "union", options: [stateRef, { kind: "undefined" }] },
    f_hp: hpRef,
  },
};

function project(): ProjectSnapshot {
  const p = emptyProject("参照");
  const out = p.outputs[0]?.id ?? "out";
  p.kokostates = [
    {
      id: "ks_health",
      name: "Health",
      fields: [
        { id: "f_hp", name: "hp", type: "number", default: 3 },
        { id: "f_label", name: "label", type: "string", default: "" },
      ],
    },
    {
      id: "ks_gauge",
      name: "Gauge",
      fields: [
        {
          id: "f_owner",
          name: "owner",
          type: "KokoStateRef<Health> | undefined",
          default: undefined,
        },
        {
          id: "f_hp",
          name: "hpRef",
          type: "FieldRef<number>",
          default: { entity: "", koko: "", field: "" },
        },
      ],
    },
  ];
  p.entities = [
    {
      id: "ent_target",
      name: "的 3",
      parent: null,
      output: out,
      order: 0,
      states: { ks_health: { f_hp: 3, f_label: "" } },
    },
    {
      id: "ent_gauge",
      name: "ゲージ",
      parent: null,
      output: out,
      order: 1,
      states: {
        ks_gauge: {
          f_owner: { entity: "ent_target", koko: "ks_health" },
          f_hp: { entity: "ent_target", koko: "ks_health", field: "f_hp" },
        },
      },
    },
  ];
  return p;
}

const problems = (p: ProjectSnapshot) =>
  checkProjectReferences(p, schemas).map((d) => [d.code, d.subject.id, d.location]);
const gaugeValues = (p: ProjectSnapshot) =>
  p.entities.find((e) => e.id === "ent_gauge")?.states.ks_gauge ?? {};

describe("KokoState の参照とフィールドの参照（ADR 0065）", () => {
  it("値の形を確かめる。指せる KokoState が決まっていれば、その KokoState に限る", () => {
    expect(validateValue(stateRef, { entity: "e", koko: "ks_health" })).toBeNull();
    expect(validateValue(stateRef, { entity: "e", koko: "ks_other" })).toMatch(/指せる KokoState/);
    expect(validateValue({ kind: "kokoRef" }, { entity: "e", koko: "ks_other" })).toBeNull();
    expect(validateValue(stateRef, { entity: "e", koko: "ks_health", field: "f" })).toMatch(
      /KokoState の参照ではありません/,
    );
    expect(validateValue(hpRef, { entity: "e", koko: "k", field: "f" })).toBeNull();
    expect(validateValue(hpRef, { entity: "e", koko: "k" })).toMatch(/フィールドの参照/);
    expect(validateValue(hpRef, "e")).toMatch(/フィールドの参照/);
    expect(parseFieldSchemas(schemas)).toEqual(schemas);
  });

  it("指す Entity を、Entity の参照としてたどる・付け替える（KokoState の ID も付け替えられる）", () => {
    const value = { entity: "e1", koko: "ks_health", field: "f_hp" };
    const seen: string[] = [];
    visitRefs(hpRef, value, (target, id) => seen.push(`${target}:${id}`));
    expect(seen).toEqual(["entity:e1"]);
    expect(
      mapRefs(hpRef, value, (target, id) =>
        target === "entity" ? `p1/${id}` : target === "kokostate" ? `${id}_2` : undefined,
      ),
    ).toEqual({ entity: "p1/e1", koko: "ks_health_2", field: "f_hp" });
  });

  it("参照先がそろっていれば、問題は出ない", () => {
    expect(problems(project())).toEqual([]);
  });

  it("参照先の Entity・KokoState・フィールドが消えたら、値を残して問題にする", () => {
    const where = { kind: "property", path: ["ks_gauge", "f_owner"] };
    const hpWhere = { kind: "property", path: ["ks_gauge", "f_hp"] };

    // Entity が消えた
    const noEntity = project();
    noEntity.entities = noEntity.entities.filter((e) => e.id !== "ent_target");
    expect(problems(noEntity)).toEqual([
      ["missing-entity", "ent_gauge", where],
      ["missing-entity", "ent_gauge", hpWhere],
    ]);
    expect(gaugeValues(noEntity).f_owner).toEqual({ entity: "ent_target", koko: "ks_health" });

    // Entity から KokoState を外した
    const noState = project();
    const target = noState.entities.find((e) => e.id === "ent_target");
    if (target) target.states = {};
    expect(problems(noState)).toEqual([
      ["missing-state-ref", "ent_gauge", where],
      ["missing-state-ref", "ent_gauge", hpWhere],
    ]);

    // フィールドを消した
    const noField = project();
    const health = noField.kokostates[0];
    if (health) health.fields = health.fields.filter((f) => f.id !== "f_hp");
    expect(problems(noField)).toEqual([["missing-field-ref", "ent_gauge", hpWhere]]);
  });

  it("数のフィールドだけを指せる参照で、文字のフィールドを指していたら問題にする", () => {
    const p = project();
    const values = gaugeValues(p);
    values.f_hp = { entity: "ent_target", koko: "ks_health", field: "f_label" };
    const found = checkProjectReferences(p, schemas);
    expect(found.map((d) => d.code)).toEqual(["field-ref-type-mismatch"]);
    expect(found[0]?.message).toMatch(/Health\.label（string）を指せません/);
  });
});

describe("型の文の中の名前を書き換える", () => {
  it("型の名前だけを書き換える（文字・コメント・プロパティの名前はそのまま）", () => {
    const rename = (text: string) => renameTypeName(text, "Health", "Life");
    expect(rename("KokoStateRef<Health> | undefined")).toBe("KokoStateRef<Life> | undefined");
    expect(rename("Map<EntityRef, KokoStateRef<Health>[]>")).toBe(
      "Map<EntityRef, KokoStateRef<Life>[]>",
    );
    expect(
      rename('{ Health: number; kind: "Health" | "Health pack"; ref: KokoStateRef<Health> }'),
    ).toBe('{ Health: number; kind: "Health" | "Health pack"; ref: KokoStateRef<Life> }');
    expect(rename("{ Health?: Health } // Health のこと")).toBe(
      "{ Health?: Life } // Health のこと",
    );
    expect(rename("KokoStateRef<HealthBar> | ns.Health | MyHealth")).toBe(
      "KokoStateRef<HealthBar> | ns.Health | MyHealth",
    );
    expect(rename("T extends Health ? Health : never")).toBe("T extends Life ? Life : never");
    expect(rename("number")).toBe("number");
  });

  it("KokoState の名前を変えると、それを指す型の文も変わる。値はそのまま残る", () => {
    const doc = new ProjectDoc();
    doc.load(project());
    const health = doc.kokostate("ks_health");
    if (!health) throw new Error("ない");
    doc.updateKokoState({ ...health, name: "Life" });
    expect(doc.kokostate("ks_gauge")?.fields.map((f) => f.type)).toEqual([
      "KokoStateRef<Life> | undefined",
      "FieldRef<number>",
    ]);
    expect(gaugeValues(doc.snapshot())).toEqual(gaugeValues(project()));

    // 自分を指す型の文も変わり、その値も初期値に戻らない
    doc.updateKokoState({
      ...(doc.kokostate("ks_gauge") as NonNullable<ReturnType<typeof doc.kokostate>>),
      fields: [
        ...(doc.kokostate("ks_gauge")?.fields ?? []),
        { id: "f_next", name: "next", type: "KokoStateRef<Gauge> | undefined", default: undefined },
      ],
    });
    doc.setField("ent_gauge", "ks_gauge", "f_next", { entity: "ent_gauge", koko: "ks_gauge" });
    const gauge = doc.kokostate("ks_gauge");
    if (!gauge) throw new Error("ない");
    doc.updateKokoState({ ...gauge, name: "Meter" });
    expect(doc.kokostate("ks_gauge")?.fields.at(-1)?.type).toBe("KokoStateRef<Meter> | undefined");
    expect(gaugeValues(doc.snapshot()).f_next).toEqual({ entity: "ent_gauge", koko: "ks_gauge" });
  });
});
