import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BUILTIN } from "./builtins";
import { ProjectDoc } from "./projectDoc";
import { emptyProject, gunAndTargetSample } from "./samples";

describe("ProjectDoc", () => {
  it("スナップショットを読み込んで、同じ内容を取り出せる", () => {
    const p = new ProjectDoc();
    const sample = gunAndTargetSample();
    p.load(sample);
    const snap = p.snapshot();
    expect(snap.name).toBe("銃と的");
    expect(snap.kokostates).toEqual(sample.kokostates);
    expect(snap.systems.map((s) => s.code)).toEqual(sample.systems.map((s) => s.code));
    expect(snap.entities.map((e) => e.id).sort()).toEqual(sample.entities.map((e) => e.id).sort());
    expect(p.entity("ent_gun")?.states.ks_gun?.f_ammo).toBe(12);
  });

  it("KokoState を作り、Entity に付けて値を変えられる", () => {
    const p = new ProjectDoc();
    p.load(emptyProject("test"));
    const ks = p.addKokoState("Health");
    p.updateKokoState({
      id: ks,
      name: "Health",
      fields: [{ id: "f_hp", name: "hp", type: "number", default: 10 }],
    });
    const e = p.addEntity({ output: "out_main", name: "箱", states: { [BUILTIN.Transform]: {} } });
    p.addState(e, ks);
    expect(p.entity(e)?.states[ks]).toEqual({ f_hp: 10 });
    expect(p.entity(e)?.states[BUILTIN.Transform]).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    p.setField(e, ks, "f_hp", 3);
    expect(p.entity(e)?.states[ks]?.f_hp).toBe(3);
  });

  it("フィールドを消す・型を変えると、Entity の値も合わせる（名前の変更では値を保つ）", () => {
    const p = new ProjectDoc();
    p.load(emptyProject("test"));
    const ks = p.addKokoState("Gun");
    p.updateKokoState({
      id: ks,
      name: "Gun",
      fields: [
        { id: "a", name: "ammo", type: "number", default: 12 },
        { id: "b", name: "label", type: "string", default: "x" },
        { id: "c", name: "auto", type: "boolean", default: false },
      ],
    });
    const e = p.addEntity({
      output: "out_main",
      name: "銃",
      states: { [ks]: { a: 5, b: "y", c: true } },
    });
    p.updateKokoState({
      id: ks,
      name: "Gun",
      fields: [
        { id: "a", name: "bullets", type: "number", default: 12 }, // 名前だけ変更
        { id: "c", name: "auto", type: "number", default: 0 }, // 型を変更
      ],
    });
    expect(p.entity(e)?.states[ks]).toEqual({ a: 5, c: 0 });
  });

  it("名前の重複・不正な名前・Built-in の変更を拒む", () => {
    const p = new ProjectDoc();
    p.load(emptyProject("test"));
    p.addKokoState("Gun");
    expect(() => p.addKokoState("Gun")).toThrow();
    expect(() => p.addKokoState("Transform")).toThrow();
    expect(() => p.addKokoState("1abc")).toThrow();
    expect(() =>
      p.updateKokoState({ id: BUILTIN.Transform, name: "Transform", fields: [] }),
    ).toThrow();
  });

  it("Entity を消すと子と状態維持のマークも消える", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    const child = p.addEntity({ output: "out_range", name: "スコープ", parent: "ent_gun" });
    p.removeEntity("ent_gun");
    expect(p.entity(child)).toBeUndefined();
    expect(p.output("out_range")?.keep).toEqual([]);
  });

  it("自分の子孫を親にはできない", () => {
    const p = new ProjectDoc();
    p.load(emptyProject("test"));
    const a = p.addEntity({ output: "out_main", name: "a" });
    const b = p.addEntity({ output: "out_main", name: "b", parent: a });
    expect(() => p.setParent(a, b)).toThrow();
  });

  it("System を消すとアウトプットの一覧からも外れる", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    p.removeSystem("sys_shoot");
    expect(p.output("out_range")?.systems.map((s) => s.id)).toEqual(["sys_target"]);
  });

  it("2 つの Y.Doc の間で更新を交換すると、同じ内容になる（共同編集の前提）", () => {
    const a = new ProjectDoc();
    const b = new ProjectDoc(new Y.Doc());
    a.doc.on("update", (u: Uint8Array) => Y.applyUpdate(b.doc, u));
    a.load(gunAndTargetSample());
    a.setField("ent_gun", "ks_gun", "f_ammo", 3);
    a.code("sys_shoot")?.insert(0, "// edited\n");
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it("フォルダを作り、リソースを入れ・移し、フォルダを消すと中身はひとつ上へ移る", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    const gun = p.kokostates().find((k) => k.name === "Gun");
    if (!gun) throw new Error("Gun がありません");
    const a = p.addFolder("銃", null);
    const b = p.addFolder("部品", a);
    p.moveResource(gun.id, b);
    expect(p.folderOf(gun.id)).toBe(b);
    // 自分の中へは移せない
    p.moveFolder(a, b);
    expect(p.folders().find((f) => f.id === a)?.parent).toBeNull();
    p.removeFolder(b);
    expect(p.folderOf(gun.id)).toBe(a);
    expect(p.snapshot().placement).toEqual({ [gun.id]: a });
    // リソースを消すと、割り当ても残らない
    p.removeKokoState(gun.id);
    expect(p.snapshot().placement).toEqual({});
  });
  it("同じ親の直下の名前は種類をまたいで一つ：名前を変えるときに拒み、空いている名前を出せる", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    const gun = p.kokostates().find((k) => k.name === "Gun");
    if (!gun) throw new Error("Gun がありません");
    const f = p.addFolder("Weapons", null);
    p.moveResource(gun.id, f);
    const sys = p.addSystem("Shoot2", "");
    p.moveResource(sys, f);
    expect(p.siblingNameTaken("gun", f)).toBe(true);
    expect(p.siblingNameTaken("Gun", f, gun.id)).toBe(false);
    expect(p.siblingNameTaken("Gun", null)).toBe(false);
    expect(() => p.renameSystem(sys, "GUN")).toThrow("同じ場所");
    expect(p.system(sys)?.name).toBe("Shoot2");
    // 別のフォルダなら同じ名前でよい
    const mat = p.addMaterial("Gun");
    expect(p.material(mat)?.name).toBe("Gun");
    expect(() => p.renameFolder(f, "Arms")).not.toThrow();
    const g = p.addFolder("Other", null);
    expect(() => p.renameFolder(g, "ARMS ")).toThrow("同じ場所");
    expect(() => p.renameFolder(g, "a/b")).toThrow("使えません");
    const m = p.material(mat);
    if (!m) throw new Error("Material がありません");
    p.moveResource(mat, f);
    expect(() => p.updateMaterial({ ...m, name: "Shoot2" })).toThrow("同じ場所");
    p.updateMaterial({ ...m, color: "#000000" }); // 名前を変えなければ検査しない
    expect(p.freeName("Gun", f)).toBe("Gun 2");
    expect(p.freeName("New", f)).toBe("New");
    expect(p.freeName("NewKokoState", null, (b, n) => `${b}${n}`)).toBe("NewKokoState1");
  });
});
