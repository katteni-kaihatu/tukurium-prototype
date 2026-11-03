import type { KokoStateDef } from "@tukurium/eks";
import { BUILTIN, isBuiltin } from "./builtins";
import { ProjectDependencyGraph } from "./dependencyGraph";
import { newId, type ProjectSnapshot, type Provenance } from "./schema";

export interface ExtractSelection {
  outputs: string[];
  kokostates: string[];
  systems: string[];
  materials: string[];
  assets: string[];
}

export interface ExtractSource {
  repoId: string;
  repoName: string;
  commit: string;
}

/**
 * 選んだアウトプット・リソースを、依存するもの（Entity・System・KokoState・マテリアル・素材）ごと集める。
 */
export function collectSelection(src: ProjectSnapshot, sel: ExtractSelection): ExtractSelection {
  const out = {
    outputs: new Set(sel.outputs),
    kokostates: new Set(sel.kokostates),
    systems: new Set(sel.systems),
    materials: new Set(sel.materials),
    assets: new Set(sel.assets),
  };
  for (const o of src.outputs) {
    if (!out.outputs.has(o.id)) continue;
    for (const s of o.systems) out.systems.add(s.id);
    for (const e of src.entities) {
      if (e.output !== o.id) continue;
      for (const [koko, values] of Object.entries(e.states)) {
        if (!isBuiltin(koko)) out.kokostates.add(koko);
        if (koko === BUILTIN.Mesh && typeof values.material === "string")
          out.materials.add(values.material);
        for (const v of Object.values(values)) {
          if (typeof v === "string" && (src.assets ?? []).some((a) => a.id === v))
            out.assets.add(v);
        }
      }
    }
  }
  // System が使う KokoState（import したもの・Query に名前で書いたもの）。依存グラフから集める
  const graph = ProjectDependencyGraph.fromSnapshot(src);
  for (const s of src.systems) {
    if (!out.systems.has(s.id)) continue;
    for (const dep of graph.dependenciesOf({ kind: "system", id: s.id })) {
      if (dep.kind === "kokostate" && !isBuiltin(dep.id)) out.kokostates.add(dep.id);
      if (dep.kind === "name" && dep.id.startsWith("kokostate/")) {
        const name = dep.id.slice("kokostate/".length);
        const def = src.kokostates.find((k) => k.name === name);
        if (def) out.kokostates.add(def.id);
      }
    }
  }
  for (const m of src.materials) if (out.materials.has(m.id) && m.map) out.assets.add(m.map);
  return {
    outputs: [...out.outputs],
    kokostates: [...out.kokostates],
    systems: [...out.systems],
    materials: [...out.materials],
    assets: [...out.assets],
  };
}

/**
 * 抽出：選んだもの（依存を含む）を、取り込み先の制作データに加える（取り込み先がなければ新しく作る）。
 * - 取り込み先に同じ ID で同じ中身があれば、そのまま使う。中身が違えば新しい ID を振り直す。
 * - KokoState の名前がぶつかったら名前を付け替え、取り出した System のコードの名前も書き換える。
 * - 由来（元のリポジトリ・コミット・取り出したもの）を provenance に残す。
 */
