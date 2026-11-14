import { FIELD_TYPE } from "@tukurium/eks";
import { describe, expect, it } from "vitest";
import { BUILTIN } from "./builtins";
import { expandPrefabForEdit, expandPrefabs, PrefabExpansionCache } from "./prefab";
import { ProjectDoc } from "./projectDoc";
import { emptyProject } from "./samples";
import type {
  EntityDef,
  OutputSystem,
  PrefabDef,
  PrefabEntityDef,
  PrefabEntityOverride,
  ProjectSnapshot,
} from "./schema";

/**
 * 展開の近道（ADR 0076 の 5）を確かめる。展開した Entity をすべてたどる展開（`thorough`）と、
 * 近道をする展開・取っておいた結果を使う展開が、同じ結果になること。
 * 形は、決まった種から乱数で作る（上書き・足した Entity・親の付け替え・消えた親・入れ子・
 * ライブラリのプレハブ・System・壊れたデータを含む）。落ちたときは、種の番号で同じ形を作り直せる。
 */

/** 種から決まる乱数（mulberry32） */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const chance = (p: number) => next() < p;
  const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
  return { int, chance, pick };
}
type Random = ReturnType<typeof random>;

const OUTPUTS = ["out_main", "out_b"];
const SYSTEMS = ["sys_a", "sys_b", "sys_c", "sys_d", "sys_e"];
// ライブラリから読み込んだプレハブは、ID の形が違う（pkg:…・pkgent:…）
const PREFABS = ["pf_piece", "pf_row", "pkg:lib@1.0.0/pf_board", "pf_box"];
/** そのプレハブの中の Entity の ID の頭 */
const tagOf = (at: number) =>
  PREFABS[at]?.startsWith("pkg:") ? `pkgent:lib@1.0.0:b${at}` : `e${at}`;

function systems(r: Random, max = 2): OutputSystem[] {
  const out: OutputSystem[] = [];
  for (let i = r.int(max + 1); i > 0; i--) {
    const id = r.pick(SYSTEMS);
    if (!out.some((s) => s.id === id)) out.push({ id, enabled: r.chance(0.7) });
  }
  return out;
}

function states(r: Random, target?: string) {
  return {
    ...(r.chance(0.8) ? { [BUILTIN.Transform]: { position: [r.int(5), r.int(5), 0] } } : {}),
    ...(r.chance(0.6)
      ? { st: { hp: r.int(9), ...(target && r.chance(0.6) ? { to: target } : {}) } }
      : {}),
    ...(r.chance(0.2) ? { tag: {} } : {}),
  };
}

/** プレハブと、その中の Entity。broken なら、壊れた形（自分を含む・親子の輪・ない親）も混ぜる */
function prefabs(r: Random, broken: boolean) {
  const defs: PrefabDef[] = [];
  const inside: PrefabEntityDef[] = [];
  PREFABS.forEach((id, at) => {
    const tag = tagOf(at);
    const root = `${tag}_root`;
    const ids = [root];
    inside.push({
      id: root,
      prefab: id,
      parent: null,
      name: `root${at}`,
      order: 0,
      states: states(r),
      ...(r.chance(0.15) ? { unpackedSystems: systems(r, 1) } : {}),
    });
    for (let i = 0; i < 1 + r.int(4); i++) {
      const eid = `${tag}_${i}`;
      // 先に作ったプレハブを、入れ子に置く（壊れた形では、あとのプレハブや自分も置く）
      const nest =
        at > 0 && r.chance(0.45)
          ? r.pick(broken && r.chance(0.2) ? PREFABS : PREFABS.slice(0, at))
          : undefined;
      inside.push({
        id: eid,
        prefab: id,
        parent: broken && r.chance(0.08) ? r.pick(["nowhere", eid, `${tag}_9`]) : r.pick(ids),
        name: `${tag}の${i}`,
        order: r.int(4),
        states: states(r, r.pick(ids)),
        ...(nest ? { instanceOf: { prefab: nest } } : {}),
        ...(r.chance(0.15) ? { instanceSystems: systems(r, 1) } : {}),
      });
      ids.push(eid);
    }
    defs.push({
      id,
      name: id,
      root,
      systems: systems(r),
      keep: r.chance(0.4) ? [{ entity: r.pick(ids), koko: "st", field: "hp" }] : [],
      // 消した Entity の元の親（消えた親を指す Entity を、残っている祖先へ付けるため）
      ...(r.chance(0.5)
        ? {
            deletedParents: {
              [`${tag}_gone`]: r.pick([null, ...ids]),
              ...(r.chance(0.3) ? { [`${tag}_gone2`]: `${tag}_gone` } : {}),
              ...(broken && r.chance(0.3) ? { [`${tag}_loop`]: `${tag}_loop` } : {}),
            },
          }
        : {}),
    });
  });
  return { defs, inside };
}

