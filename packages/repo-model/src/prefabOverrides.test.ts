import { FIELD_TYPE } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import { fromFiles, toFiles } from "./files";
import { expandPrefabs, PrefabExpansionCache, prefabInstanceAddress } from "./prefab";
import { emptyProject } from "./samples";
import type { ProjectSnapshot } from "./schema";

function fixture(): ProjectSnapshot {
  return {
    ...emptyProject("上書き"),
    kokostates: [
      {
        id: "state",
        name: "State",
        fields: [
          { id: "hp", name: "hp", type: FIELD_TYPE.number, default: 3 },
          { id: "to", name: "to", type: FIELD_TYPE.entity, default: undefined },
        ],
      },
    ],
    prefabs: [
      { id: "p", name: "P", root: "root", systems: [{ id: "base", enabled: true }], keep: [] },
    ],
    prefabEntities: [
      {
        id: "root",
        prefab: "p",
        parent: null,
        name: "Root",
        order: 0,
        states: { state: { hp: 1 } },
      },
      {
        id: "child",
        prefab: "p",
        parent: "root",
        name: "Child",
        order: 0,
        states: { state: { hp: 3, to: "root" } },
      },
      { id: "other", prefab: "p", parent: "root", name: "Other", order: 1, states: {} },
    ],
    entities: [
      {
        id: "i",
        output: "out_main",
        parent: null,
        name: "Instance",
        order: 0,
        states: {},
        instanceOf: { prefab: "p" },
      },
    ],
  };
}

describe("インスタンスの上書きを展開する", () => {
  it("値はフィールドごとに重なり、親・並び・名前・追加した KokoState と System も残る", () => {
    const snap = fixture();
    const instance = snap.entities[0];
    if (!instance) throw new Error("instance");
    instance.prefabOverrides = {
      "": { states: { state: { hp: 7 } } },
      child: {
        name: "Changed",
        parent: "i/other",
        order: 4,
        states: { state: { hp: 9 } },
        addedStates: { extra: { value: 1 } },
      },
    };
    instance.instanceSystems = [
      { id: "added", enabled: true },
      { id: "base", enabled: false },
    ];
    const result = expandPrefabs(snap);
    expect(result.entities.find((e) => e.id === "i")?.states.state?.hp).toBe(7);
    expect(result.entities.find((e) => e.id === "i/child")).toMatchObject({
      name: "Changed",
      parent: "i/other",
      order: 4,
      states: { state: { hp: 9, to: "i" }, extra: { value: 1 } },
    });
    expect(result.outputs[0]?.systems).toEqual([
      { id: "base", enabled: true },
      { id: "added", enabled: true },
    ]);
    expect(prefabInstanceAddress(snap, "i/child")?.path).toBe("child");
  });

  it("消えた親を何段もたどり、追加 Entity も同じ祖先に付く", () => {
    const snap = fixture();
    const prefab = snap.prefabs?.[0];
    const instance = snap.entities[0];
    if (!prefab || !instance) throw new Error("fixture");
    prefab.deletedParents = { gone: "gone2", gone2: "other" };
    instance.prefabOverrides = { child: { parent: "i/gone" } };
    snap.entities.push({
      id: "added",
      output: "out_main",
      name: "Added",
      parent: "i/gone",
      order: 0,
      states: {},
    });
    const entities = expandPrefabs(snap).entities;
    expect(entities.find((e) => e.id === "i/child")?.parent).toBe("i/other");
    expect(entities.find((e) => e.id === "added")?.parent).toBe("i/other");
  });

  it("入れ子の内側から外側へ重ね、参照・消えた親も付け替える", () => {
    const snap = fixture();
    snap.prefabs?.push({ id: "board", name: "Board", root: "boardRoot", systems: [], keep: [] });
    snap.prefabEntities?.push(
      { id: "boardRoot", prefab: "board", name: "Board", parent: null, order: 0, states: {} },
      {
        id: "nested",
        prefab: "board",
        name: "Nested",
        parent: "boardRoot",
        order: 0,
        states: {},
        instanceOf: { prefab: "p" },
        prefabOverrides: { child: { states: { state: { hp: 6, to: "boardRoot" } } } },
        instanceSystems: [{ id: "inner", enabled: true }],
      },
      {
        id: "decoration",
        prefab: "board",
        name: "Decoration",
        parent: "nested/gone",
        order: 1,
        states: {},
      },
    );
    const p = snap.prefabs?.[0];
    const instance = snap.entities[0];
    if (!p || !instance) throw new Error("fixture");
    p.deletedParents = { gone: "child" };
    instance.instanceOf = { prefab: "board" };
    instance.prefabOverrides = { "nested/child": { states: { state: { hp: 10 } } } };
    const result = expandPrefabs(snap);
    expect(result.entities.find((e) => e.id === "i/nested/child")?.states.state).toEqual({
      hp: 10,
      to: "i",
    });
    expect(result.entities.find((e) => e.id === "i/decoration")?.parent).toBe("i/nested/child");
    expect(result.outputs[0]?.systems.map((s) => s.id)).toEqual(["base", "inner"]);
  });

  it("不正な親の上書きが輪を作っても、展開した親子は輪にならない", () => {
    const snap = fixture();
    const instance = snap.entities[0];
    if (!instance) throw new Error("fixture");
    instance.prefabOverrides = { child: { parent: "i/other" }, other: { parent: "i/child" } };
    const entities = expandPrefabs(snap).entities;
    for (const entity of entities) {
      const seen = new Set([entity.id]);
      let parent = entity.parent;
      while (parent) {
        expect(seen.has(parent)).toBe(false);
        seen.add(parent);
        parent = entities.find((e) => e.id === parent)?.parent ?? null;
      }
    }
  });

  it("入れ子のインスタンスごと消えた親も、残っている祖先へたどる", () => {
    const snap = fixture();
    const p = snap.prefabs?.[0];
    if (!p) throw new Error("fixture");
    p.deletedParents = { nested: "other" };
    snap.entities.push({
      id: "added",
      output: "out_main",
      name: "Added",
      parent: "i/nested/child",
      order: 0,
      states: {},
    });
    expect(expandPrefabs(snap).entities.find((e) => e.id === "added")?.parent).toBe("i/other");
  });

  it("取っておいた結果も上書きの変更を拾う", () => {
    const snap = fixture();
    const instance = snap.entities[0];
    if (!instance) throw new Error("fixture");
    const cache = new PrefabExpansionCache();
    const first = expandPrefabs(snap, { cache });
    instance.prefabOverrides = { child: { states: { state: { hp: 12 } } } };
    const next = expandPrefabs(snap, { cache });
    expect(first.entities.find((e) => e.id === "i/child")?.states.state?.hp).toBe(3);
    expect(next.entities.find((e) => e.id === "i/child")?.states.state?.hp).toBe(12);
    expect(cache.builds).toBe(1);
    expect(cache.stamped).toBe(2);
  });

  it("上書きと追加値の特殊な値も Git のファイルで往復する", () => {
    const snap = fixture();
    const instance = snap.entities[0];
    if (!instance) throw new Error("fixture");
    instance.prefabOverrides = {
      child: {
        states: { state: { hp: NaN, to: undefined } },
        addedStates: { extra: { value: new Map([["a", 1]]) } },
      },
    };
    const loaded = fromFiles(toFiles(snap));
    expect(loaded.entities[0]?.prefabOverrides).toEqual(instance.prefabOverrides);
    expect(toFiles(loaded)).toEqual(toFiles(snap));
  });
});
