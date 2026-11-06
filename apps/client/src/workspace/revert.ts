import type { FieldValue } from "@tukurium/eks";
import type {
  EntityDef,
  KeepMark,
  OutputDef,
  ProjectDoc,
  ProjectSnapshot,
} from "@tukurium/repo-model";
import type { DiffEntry } from "./diffView";

/**
 * 差分（DiffEntry の id と、DiffLine の part）を、最後に保存した形に戻す手順にする。
 * 戻せないもの（素材の差し替えやフォルダなど）は null。
 * 実行すると例外を投げることがある（名前が重なる、親子が輪になるなど）。
 */
export function planRevert(
  project: ProjectDoc,
  head: ProjectSnapshot,
  entryId: string,
  part?: string,
): (() => void) | null {
  const at = entryId.indexOf(":");
  if (at < 0) return null;
  const group = entryId.slice(0, at);
  const id = entryId.slice(at + 1);
  switch (group) {
    case "entity":
      return entityRevert(project, head, id, part);
    case "output":
      return outputRevert(project, head, id, part);
    case "koko":
      return kokoRevert(project, head, id, part);
    case "code":
      return codeRevert(project, head, id, part);
    case "material":
      return materialRevert(project, head, id, part);
    case "model":
    case "image":
    case "audio":
      return part ? null : assetRevert(project, head, id);
    case "other":
      return !part && id === "name" ? () => project.setName(head.name) : null;
    default:
      return null;
  }
}

/** 差分のうち、part に当たる行だけにする（Inspector の丸に出す分）。part がなければそのまま。 */
export function entryPart(entry: DiffEntry, part?: string): DiffEntry {
  if (!part) return entry;
  const fieldsOf = part.startsWith("state:") ? `field:${part.slice("state:".length)}:` : null;
  return {
    ...entry,
    lines: entry.lines.filter(
      (l) => l.part === part || (fieldsOf !== null && l.part?.startsWith(fieldsOf)),
    ),
    code: part === "code" ? entry.code : undefined,
    preview: part === "map" ? entry.preview : undefined,
  };
}

// ---------------------------------------------------------------------------

function entityRevert(
  project: ProjectDoc,
  head: ProjectSnapshot,
  id: string,
  part?: string,
): (() => void) | null {
  const saved = head.entities.find((e) => e.id === id);
  const cur = project.entity(id);
  if (!part) {
    if (!saved) {
      if (!cur) return null;
      return () =>
        project.transact(() => {
          // 保存にある子は、保存したときの親へ戻してから消す（一緒に消さない）
          for (const child of project.entities().filter((e) => e.parent === id)) {
            const was = head.entities.find((e) => e.id === child.id);
            if (was) project.restorePlace(child.id, placeOf(project, was));
          }
          project.removeEntity(id);
        });
    }
    if (!project.output(saved.output)) return null;
    return () =>
      project.transact(() => {
        // 消えた Entity は、一緒に消えた子も戻す（親から順に）
        const restored = [saved, ...missingDescendants(project, head, id)];
        for (const def of restored) {
          project.restoreEntity({ ...def, parent: existingParent(project, def, restored) });
        }
        const ids = new Set(restored.map((e) => e.id));
        setKeep(project, head, saved.output, (k) => ids.has(k.entity));
      });
  }
  if (!saved || !cur) return null;
  if (part === "name") return () => project.renameEntity(id, saved.name);
  if (part === "place") {
    if (!project.output(saved.output)) return null;
    return () => project.restorePlace(id, placeOf(project, saved));
  }
  if (part.startsWith("state:")) {
    const koko = part.slice("state:".length);
    const values = saved.states[koko] ?? null;
    return () =>
      project.transact(() => {
        project.restoreState(id, koko, values);
        setKeep(project, head, cur.output, (k) => k.entity === id && k.koko === koko);
      });
  }
  if (part.startsWith("field:")) {
    const [koko, field] = splitTwo(part.slice("field:".length));
    if (!koko || !field) return null;
    const before = saved.states[koko];
    if (!before || !Object.hasOwn(before, field) || !(koko in cur.states)) return null;
    const value = before[field] as FieldValue;
    return () =>
      project.transact(() => {
        project.setField(id, koko, field, value);
        setKeep(
          project,
          head,
          cur.output,
          (k) => k.entity === id && k.koko === koko && k.field === field,
        );
      });
  }
  return null;
}

function outputRevert(
  project: ProjectDoc,
  head: ProjectSnapshot,
  id: string,
  part?: string,
): (() => void) | null {
  const saved = head.outputs.find((o) => o.id === id);
  const cur = project.output(id);
  if (!part) {
    // アウトプットがなくなると編集する先がないので、最後の一つは消さない
    if (!saved) return cur && project.outputs().length > 1 ? () => project.removeOutput(id) : null;
    return () => {
      const alive = new Set(project.entities(id).map((e) => e.id));
      project.updateOutput({ ...saved, keep: saved.keep.filter((k) => alive.has(k.entity)) });
    };
  }
  if (!saved || !cur) return null;
  const pick: Partial<Record<string, (keyof OutputDef)[]>> = {
    name: ["name"],
    kind: ["kind"],
    exposure: ["exposure"],
    guest: ["guestPolicy"],
    systems: ["systems"],
  };
  if (part === "keep") {
    return () => {
      const alive = new Set(project.entities(id).map((e) => e.id));
      project.updateOutput({ ...cur, keep: saved.keep.filter((k) => alive.has(k.entity)) });
    };
  }
  const keys = pick[part];
  if (!keys) return null;
  return () => {
    const next: OutputDef = { ...cur };
    for (const key of keys) Object.assign(next, { [key]: saved[key] });
    project.updateOutput(next);
  };
}

