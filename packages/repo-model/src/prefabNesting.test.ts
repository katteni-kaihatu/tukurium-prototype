import { FIELD_TYPE } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BUILTIN } from "./builtins";
import { checkProjectReferences } from "./diagnostics/references";
import { fromFiles, toFiles } from "./files";
import { expandPrefabForEdit, expandPrefabs, PrefabExpansionCache } from "./prefab";
import { prefabUsePath } from "./prefabNesting";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";

const OUT = "out_main";

function fixture() {
  const doc = new ProjectDoc();
  doc.load(emptyProject("入れ子"));
  const link = doc.addKokoState("Link");
  doc.updateKokoState({
    id: link,
    name: "Link",
    fields: [
      { id: "to", name: "to", type: FIELD_TYPE.entity, default: undefined },
      { id: "value", name: "value", type: FIELD_TYPE.number, default: 1 },
    ],
  });
  const board = doc.addPrefab("盤");
  const piece = doc.addPrefab("駒");
  const tip = doc.addPrefabEntity({ prefab: piece, name: "先", states: { [link]: {} } });
  return { doc, link, board, piece, tip };
}

describe("プレハブの中へインスタンスを置く", () => {
  it("持ち主の根か、選んだ Entity の下に置き、向きと大きさを写す", () => {
    const { doc, board, piece, tip } = fixture();
    const root = doc.prefab(piece)?.root ?? "";
    doc.setField(root, BUILTIN.Transform, "position", [7, 8, 9]);
    doc.setField(root, BUILTIN.Transform, "rotation", [0, 45, 0]);
    doc.setField(root, BUILTIN.Transform, "scale", [2, 2, 2]);
    const group = doc.addPrefabEntity({ prefab: board, name: "まとまり" });
    const first = doc.addInstance({ ownerPrefab: board, prefab: piece });
    const second = doc.addInstance({ ownerPrefab: board, prefab: piece, parent: group });
    expect(doc.prefabEntity(first)).toMatchObject({
      parent: doc.prefab(board)?.root,
      prefab: board,
      name: "駒",
      instanceOf: { prefab: piece },
      states: {
        [BUILTIN.Transform]: { position: [0, 0, 0], rotation: [0, 45, 0], scale: [2, 2, 2] },
      },
    });
    expect(doc.prefabEntity(second)?.parent).toBe(group);
    const positioned = doc.addInstance({ ownerPrefab: board, prefab: piece, position: [1, 2, 3] });
    expect(doc.prefabEntity(positioned)?.states[BUILTIN.Transform]?.position).toEqual([1, 2, 3]);
    expect(expandPrefabForEdit(doc.snapshot(), board)?.entities.map((e) => e.id)).toContain(
      `${first}/${tip}`,
    );
    expect(toFiles(fromFiles(toFiles(doc.snapshot())))).toEqual(toFiles(doc.snapshot()));
  });

  it("内側を直すと、編集中のプレハブと外側の全インスタンスに反映する", () => {
    const { doc, link, board, piece, tip } = fixture();
    const slot = doc.addInstance({ ownerPrefab: board, prefab: piece });
    const first = doc.addInstance({ output: OUT, prefab: board });
    const second = doc.addInstance({ output: OUT, prefab: board });
    const editCache = new PrefabExpansionCache();
    const outputCache = new PrefabExpansionCache();
    expandPrefabForEdit(doc.snapshot(), board, { cache: editCache });
    expandPrefabs(doc.snapshot(), { cache: outputCache });
    doc.setField(tip, link, "value", 7);
    expect(
      expandPrefabForEdit(doc.snapshot(), board, { cache: editCache })?.entities.find(
        (e) => e.id === `${slot}/${tip}`,
      )?.states[link]?.value,
    ).toBe(7);
    const expanded = expandPrefabs(doc.snapshot(), { cache: outputCache });
    for (const id of [first, second])
      expect(
        expanded.entities.find((e) => e.id === `${id}/${slot}/${tip}`)?.states[link]?.value,
      ).toBe(7);
  });

  it("自分自身と、何段かたどって自分を含む配置を、制作データを変えずに断る", () => {
    const { doc, board, piece } = fixture();
    const wrapper = doc.addPrefab("包み");
    doc.addInstance({ ownerPrefab: board, prefab: piece });
    doc.addInstance({ ownerPrefab: wrapper, prefab: board });
    const before = doc.snapshot();
    expect(prefabUsePath(before, wrapper, piece)).toEqual([wrapper, board, piece]);
    expect(() => doc.addInstance({ ownerPrefab: piece, prefab: piece })).toThrow(/自分自身/);
    expect(() => doc.addInstance({ ownerPrefab: piece, prefab: wrapper })).toThrow(/自分自身/);
    // 低い層の入口と複製も、同じ検査を通る。
    expect(() =>
      doc.addPrefabEntity({ prefab: piece, name: "包み", instanceOf: { prefab: wrapper } }),
    ).toThrow(/自分自身/);
    expect(doc.snapshot()).toEqual(before);
  });
});

