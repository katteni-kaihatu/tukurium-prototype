import { gunAndTargetSample, ProjectDoc } from "@tukurium/repo-model";
import { describe, expect, it } from "vitest";
import { describeDiff } from "./diffView";
import { planRevert } from "./revert";

function setup() {
  const head = gunAndTargetSample();
  // 親子を作っておく（支柱1 を 的1 の子に）
  const pole = head.entities.find((e) => e.id === "ent_pole1");
  if (pole) pole.parent = "ent_target1";
  const project = new ProjectDoc();
  project.load(structuredClone(head));
  const diff = () => describeDiff(head, project.snapshot());
  const run = (id: string, part?: string) => {
    const plan = planRevert(project, head, id, part);
    if (!plan) throw new Error(`戻せない: ${id} ${part ?? ""}`);
    plan();
  };
  return { head, project, diff, run };
}

describe("planRevert", () => {
  it("欄ひとつだけを戻す。ほかの変更は残す", () => {
    const { project, diff, run } = setup();
    project.setField("ent_gun", "ks_gun", "f_ammo", 3);
    project.setField("ent_gun", "ks_gun", "f_damage", 9);
    project.renameEntity("ent_gun", "鉄砲");
    run("entity:ent_gun", "field:ks_gun:f_ammo");
    expect(project.entity("ent_gun")?.states.ks_gun?.f_ammo).toBe(12);
    expect(project.entity("ent_gun")?.states.ks_gun?.f_damage).toBe(9);
    run("entity:ent_gun", "name");
    expect(project.entity("ent_gun")?.name).toBe("銃");
    run("entity:ent_gun", "state:ks_gun");
    expect(diff()).toEqual([]);
  });

  it("欄の状態維持の印も、保存したときに揃える", () => {
    const { project, diff, run } = setup();
    const output = project.output("out_range");
    if (!output) throw new Error("アウトプットがない");
    project.updateOutput({ ...output, keep: [] });
    run("entity:ent_gun", "field:ks_gun:f_ammo");
    expect(diff()).toEqual([]);
  });

  it("足した Entity は消し、消した Entity は子も一緒に戻す", () => {
    const { project, diff, run } = setup();
    const added = project.addEntity({ output: "out_range", name: "新しい箱" });
    run(`entity:${added}`);
    expect(project.entity(added)).toBeUndefined();
    project.removeEntity("ent_target1");
    expect(project.entity("ent_pole1")).toBeUndefined();
    run("entity:ent_target1");
    expect(project.entity("ent_pole1")?.parent).toBe("ent_target1");
    expect(diff()).toEqual([]);
  });

  it("アウトプット・KokoState・コード・マテリアルを戻す", () => {
    const { project, diff, run } = setup();
    const output = project.output("out_range");
    const koko = project.kokostate("ks_gun");
    const material = project.material("mat_wood");
    if (!output || !koko || !material) throw new Error("サンプルが違う");
    project.updateOutput({ ...output, name: "的当て", systems: [] });
    project.updateKokoState({ ...koko, fields: koko.fields.filter((f) => f.id !== "f_ammo") });
    project.code("sys_shoot")?.insert(0, "// メモ\n");
    project.updateMaterial({ ...material, color: "#000000" });
    run("output:out_range", "name");
    expect(project.output("out_range")?.systems).toEqual([]);
    run("output:out_range");
    run("koko:ks_gun", "field:f_ammo");
    expect(project.kokostate("ks_gun")?.fields.map((f) => f.id)).toEqual(
      koko.fields.map((f) => f.id),
    );
    // 欄を消したときに Entity の値も消えているので、Entity も戻す
    run("entity:ent_gun", "state:ks_gun");
    run("code:sys_shoot", "code");
    run("material:mat_wood", "color");
    expect(diff()).toEqual([]);
  });

  it("差し替えた素材のように、戻し方が決まらないものは null", () => {
    const { project, head } = setup();
    expect(planRevert(project, head, "other:folders")).toBeNull();
    expect(planRevert(project, head, "entity:ないもの", "name")).toBeNull();
  });
});