function override(r: Random, parents: readonly (string | null)[]): PrefabEntityOverride {
  return {
    ...(r.chance(0.3) ? { name: `変えた${r.int(9)}` } : {}),
    ...(r.chance(0.3) ? { order: r.int(5) } : {}),
    ...(r.chance(0.35) ? { parent: r.pick(parents) } : {}),
    ...(r.chance(0.5) ? { states: { st: { hp: 100 + r.int(9) } } } : {}),
    ...(r.chance(0.2) ? { addedStates: { extra: { n: r.int(9) } } } : {}),
  };
}

/** 一つの形を作る。あとから `change()` で少しずつ変える */
function build(seed: number, broken: boolean): { snap: ProjectSnapshot; r: Random } {
  const r = random(seed);
  const { defs, inside } = prefabs(r, broken);
  const entities: EntityDef[] = [];
  for (let i = 0; i < 3 + r.int(5); i++)
    entities.push({
      id: `inst${i}`,
      output: r.chance(0.8) ? "out_main" : "out_b",
      parent: null,
      name: `インスタンス${i}`,
      order: r.int(6),
      states: states(r),
      instanceOf: { prefab: broken && r.chance(0.1) ? "pf_missing" : r.pick(PREFABS) },
      ...(r.chance(0.25) ? { instanceSystems: systems(r) } : {}),
    });
  const snap: ProjectSnapshot = {
    ...emptyProject("近道"),
    kokostates: [
      {
        id: "st",
        name: "St",
        fields: [
          { id: "hp", name: "hp", type: FIELD_TYPE.number, default: 3 },
          { id: "to", name: "to", type: FIELD_TYPE.entity, default: undefined },
        ],
      },
      { id: "tag", name: "Tag", fields: [] },
      {
        id: "extra",
        name: "Extra",
        fields: [{ id: "n", name: "n", type: FIELD_TYPE.number, default: 0 }],
      },
    ],
    outputs: OUTPUTS.map((id) => ({
      id,
      name: id,
      kind: "item" as const,
      systems: systems(r),
      keep: [],
    })),
    prefabs: defs,
    prefabEntities: inside,
    entities,
  };
  for (let i = 0; i < 4; i++) change(snap, r, broken);
  return { snap, r };
}