describe("プレハブの中の Entity から、別のプレハブを作る", () => {
  it("移さない兄弟や親への参照は、外側のインスタンスごとに指す先を保つ", () => {
    const { doc, board, piece, tip, link } = fixture();
    const boardRoot = doc.prefab(board)?.root ?? "";
    const sibling = doc.addPrefabEntity({ prefab: board, name: "兄弟" });
    const siblingInstance = doc.addInstance({ ownerPrefab: board, prefab: piece });
    const group = doc.addPrefabEntity({
      prefab: board,
      name: "まとまり",
      states: { [link]: { to: sibling } },
    });
    const child = doc.addPrefabEntity({
      prefab: board,
      parent: group,
      name: "親を指す",
      states: { [link]: { to: boardRoot } },
    });
    const nestedRef = doc.addPrefabEntity({
      prefab: board,
      parent: group,
      name: "兄弟の中を指す",
      states: { [link]: { to: `${siblingInstance}/${tip}` } },
    });
    const outer = [
      doc.addInstance({ output: OUT, prefab: board }),
      doc.addInstance({ output: OUT, prefab: board }),
    ];
    const cache = new PrefabExpansionCache();
    const before = expandPrefabs(doc.snapshot(), { cache });
    const plan = doc.makePrefabFromEntity(group);
    const moved = new Map(plan.moved.map((m) => [m.from, m.to]));
    const after = expandPrefabs(doc.snapshot(), { cache });
    for (const instance of outer) {
      expect(after.entities.find((e) => e.id === `${instance}/${group}`)?.states[link]?.to).toBe(
        before.entities.find((e) => e.id === `${instance}/${group}`)?.states[link]?.to,
      );
      expect(
        after.entities.find((e) => e.id === `${instance}/${group}/${moved.get(child)}`)?.states[
          link
        ]?.to,
      ).toBe(instance);
      expect(
        after.entities.find((e) => e.id === `${instance}/${group}/${moved.get(nestedRef)}`)?.states[
          link
        ]?.to,
      ).toBe(`${instance}/${siblingInstance}/${tip}`);
    }
    const edit = expandPrefabForEdit(doc.snapshot(), board);
    expect(edit?.entities.find((e) => e.id === group)?.states[link]?.to).toBe(sibling);
    expect(
      edit?.entities.find((e) => e.id === `${group}/${moved.get(child)}`)?.states[link]?.to,
    ).toBe(boardRoot);
    expect(
      edit?.entities.find((e) => e.id === `${group}/${moved.get(nestedRef)}`)?.states[link]?.to,
    ).toBe(`${siblingInstance}/${tip}`);
    // 外側のプレハブに置いたときも、その持ち主の兄弟を指したままになる。
    const wrapper = doc.addPrefab("包み");
    const wrapped = doc.addInstance({ ownerPrefab: wrapper, prefab: board });
    const wrapperInstance = doc.addInstance({ output: OUT, prefab: wrapper });
    expect(
      expandPrefabs(doc.snapshot()).entities.find(
        (e) => e.id === `${wrapperInstance}/${wrapped}/${group}`,
      )?.states[link]?.to,
    ).toBe(`${wrapperInstance}/${wrapped}/${sibling}`);
  });

  it("参照・維持の印・内側のインスタンスを保ち、外からの参照も書き換える", () => {
    const { doc, board, piece, tip, link } = fixture();
    const group = doc.addPrefabEntity({
      prefab: board,
      name: "駒のまとまり",
      states: { [BUILTIN.Transform]: { position: [3, 2, 1] }, [link]: {} },
    });
    const child = doc.addPrefabEntity({
      prefab: board,
      name: "中",
      parent: group,
      states: { [link]: { to: group } },
    });
    const slot = doc.addInstance({ ownerPrefab: board, prefab: piece, parent: group });
    doc.setField(group, link, "to", `${slot}/${tip}`);
    const observer = doc.addPrefabEntity({
      prefab: board,
      name: "参照",
      states: { [link]: { to: child } },
    });
    const outer = doc.addInstance({ output: OUT, prefab: board });
    const outside = doc.addEntity({
      output: OUT,
      name: "外",
      states: { [link]: { to: `${outer}/${child}` } },
    });
    const wrapper = doc.addPrefab("包み");
    const wrapped = doc.addInstance({ ownerPrefab: wrapper, prefab: board });
    const wrappedObserver = doc.addPrefabEntity({
      prefab: wrapper,
      name: "参照",
      states: { [link]: { to: `${wrapped}/${slot}/${tip}` } },
    });
    const boardDef = doc.prefab(board);
    const wrapperDef = doc.prefab(wrapper);
    const output = doc.output(OUT);
    if (!boardDef || !wrapperDef || !output) throw new Error("fixture");
    doc.updatePrefab({
      ...boardDef,
      keep: [
        { entity: group, koko: BUILTIN.Transform, field: "position" },
        { entity: child, koko: link, field: "value" },
      ],
    });
    doc.updatePrefab({
      ...wrapperDef,
      keep: [{ entity: `${wrapped}/${child}`, koko: link, field: "value" }],
    });
    doc.updateOutput({
      ...output,
      keep: [{ entity: `${outer}/${child}`, koko: link, field: "value" }],
    });
    const updates: Uint8Array[] = [];
    doc.doc.on("update", (u: Uint8Array) => updates.push(u));
    const plan = doc.makePrefabFromEntity(group);
    expect(updates).toHaveLength(1);
    const ids = new Map(plan.moved.map((m) => [m.from, m.to]));
    const movedChild = ids.get(child) ?? "";
    const movedSlot = ids.get(slot) ?? "";
    expect(plan.owner).toEqual({ kind: "prefab", id: board });
    expect(doc.prefabEntity(group)).toMatchObject({
      prefab: board,
      instanceOf: { prefab: plan.prefab.id },
    });
    expect(doc.prefabEntities(board).some((e) => e.id === child || e.id === slot)).toBe(false);
    expect(doc.prefabEntity(movedSlot)?.instanceOf).toEqual({ prefab: piece });
    expect(doc.prefabEntity(movedChild)?.states[link]?.to).toBe(plan.prefab.root);
    expect(doc.prefabEntity(plan.prefab.root)?.states[link]?.to).toBe(`${movedSlot}/${tip}`);
    expect(doc.prefabEntity(observer)?.states[link]?.to).toBe(`${group}/${movedChild}`);
    expect(doc.entity(outside)?.states[link]?.to).toBe(`${outer}/${group}/${movedChild}`);
    expect(doc.prefabEntity(wrappedObserver)?.states[link]?.to).toBe(
      `${wrapped}/${group}/${movedSlot}/${tip}`,
    );
    expect(doc.prefab(board)?.keep).toEqual([
      { entity: group, koko: BUILTIN.Transform, field: "position" },
    ]);
    expect(doc.prefab(plan.prefab.id)?.keep).toEqual([
      { entity: movedChild, koko: link, field: "value" },
    ]);
    expect(doc.output(OUT)?.keep[0]?.entity).toBe(`${outer}/${group}/${movedChild}`);
    expect(doc.prefab(wrapper)?.keep[0]?.entity).toBe(`${wrapped}/${group}/${movedChild}`);
    expect(checkProjectReferences(doc.snapshot())).toEqual([]);
    const peer = new ProjectDoc();
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(doc.doc));
    expect(peer.snapshot()).toEqual(doc.snapshot());
    expect(toFiles(fromFiles(toFiles(doc.snapshot())))).toEqual(toFiles(doc.snapshot()));
  });

  it("根の変換と、自分を含むプレハブを作る変換を断る", () => {
    const { doc, board } = fixture();
    const root = doc.prefab(board)?.root ?? "";
    const group = doc.addPrefabEntity({ prefab: board, name: "まとまり" });
    const broken = doc.addPrefabEntity({ prefab: board, name: "輪", parent: group });
    const snap = doc.snapshot();
    const node = snap.prefabEntities?.find((e) => e.id === broken);
    if (node) node.instanceOf = { prefab: board };
    doc.load(snap);
    expect(() => doc.makePrefabFromEntity(root)).toThrow(/いちばん上/);
    expect(() => doc.makePrefabFromEntity(group)).toThrow(/自分自身/);
    expect(doc.snapshot()).toEqual(snap);
  });
});
