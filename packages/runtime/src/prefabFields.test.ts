import type { FieldSchemas, ValueSchema } from "@tukurium/eks";
import { BUILTIN, gunAndTargetSample, type ProjectSnapshot } from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { Simulation } from "./simulation";

/**
 * プレハブ型・インスタンス型のフィールド（ADR 0082）：実行中に書く値を確かめる。
 * - プレハブ型：その配置から依存でたどれて、型に当てはまるプレハブだけ
 * - インスタンス型：実行中に作ったインスタンスで、作った元のプレハブが、型に当てはまるものだけ
 */
let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const undef: ValueSchema = { kind: "undefined" };
const opt = (ref: ValueSchema): ValueSchema => ({ kind: "union", options: [ref, undef] });

/**
 * 銃と的のサンプルに、Bullet・Bullet を中に持つ Gun2・どこからも指していない Other のプレハブと、
 * KokoState「Holder」（bullet：Bullet のプレハブ型、made：Bullet のインスタンス型）を持つ Entity を足す。
 * スクリプトは、プレハブを import しない。Bullet と Gun2 は、Holder のフィールドの値で指す。
 */
function project(body: string): { snap: ProjectSnapshot; schemas: FieldSchemas } {
  const snap = gunAndTargetSample();
  const prefab = (id: string, name: string) => ({
    id,
    name,
    root: `${id}_r`,
    systems: [],
    keep: [],
  });
  const root = (id: string) => ({
    id: `${id}_r`,
    name: id,
    prefab: id,
    parent: null,
    order: 0,
    states: { [BUILTIN.Transform]: transform },
  });
  snap.prefabs = [
    prefab("pf_bullet", "Bullet"),
    prefab("pf_gun2", "Gun2"),
    prefab("pf_other", "Other"),
  ];
  snap.prefabEntities = [
    root("pf_bullet"),
    root("pf_gun2"),
    root("pf_other"),
    {
      id: "inner",
      name: "中の弾",
      prefab: "pf_gun2",
      parent: "pf_gun2_r",
      order: 0,
      states: { [BUILTIN.Transform]: transform },
      instanceOf: { prefab: "pf_bullet" },
    },
  ];
  snap.kokostates.push({
    id: "ks_holder",
    name: "Holder",
    fields: [
      { id: "f_bullet", name: "bullet", type: "Bullet | undefined", default: undefined },
      { id: "f_gun", name: "gun", type: "Gun2 | undefined", default: undefined },
      { id: "f_made", name: "made", type: "InstanceOf<Bullet> | undefined", default: undefined },
    ],
    prefabImports: [
      { prefab: "pf_bullet", name: "Bullet" },
      { prefab: "pf_gun2", name: "Gun2" },
    ],
  });
  snap.entities.push({
    id: "ent_holder",
    name: "持つ物",
    parent: null,
    output: "out_range",
    order: 99,
    states: { ks_holder: { f_bullet: "pf_bullet", f_gun: "pf_gun2" } },
  });
  snap.systems.push({
    id: "sys_t",
    name: "T",
    code: [
      'import Holder from "/Holder.koko";',
      "let done = false;",
      "export default system({",
      "  query: { with: [Holder] },",
      `  onUpdate(e) {\nif (done) return;\ndone = true;\nconst h = e.get(Holder);\n${body}\n  },`,
      "});",
    ].join("\n"),
  });
  const out = snap.outputs.find((o) => o.id === "out_range");
  if (!out) throw new Error("out_range がありません");
  out.systems = [{ id: "sys_t", enabled: true }];
  const schemas: FieldSchemas = {
    ks_holder: {
      f_bullet: opt({ kind: "ref", target: "prefab", prefab: "pf_bullet" }),
      f_gun: opt({ kind: "ref", target: "prefab", prefab: "pf_gun2" }),
      f_made: opt({ kind: "ref", target: "entity", prefab: "pf_bullet" }),
    },
  };
  return { snap, schemas };
}

async function run(body: string) {
  const { snap, schemas } = project(body);
  const logs: string[] = [];
  sim = await Simulation.create(snap, "out_range", {
    realm: "repo1",
    schemas,
    onLog: (l) => {
      if (l.level === "log") logs.push(l.message);
    },
  });
  sim.step(1 / 60);
  expect(sim.systemStatus()[0]?.error ?? null).toBe(null);
  return { logs, holder: sim.world.get("ent_holder", "ks_holder") ?? {} };
}

describe("プレハブ型のフィールド", () => {
  it("フィールドの値で指したプレハブは、import していなくても、その値から作れる", async () => {
    const r = await run("log(String(Prefab.spawn(h.bullet)).slice(0, 3));");
    expect(r.logs).toEqual(["rt:"]);
  });

  it("依存でたどれるプレハブで、型に当てはまるものだけを書ける", async () => {
    // Gun2 はたどれるが、Bullet の型には当てはまらない。Other は、たどれない
    const r = await run(
      "h.bullet = h.gun; world.get(e.id, 'Holder'); const a = h.bullet; h.bullet = 'pf_other'; world.get(e.id, 'Holder'); log(a + ':' + h.bullet);",
    );
    expect(r.holder.f_bullet).toBe("pf_bullet");
  });

  it("「なし」は書ける", async () => {
    const r = await run("h.bullet = undefined;");
    expect(r.holder.f_bullet).toBeUndefined();
  });
});

describe("インスタンス型のフィールド", () => {
  it("Prefab.spawn で作ったインスタンスを入れられる", async () => {
    const r = await run("h.made = Prefab.spawn(h.bullet);");
    expect(String(r.holder.f_made)).toMatch(/^rt:\d+$/);
  });

  it("作ったインスタンスの中の、入れ子のプレハブのインスタンスも入れられる", async () => {
    const r = await run("const g = Prefab.spawn(h.gun); h.made = g + '/inner';");
    expect(String(r.holder.f_made)).toMatch(/^rt:\d+\/inner$/);
  });

  it("制作データに置いた Entity・world.spawn で作った Entity・別のプレハブのインスタンスは入れられない", async () => {
    expect((await run("h.made = e.id;")).holder.f_made).toBeUndefined();
    sim?.dispose();
    expect((await run("h.made = world.spawn({ name: 'x' });")).holder.f_made).toBeUndefined();
    sim?.dispose();
    expect((await run("h.made = Prefab.spawn(h.gun);")).holder.f_made).toBeUndefined();
  });
});