export function extractInto(
  src: ProjectSnapshot,
  selection: ExtractSelection,
  source: ExtractSource,
  target: ProjectSnapshot | null,
  name?: string,
): ProjectSnapshot {
  const sel = collectSelection(src, selection);
  const dst: ProjectSnapshot = target
    ? structuredClone(target)
    : {
        version: 1,
        name: name ?? src.name,
        kokostates: [],
        systems: [],
        materials: [],
        assets: [],
        outputs: [],
        entities: [],
      };
  dst.assets ??= [];
  const remap = new Map<string, string>();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // KokoState（名前の衝突も解く）
  const renamed = new Map<string, string>();
  for (const id of sel.kokostates) {
    const def = src.kokostates.find((k) => k.id === id);
    if (!def) continue;
    const existing = dst.kokostates.find((k) => k.id === id);
    if (existing && same(existing, def)) continue;
    const next: KokoStateDef = structuredClone(def);
    if (existing || dst.kokostates.some((k) => k.id === next.id)) {
      next.id = newId("ks");
      remap.set(id, next.id);
    }
    let n = 2;
    const base = next.name;
    while (dst.kokostates.some((k) => k.name === next.name)) next.name = `${base}_${n++}`;
    if (next.name !== base) renamed.set(base, next.name);
    dst.kokostates.push(next);
  }

  const copyById = <T extends { id: string }>(
    list: T[],
    into: T[],
    ids: string[],
    prefix: string,
  ) => {
    for (const id of ids) {
      const item = list.find((x) => x.id === id);
      if (!item) continue;
      const existing = into.find((x) => x.id === id);
      if (existing && same(existing, item)) continue;
      const next = structuredClone(item);
      if (existing) {
        next.id = newId(prefix);
        remap.set(id, next.id);
      }
      into.push(next);
    }
  };
  copyById(src.materials, dst.materials, sel.materials, "mat");
  copyById(src.assets ?? [], dst.assets, sel.assets, "asset");

  for (const id of sel.systems) {
    const s = src.systems.find((x) => x.id === id);
    if (!s) continue;
    let code = s.code;
    for (const [from, to] of renamed)
      code = code.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`.${from}.`, `.${to}.`);
    const next = { ...s, code };
    const existing = dst.systems.find((x) => x.id === id);
    if (existing && same(existing, next)) continue;
    if (existing) {
      next.id = newId("sys");
      remap.set(id, next.id);
    }
    dst.systems.push(next);
  }

  const r = (id: string) => remap.get(id) ?? id;
  for (const oid of sel.outputs) {
    const o = src.outputs.find((x) => x.id === oid);
    if (!o) continue;
    const newOut = dst.outputs.some((x) => x.id === oid) ? newId("out") : oid;
    const entityIds = new Map<string, string>();
    for (const e of src.entities.filter((x) => x.output === oid)) {
      entityIds.set(e.id, dst.entities.some((x) => x.id === e.id) ? newId("ent") : e.id);
    }
    dst.outputs.push({
      ...structuredClone(o),
      id: newOut,
      systems: o.systems.map((s) => ({ ...s, id: r(s.id) })),
      keep: o.keep.map((k) => ({
        ...k,
        entity: entityIds.get(k.entity) ?? k.entity,
        koko: r(k.koko),
      })),
    });
    for (const e of src.entities.filter((x) => x.output === oid)) {
      const states: typeof e.states = {};
      for (const [koko, values] of Object.entries(e.states)) {
        const v = structuredClone(values);
        for (const [f, val] of Object.entries(v))
          if (typeof val === "string" && remap.has(val)) v[f] = r(val);
        states[r(koko)] = v;
      }
      dst.entities.push({
        ...structuredClone(e),
        id: entityIds.get(e.id) ?? e.id,
        parent: e.parent ? (entityIds.get(e.parent) ?? e.parent) : null,
        output: newOut,
        states,
      });
    }
  }

  const names = [
    ...sel.outputs.map((id) => src.outputs.find((o) => o.id === id)?.name ?? id),
    ...selection.kokostates.map((id) => src.kokostates.find((k) => k.id === id)?.name ?? id),
    ...selection.systems.map((id) => src.systems.find((s) => s.id === id)?.name ?? id),
    ...selection.materials.map((id) => src.materials.find((m) => m.id === id)?.name ?? id),
    ...selection.assets.map((id) => src.assets?.find((a) => a.id === id)?.name ?? id),
  ];
  const record: Provenance = {
    kind: "extract",
    repoId: source.repoId,
    repoName: source.repoName,
    commit: source.commit,
    items: [...new Set(names)],
    at: new Date().toISOString(),
  };
  dst.provenance = [...(dst.provenance ?? []), record];
  return dst;
}
