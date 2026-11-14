import { equalValues } from "@tukurium/eks";
import type { EntityDef, PrefabEntityOverride } from "@tukurium/repo-model";

/** 保存の差分でも、プレハブの差分でも、同じ部分を指す。 */
export interface PrefabChangePart {
  path: string;
  kind: "name" | "parent" | "order" | "state" | "field" | "system";
  koko?: string;
  field?: string;
  before: unknown;
  after: unknown;
  beforePresent: boolean;
  afterPresent: boolean;
  part: string;
}

export function prefabPart(path: string, kind: PrefabChangePart["kind"], koko = "", field = "") {
  return `prefab:${[path, kind, koko, field].map(encodeURIComponent).join(":")}`;
}

export function parsePrefabPart(
  part: string,
): Pick<PrefabChangePart, "path" | "kind" | "koko" | "field"> | null {
  if (!part.startsWith("prefab:")) return null;
  const [path, kind, koko, field] = part.slice(7).split(":").map(decodeURIComponent);
  if (
    path === undefined ||
    !["name", "parent", "order", "state", "field", "system"].includes(kind ?? "")
  )
    return null;
  return { path, kind: kind as PrefabChangePart["kind"], koko, field };
}

export function prefabChangeParts(
  before: Pick<EntityDef, "prefabOverrides" | "instanceSystems"> | undefined,
  after: Pick<EntityDef, "prefabOverrides" | "instanceSystems"> | undefined,
): PrefabChangePart[] {
  const out: PrefabChangePart[] = [];
  const push = (
    path: string,
    kind: PrefabChangePart["kind"],
    prev: unknown,
    next: unknown,
    koko?: string,
    field?: string,
    presence = { before: prev !== undefined, after: next !== undefined },
  ) => {
    if (presence.before !== presence.after || !equalValues(prev, next))
      out.push({
        path,
        kind,
        before: prev,
        after: next,
        beforePresent: presence.before,
        afterPresent: presence.after,
        koko,
        field,
        part: prefabPart(path, kind, koko, field),
      });
  };
  for (const path of new Set([
    ...Object.keys(before?.prefabOverrides ?? {}),
    ...Object.keys(after?.prefabOverrides ?? {}),
  ])) {
    const a: PrefabEntityOverride = before?.prefabOverrides?.[path] ?? {};
    const b: PrefabEntityOverride = after?.prefabOverrides?.[path] ?? {};
    for (const kind of ["name", "parent", "order"] as const) push(path, kind, a[kind], b[kind]);
    for (const koko of new Set([
      ...Object.keys(a.addedStates ?? {}),
      ...Object.keys(b.addedStates ?? {}),
    ]))
      push(path, "state", a.addedStates?.[koko], b.addedStates?.[koko], koko);
    for (const koko of new Set([...Object.keys(a.states ?? {}), ...Object.keys(b.states ?? {})])) {
      for (const field of new Set([
        ...Object.keys(a.states?.[koko] ?? {}),
        ...Object.keys(b.states?.[koko] ?? {}),
      ]))
        push(path, "field", a.states?.[koko]?.[field], b.states?.[koko]?.[field], koko, field, {
          before: Object.hasOwn(a.states?.[koko] ?? {}, field),
          after: Object.hasOwn(b.states?.[koko] ?? {}, field),
        });
    }
  }
  for (const id of new Set([
    ...(before?.instanceSystems ?? []).map((s) => s.id),
    ...(after?.instanceSystems ?? []).map((s) => s.id),
  ])) {
    const a = before?.instanceSystems?.find((s) => s.id === id);
    const b = after?.instanceSystems?.find((s) => s.id === id);
    push(
      "",
      "system",
      a && { ...a, order: before?.instanceSystems?.indexOf(a) },
      b && { ...b, order: after?.instanceSystems?.indexOf(b) },
      id,
    );
  }
  return out;
}