/** 制作データを一か所変える（展開した ID を使う変更は、いまの展開から ID を選ぶ） */
function change(snap: ProjectSnapshot, r: Random, broken: boolean): void {
  const view = expandPrefabs(snap, { thorough: true });
  const ids = view.entities.map((e) => e.id);
  const instances = snap.entities.filter((e) => e.instanceOf);
  const plain = snap.entities.filter((e) => !e.instanceOf);
  const inst = instances.length > 0 ? r.pick(instances) : undefined;
  const within = (id: string) => ids.filter((x) => x.startsWith(`${id}/`));
  switch (r.int(broken ? 12 : 10)) {
    case 0: {
      // インスタンスを動かす
      if (inst)
        inst.states = { ...inst.states, [BUILTIN.Transform]: { position: [r.int(9), 0, 0] } };
      break;
    }
    case 1: {
      // インスタンスの中を変える（値・名前・並び・親・足した KokoState）
      if (!inst) break;
      const inner = within(inst.id);
      const path =
        r.chance(0.2) || inner.length === 0 ? "" : r.pick(inner).slice(inst.id.length + 1);
      inst.prefabOverrides = {
        ...inst.prefabOverrides,
        [path]: override(r, [null, ...inner, ...plain.map((e) => e.id), "nowhere"]),
      };
      break;
    }
    case 2: {
      // Entity を足す（いちばん上・ふつうの Entity の下・インスタンスの中・消えた親の下）
      const tag = tagOf(PREFABS.indexOf(inst?.instanceOf?.prefab ?? ""));
      const gone = inst
        ? [`${inst.id}/${tag}_gone`, `${inst.id}/${tag}_gone2`, `${inst.id}/${tag}_gone/x`]
        : [];
      const id = `added${snap.entities.length}_${r.int(1000)}`;
      snap.entities.push({
        id,
        output: r.chance(0.85) ? "out_main" : "out_b",
        parent: r.chance(0.25) && gone.length > 0 ? r.pick(gone) : r.pick([null, ...ids]),
        name: id,
        order: r.int(6),
        states: states(r, ids.length > 0 ? r.pick(ids) : undefined),
        ...(r.chance(0.3) ? { unpackedSystems: systems(r) } : {}),
        ...(r.chance(0.3) ? { instanceSystems: systems(r) } : {}),
      });
      break;
    }
    case 3: {
      // プレハブの中の値を変える
      const e = r.pick(snap.prefabEntities ?? []);
      e.states = { ...e.states, st: { hp: 50 + r.int(9) } };
      break;
    }
    case 4: {
      // プレハブの中の Entity を消す（消した Entity の元の親を覚えておく）
      const list = snap.prefabEntities ?? [];
      const e = r.pick(list);
      const def = snap.prefabs?.find((p) => p.id === e.prefab);
      if (!def || def.root === e.id) break;
      def.deletedParents = { ...def.deletedParents, [e.id]: e.parent };
      snap.prefabEntities = list.filter((x) => x.id !== e.id);
      break;
    }
    case 5: {
      // ふつうの Entity の親・並びを変える
      if (plain.length === 0) break;
      const e = r.pick(plain);
      e.parent = r.pick([null, ...ids.filter((x) => x !== e.id)]);
      e.order = r.int(6);
      break;
    }
    case 6: {
      // インスタンスを、ほかの Entity の下に入れる・System を足す
      if (!inst) break;
      inst.parent = r.pick([null, ...ids.filter((x) => x !== inst.id && !x.startsWith(inst.id))]);
      if (r.chance(0.5)) inst.instanceSystems = systems(r);
      break;
    }
    case 7: {
      // プレハブの System と「維持」の印を変える・インスタンスを足す
      const def = r.pick(snap.prefabs ?? []);
      def.systems = systems(r, 3);
      snap.entities.push({
        id: `inst_more${snap.entities.length}`,
        output: "out_main",
        parent: null,
        name: "足したインスタンス",
        order: r.int(6),
        states: {},
        instanceOf: { prefab: r.pick(PREFABS) },
      });
      break;
    }
    case 8: {
      // インスタンスかふつうの Entity を消す（その下の Entity は、親を見失う）
      if (snap.entities.length > 2) snap.entities.splice(r.int(snap.entities.length), 1);
      break;
    }
    case 9: {
      // プレハブの中に置いたインスタンス（入れ子）の中を変える
      const nests = (snap.prefabEntities ?? []).filter((e) => e.instanceOf);
      if (nests.length === 0) break;
      const nest = r.pick(nests);
      const peers = (snap.prefabEntities ?? []).filter((e) => e.prefab === nest.prefab);
      const inner = (snap.prefabEntities ?? [])
        .filter((e) => e.prefab === nest.instanceOf?.prefab && e.parent !== null)
        .map((e) => e.id);
      nest.prefabOverrides = {
        ...nest.prefabOverrides,
        [r.chance(0.2) || inner.length === 0 ? "" : r.pick(inner)]: override(r, [
          null,
          ...peers.map((e) => e.id),
          ...inner.map((id) => `${nest.id}/${id}`),
        ]),
      };
      break;
    }
    case 10: {
      // 壊れた形：親子の輪
      if (plain.length >= 2) {
        const [a, b] = [r.pick(plain), r.pick(plain)];
        a.parent = b.id;
        b.parent = a.id;
      } else if (inst) {
        const inner = within(inst.id);
        if (inner.length >= 2)
          inst.prefabOverrides = {
            ...inst.prefabOverrides,
            [r.pick(inner).slice(inst.id.length + 1)]: { parent: r.pick(inner) },
          };
      }
      break;
    }
    default: {
      // 壊れた形：同じ ID（制作データの Entity と同じ・展開した Entity と同じ）
      const id = r.pick(r.chance(0.5) && ids.length > 0 ? ids : snap.entities.map((e) => e.id));
      snap.entities.push({
        id,
        output: "out_main",
        parent: r.pick([null, ...ids]),
        name: "重なり",
        order: r.int(6),
        states: {},
        ...(r.chance(0.5) ? { instanceSystems: systems(r) } : {}),
        ...(r.chance(0.5) ? { unpackedSystems: systems(r) } : {}),
      });
    }
  }
}