function kokoRevert(
  project: ProjectDoc,
  head: ProjectSnapshot,
  id: string,
  part?: string,
): (() => void) | null {
  const saved = head.kokostates.find((k) => k.id === id);
  const cur = project.kokostate(id);
  if (cur?.builtin) return null;
  if (!part) {
    if (!saved) return cur ? () => project.removeKokoState(id) : null;
    return () => project.updateKokoState(structuredClone(saved));
  }
  if (!saved || !cur) return null;
  if (part === "name") return () => project.updateKokoState({ ...cur, name: saved.name });
  if (part.startsWith("field:")) {
    const fid = part.slice("field:".length);
    const was = saved.fields.find((f) => f.id === fid);
    const index = saved.fields.findIndex((f) => f.id === fid);
    return () => {
      const fields = cur.fields.filter((f) => f.id !== fid);
      if (was) {
        const at = cur.fields.findIndex((f) => f.id === fid);
        fields.splice(at >= 0 ? at : Math.min(index, fields.length), 0, structuredClone(was));
      }
      project.updateKokoState({ ...cur, fields });
    };
  }
  return null;
}

function codeRevert(
  project: ProjectDoc,
  head: ProjectSnapshot,
  id: string,
  part?: string,
): (() => void) | null {
  const saved = head.systems.find((s) => s.id === id);
  const cur = project.system(id);
  if (!part) {
    if (!saved) return cur ? () => project.removeSystem(id) : null;
    return () => project.restoreSystem({ id, name: saved.name }, saved.code);
  }
  if (!saved || !cur) return null;
  if (part === "name") return () => project.renameSystem(id, saved.name);
  if (part === "code") return () => project.restoreSystem(cur, saved.code);
  return null;
}

function materialRevert(
  project: ProjectDoc,
  head: ProjectSnapshot,
  id: string,
  part?: string,
): (() => void) | null {
  const saved = head.materials.find((m) => m.id === id);
  const cur = project.material(id);
  if (!part) {
    if (!saved) return cur ? () => project.removeMaterial(id) : null;
    return () => project.updateMaterial(structuredClone(saved));
  }
  if (!saved || !cur) return null;
  const key = (["name", "color", "roughness", "metalness", "map"] as const).find((k) => k === part);
  if (!key) return null;
  return () => project.updateMaterial({ ...cur, [key]: saved[key] ?? null });
}

/** 素材の id は「前の id>後の id」。同じ素材の名前の変更か、足した・消しただけを戻す。 */
function assetRevert(project: ProjectDoc, head: ProjectSnapshot, id: string): (() => void) | null {
  const [prevId, nextId] = id.split(">");
  const prev = prevId ? head.assets?.find((a) => a.id === prevId) : undefined;
  if (prev && (!nextId || nextId === prevId)) return () => project.addAsset(structuredClone(prev));
  if (!prevId && nextId && project.asset(nextId)) return () => project.removeAsset(nextId);
  return null;
}

// ---------------------------------------------------------------------------

function splitTwo(text: string): [string | undefined, string | undefined] {
  const at = text.indexOf(":");
  return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
}

/** 保存したときの置き場所。親がいまないときは、いちばん上に置く。 */
function placeOf(project: ProjectDoc, saved: EntityDef) {
  return {
    parent: saved.parent && project.entity(saved.parent) ? saved.parent : null,
    output: saved.output,
    order: saved.order,
  };
}

function existingParent(
  project: ProjectDoc,
  def: EntityDef,
  restoring: EntityDef[],
): string | null {
  if (!def.parent) return null;
  if (project.entity(def.parent) || restoring.some((e) => e.id === def.parent)) return def.parent;
  return null;
}

/** 保存にあって、いまない子孫（親から順）。 */
function missingDescendants(project: ProjectDoc, head: ProjectSnapshot, id: string): EntityDef[] {
  const out: EntityDef[] = [];
  const seen = new Set([id]);
  for (let i = -1; i < out.length; i++) {
    const parent = i < 0 ? id : out[i]?.id;
    for (const e of head.entities) {
      if (e.parent !== parent || seen.has(e.id) || project.entity(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

/** 状態維持の印のうち、match に当たるものを、保存したときのものに揃える。 */
function setKeep(
  project: ProjectDoc,
  head: ProjectSnapshot,
  outputId: string,
  match: (k: KeepMark) => boolean,
) {
  const output = project.output(outputId);
  if (!output) return;
  const saved = head.outputs.find((o) => o.id === outputId)?.keep ?? [];
  const keep = [...output.keep.filter((k) => !match(k)), ...saved.filter(match)];
  const key = (k: KeepMark) => `${k.entity}\0${k.koko}\0${k.field}`;
  if (output.keep.map(key).sort().join("\n") === keep.map(key).sort().join("\n")) return;
  project.updateOutput({ ...output, keep });
}
