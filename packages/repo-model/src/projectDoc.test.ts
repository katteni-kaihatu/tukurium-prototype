import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BUILTIN } from "./builtins";
import { ProjectDoc } from "./projectDoc";
import { emptyProject, gunAndTargetSample } from "./samples";

describe("ProjectDoc", () => {
  it("同時編集で親子が輪になっても、削除が終わり子孫と維持マークを片付ける (#65)", () => {
    const a = new ProjectDoc();
    a.load(emptyProject("輪"));
    const x = a.addEntity({ name: "a", output: "out_main" });
    const y = a.addEntity({ name: "b", output: "out_main" });
    const child = a.addEntity({ name: "child", output: "out_main", parent: x });
    const other = a.addEntity({ name: "outside", output: "out_main" });
    const output = a.output("out_main");
    if (!output) throw new Error("出力がありません");
    a.updateOutput({
      ...output,
      keep: [x, y, child, other].map((entity) => ({
        entity,
        koko: BUILTIN.Transform,
        field: "position",
      })),
    });
    const b = new ProjectDoc();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const va = Y.encodeStateVector(a.doc),
      vb = Y.encodeStateVector(b.doc);
    a.setParent(x, y);
    b.setParent(y, x);
    const ua = Y.encodeStateAsUpdate(a.doc, va),
      ub = Y.encodeStateAsUpdate(b.doc, vb);
    Y.applyUpdate(a.doc, ub);
    Y.applyUpdate(b.doc, ua);
    expect(a.entity(x)?.parent).toBe(y);
    expect(a.entity(y)?.parent).toBe(x);
    // 再発してもテスト自体を無限ループさせず、Entity数を超える再走査で失敗させる。
    let scans = 0;
    const guarded = new Proxy(a.entities(), {
      get(target, key, receiver) {
        if (key === Symbol.iterator)
          return function* () {
            if (++scans > target.length) throw new Error("子孫の走査が循環しました");
            yield* target;
          };
        return Reflect.get(target, key, receiver);
      },
    });
    const listing = vi.spyOn(a, "entities").mockReturnValue(guarded);
    try {
      a.removeEntity(x);
    } finally {
      listing.mockRestore();
    }
    expect(a.entities().map((e) => e.id)).toEqual([other]);
    expect(a.output("out_main")?.keep.map((k) => k.entity)).toEqual([other]);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    expect(b.snapshot()).toEqual(a.snapshot());
    const root = a.addEntity({ name: "root", output: "out_main" });
    a.addEntity({ name: "normal child", output: "out_main", parent: root });
    a.removeEntity(root);
    expect(a.entities().map((e) => e.id)).toEqual([other]);
  });
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

  it("Built-in と同じ名前・不正な名前・Built-in の変更を拒む（同じ名前は別の場所なら使える。ADR 0010）", () => {
    const p = new ProjectDoc();
    p.load(emptyProject("test"));
    p.addKokoState("Gun");
    expect(() => p.addKokoState("Gun")).not.toThrow();
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

  it("並べ替えと、指定した位置への親子付けができる", () => {
    const p = new ProjectDoc();
    p.load(emptyProject("test"));
    const a = p.addEntity({ output: "out_main", name: "a" });
    const b = p.addEntity({ output: "out_main", name: "b" });
    const c = p.addEntity({ output: "out_main", name: "c" });
    const names = () =>
      p
        .entities("out_main")
        .filter((e) => e.parent === null)
        .map((e) => e.name);
    p.placeEntity(c, null, 0);
    expect(names()).toEqual(["c", "a", "b"]);
    p.placeEntity(b, a, 0);
    expect(p.entity(b)?.parent).toBe(a);
    expect(names()).toEqual(["c", "a"]);
    p.placeEntity(c, a, 1);
    expect(
      p
        .entities("out_main")
        .filter((e) => e.parent === a)
        .map((e) => e.name),
    ).toEqual(["b", "c"]);
    expect(() => p.placeEntity(a, b, 0)).toThrow();
    // 同じ場所への移動は、並びを動かさない
    const before = p.snapshot();
    p.placeEntity(b, a, 0);
    expect(p.snapshot()).toEqual(before);
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

  it("同じKokoStateの別フィールドを同時に編集しても両方を残す (#61)", () => {
    const a = new ProjectDoc();
    a.load(emptyProject("共同編集"));
    const ks = a.addKokoState("Stats");
    a.updateKokoState({
      id: ks,
      name: "Stats",
      fields: [
        { id: "hp", name: "hp", type: "number", default: 10 },
        { id: "score", name: "score", type: "number", default: 0 },
      ],
    });
    const entity = a.addEntity({ output: "out_main", name: "player", states: { [ks]: {} } });
    const b = new ProjectDoc();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const beforeA = Y.encodeStateVector(a.doc);
    const beforeB = Y.encodeStateVector(b.doc);
    a.setField(entity, ks, "hp", 8);
    b.setField(entity, ks, "score", 3);
    const fromA = Y.encodeStateAsUpdate(a.doc, beforeA);
    const fromB = Y.encodeStateAsUpdate(b.doc, beforeB);
    Y.applyUpdate(a.doc, fromB);
    Y.applyUpdate(b.doc, fromA);
    expect(a.entity(entity)?.states[ks]).toEqual({ hp: 8, score: 3 });
    expect(b.snapshot()).toEqual(a.snapshot());
    const restored = new ProjectDoc();
    Y.applyUpdate(restored.doc, Y.encodeStateAsUpdate(a.doc));
    expect(restored.snapshot()).toEqual(a.snapshot());
    const loaded = new ProjectDoc();
    loaded.load(a.snapshot());
    expect(loaded.snapshot()).toEqual(a.snapshot());

    const vectorA = Y.encodeStateVector(a.doc),
      vectorB = Y.encodeStateVector(b.doc);
    a.setField(entity, ks, "hp", 5);
    b.setField(entity, ks, "hp", 6);
    const changeA = Y.encodeStateAsUpdate(a.doc, vectorA);
    const changeB = Y.encodeStateAsUpdate(b.doc, vectorB);
    Y.applyUpdate(a.doc, changeB);
    Y.applyUpdate(b.doc, changeA);
    expect([5, 6]).toContain(a.entity(entity)?.states[ks]?.hp);
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it.each([
    {
      winner: "フィールド追加側",
      typeChangeClient: 1,
      additionClient: 2,
      type: "number",
      value: 7,
    },
    { winner: "型変更側", typeChangeClient: 2, additionClient: 1, type: "boolean", value: false },
  ])("定義の同時編集で $winner が勝つと、値の型も定義に合わせる (#61)", (testCase) => {
    const a = new ProjectDoc();
    a.load(emptyProject("共同編集"));
    const ks = a.addKokoState("Stats");
    a.updateKokoState({
      id: ks,
      name: "Stats",
      fields: [{ id: "hp", name: "hp", type: "number", default: 10 }],
    });
    const entity = a.addEntity({ output: "out_main", name: "player", states: { [ks]: { hp: 7 } } });
    const initial = Y.encodeStateAsUpdate(a.doc);
    const b = new ProjectDoc();
    Y.applyUpdate(b.doc, initial);
    a.doc.clientID = testCase.typeChangeClient;
    b.doc.clientID = testCase.additionClient;
    const beforeA = Y.encodeStateVector(a.doc);
    const beforeB = Y.encodeStateVector(b.doc);
    a.updateKokoState({
      id: ks,
      name: "Stats",
      fields: [{ id: "hp", name: "hp", type: "boolean", default: false }],
    });
    b.updateKokoState({
      id: ks,
      name: "Stats",
      fields: [
        { id: "hp", name: "hp", type: "number", default: 10 },
        { id: "score", name: "score", type: "number", default: 0 },
      ],
    });
    const fromA = Y.encodeStateAsUpdate(a.doc, beforeA);
    const fromB = Y.encodeStateAsUpdate(b.doc, beforeB);
    const first = new ProjectDoc();
    const second = new ProjectDoc();
    for (const [merged, updates] of [
      [first, [fromA, fromB]],
      [second, [fromB, fromA]],
    ] as const) {
      Y.applyUpdate(merged.doc, initial);
      for (const update of updates) Y.applyUpdate(merged.doc, update);
      expect(merged.kokostate(ks)?.fields.find((f) => f.id === "hp")?.type).toBe(testCase.type);
      expect(merged.entity(entity)?.states[ks]?.hp).toBe(testCase.value);
    }
    expect(second.snapshot()).toEqual(first.snapshot());
  });

  it("フィールド単位の編集を、定義変更と状態・Entityの削除時に片付ける (#61)", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    p.setField("ent_gun", "ks_gun", "f_ammo", 3);
    const gun = p.kokostate("ks_gun");
    if (!gun) throw new Error("Gunがありません");
    p.updateKokoState({
      ...gun,
      fields: gun.fields.map((f) =>
        f.id === "f_ammo" ? { ...f, type: "boolean", default: false } : f,
      ),
    });
    expect(p.entity("ent_gun")?.states.ks_gun?.f_ammo).toBe(false);
    p.setField("ent_gun", "ks_gun", "f_ammo", true);
    p.removeState("ent_gun", "ks_gun");
    p.addState("ent_gun", "ks_gun");
    expect(p.entity("ent_gun")?.states.ks_gun?.f_ammo).toBe(false);
    p.setField("ent_gun", "ks_gun", "f_ammo", true);
    p.removeEntity("ent_gun");
    expect(p.entity("ent_gun")).toBeUndefined();
    p.load(gunAndTargetSample());
    p.setField("ent_gun", "ks_gun", "f_ammo", 1);
    p.load(gunAndTargetSample());
    expect(p.entity("ent_gun")?.states.ks_gun?.f_ammo).toBe(12);
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
  it("名前の変更・移動に合わせて import のパスを書き直す（一つの transaction で）", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    const gun = p.kokostates().find((k) => k.name === "Gun");
    if (!gun) throw new Error("Gun がありません");
    const states = p.addFolder("States", null);
    const systems = p.addFolder("Systems", null);
    p.moveResource(gun.id, states);
    p.moveResource("sys_shoot", systems);
    const text = p.code("sys_shoot");
    if (!text) throw new Error("コードがありません");
    text.delete(0, text.length);
    text.insert(0, 'import Gun from "../States/Gun.koko";\nexport default system({});');
    const line = () => p.code("sys_shoot")?.toString().split("\n")[0];

    let updates = 0;
    p.doc.on("update", () => updates++);
    p.renameFolder(states, "Parts");
    expect(line()).toBe('import Gun from "../Parts/Gun.koko";');
    expect(updates).toBe(1);

    p.updateKokoState({ ...gun, name: "Rifle" });
    expect(line()).toBe('import Gun from "../Parts/Rifle.koko";');
    p.moveResource(gun.id, systems);
    expect(line()).toBe('import Gun from "./Rifle.koko";');
    p.moveResource("sys_shoot", null);
    expect(line()).toBe('import Gun from "./Systems/Rifle.koko";');
    p.moveFolder(systems, states);
    expect(line()).toBe('import Gun from "./Parts/Systems/Rifle.koko";');
    p.removeFolder(systems);
    expect(line()).toBe('import Gun from "./Parts/Rifle.koko";');
  });
  it("別のフォルダなら、同じ名前の KokoState を作れる（同じ場所では名前を変えるときに拒む）", () => {
    const p = new ProjectDoc();
    p.load(gunAndTargetSample());
    const gun = p.kokostates().find((k) => k.name === "Gun");
    if (!gun) throw new Error("Gun がありません");
    const enemy = p.addFolder("Enemy", null);
    const other = p.addKokoState("Gun");
    p.moveResource(other, enemy);
    expect(p.kokostates().filter((k) => k.name === "Gun")).toHaveLength(2);
    const target = p.kokostates().find((k) => k.name === "Target");
    if (!target) throw new Error("Target がありません");
    // いちばん上で Gun と同じ場所にある Target を Gun にはできない
    expect(() => p.updateKokoState({ ...target, name: "Gun" })).toThrow("同じ場所");
  });
});