/** 作った形に、確かめたいものが入っていた回数 */
const seen = { moved: 0, reattached: 0, added: 0, nested: 0, systems: 0, override: 0 };

function count(snap: ProjectSnapshot, view: ProjectSnapshot): void {
  const ids = new Set(view.entities.map((e) => e.id));
  for (const e of snap.entities) {
    for (const patch of Object.values(e.prefabOverrides ?? {})) {
      if (patch.parent !== undefined) seen.moved++;
      if (patch.states) seen.override++;
    }
    if (!e.instanceOf && e.parent?.includes("/")) seen.added++;
    // 親が見つからず、残っている祖先へ付け替えたもの
    const shown = view.entities.find((x) => x.id === e.id);
    if (e.parent !== null && !ids.has(e.parent) && shown && shown.parent !== e.parent)
      seen.reattached++;
  }
  if (view.entities.some((e) => e.id.split("/").length >= 3)) seen.nested++;
  if (view.outputs.some((o, i) => o.systems.length > (snap.outputs[i]?.systems.length ?? 0)))
    seen.systems++;
}

/** 近道をする展開・取っておいた結果を使う展開が、すべてをたどる展開と同じになるかを、変えながら確かめる */
function check(seed: number, broken: boolean): void {
  const { snap, r } = build(seed, broken);
  const cache = new PrefabExpansionCache();
  const editCaches = new Map(PREFABS.map((id) => [id, new PrefabExpansionCache()]));
  for (let step = 0; step < 5; step++) {
    if (step > 0) change(snap, r, broken);
    // 展開に渡したものは、あとで書き換えない（取っておいた結果が、同じ値を持ち続けるため）
    const now = structuredClone(snap);
    const label = `種 ${seed}・${step} 回目`;
    const full = expandPrefabs(now, { thorough: true });
    if (!broken) count(now, full);
    expect(expandPrefabs(now), `${label}：近道`).toStrictEqual(full);
    expect(expandPrefabs(now, { cache }), `${label}：取っておいた結果`).toStrictEqual(full);
    // 同じものをもう一度渡しても（何も変わっていないときも）同じ
    expect(expandPrefabs(now, { cache }), `${label}：変えずにもう一度`).toStrictEqual(full);
    for (const id of PREFABS) {
      const edit = expandPrefabForEdit(now, id, { thorough: true });
      const editCache = editCaches.get(id);
      expect(expandPrefabForEdit(now, id), `${label}：${id} を開く`).toStrictEqual(edit);
      expect(
        expandPrefabForEdit(now, id, { cache: editCache }),
        `${label}：${id} を開く（取っておいた結果）`,
      ).toStrictEqual(edit);
    }
  }
}

describe("展開の近道と、取っておいた結果（ADR 0076）", () => {
  it("取っておいた結果は、変わった所だけ作り直し、足した Entity と消えた親の変化も拾う", () => {
    const doc = new ProjectDoc();
    doc.load(emptyProject("取っておく"));
    const sys = doc.addSystem("PieceSystem", "export default system({});\n");
    const prefab = doc.addPrefab("駒");
    const def = doc.prefab(prefab);
    if (!def) throw new Error("プレハブがありません");
    doc.updatePrefab({ ...def, systems: [{ id: sys, enabled: true }] });
    const arm = doc.addPrefabEntity({ prefab, name: "腕" });
    const hand = doc.addPrefabEntity({ prefab, name: "手", parent: arm });
    for (const id of ["ent_a", "ent_b", "ent_c"])
      doc.addInstance({ output: "out_main", prefab, id });
    const added = doc.addEntity({ output: "out_main", name: "持ち物", parent: `ent_a/${hand}` });
    const cache = new PrefabExpansionCache();
    /** 取っておいた結果を使って展開し、何も取っておかない展開・すべてをたどる展開と同じかを見る */
    const expand = () => {
      const snap = doc.snapshot();
      const view = expandPrefabs(snap, { cache });
      expect(view).toStrictEqual(expandPrefabs(snap));
      expect(view).toStrictEqual(expandPrefabs(snap, { thorough: true }));
      return view;
    };
    const parentOf = (view: ProjectSnapshot, id: string) =>
      view.entities.find((e) => e.id === id)?.parent;

    const first = expand();
    expect([cache.builds, cache.stamped]).toEqual([1, 3]);
    expect(parentOf(first, added)).toBe(`ent_a/${hand}`);
    expect(first.outputs[0]?.systems).toEqual([{ id: sys, enabled: true }]);

    // 足した Entity を変えても、インスタンスは展開し直さない。前の結果を、そのまま使う
    doc.renameEntity(added, "道具");
    const renamed = expand();
    expect([cache.builds, cache.stamped]).toEqual([1, 3]);
    expect(renamed.entities.find((e) => e.id === added)?.name).toBe("道具");
    expect(renamed.entities.find((e) => e.id === `ent_b/${hand}`)).toBe(
      first.entities.find((e) => e.id === `ent_b/${hand}`),
    );

    // インスタンスの中の Entity の親を付け替えると、そのインスタンスだけを展開し直す
    doc.setParent(`ent_b/${hand}`, "ent_b");
    const moved = expand();
    expect([cache.builds, cache.stamped]).toEqual([1, 4]);
    expect(parentOf(moved, `ent_b/${hand}`)).toBe("ent_b");

    // インスタンスで System を足すと、アウトプットの System に加わる
    const extra = doc.addSystem("Extra", "export default system({});\n");
    doc.setInstanceSystems("ent_c", [{ id: extra, enabled: false }]);
    const more = expand();
    expect([cache.builds, cache.stamped]).toEqual([1, 5]);
    expect(more.outputs[0]?.systems).toEqual([
      { id: sys, enabled: true },
      { id: extra, enabled: false },
    ]);

    // プレハブから親（手）が消えると、プレハブを開き直し、足した Entity は残っている祖先（腕）に付く
    doc.removeEntity(hand);
    const gone = expand();
    expect([cache.builds, cache.stamped]).toEqual([2, 8]);
    expect(gone.entities.some((e) => e.id === `ent_a/${hand}`)).toBe(false);
    expect(parentOf(gone, added)).toBe(`ent_a/${arm}`);

    // 何も変えなければ、何も作り直さない
    expect(expand()).toStrictEqual(gone);
    expect([cache.builds, cache.stamped]).toEqual([2, 8]);
  });

  // 形をたくさん作るので、混んだ機械でも時間切れにならないよう、長めに待つ
  it("すべてをたどる展開と、同じ結果になる", { timeout: 60_000 }, () => {
    for (let seed = 1; seed <= 80; seed++) check(seed, false);
  });

  it("壊れた形（自分を含むプレハブ・親子の輪・同じ ID・ない親）でも、同じ結果になる", {
    timeout: 60_000,
  }, () => {
    for (let seed = 1001; seed <= 1080; seed++) check(seed, true);
  });

  it("作った形には、上書き・足した Entity・付け替えた親・消えた親・入れ子・System が入っている", () => {
    // 上の確かめが、見たいものを通っていること（通らなくなったら、形の作り方を直す）
    for (const [what, times] of Object.entries(seen)) expect(times, what).toBeGreaterThan(20);
  });
});
