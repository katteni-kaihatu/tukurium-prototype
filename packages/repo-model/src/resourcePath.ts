import { BUILTIN_KOKOSTATES } from "./builtins";
import type { AssetKind, ProjectSnapshot } from "./schema";

/**
 * 論理パス（ADR 0010）：人がリソースを指すための書き方。同一性は安定 ID のままで、
 * パスはその時点のフォルダ構造から決まる派生データ。制作データには保存しない。
 */

/** 論理パスを持つリソースの種類 */
export type PathKind = "folder" | "kokostate" | "system" | "material" | "asset";

/** Built-in の KokoState を指すパスの頭 */
export const BUILTIN_PREFIX = "@builtin/";

const KIND_EXT: Record<Exclude<PathKind, "folder" | "asset">, string> = {
  kokostate: ".koko",
  system: ".system",
  material: ".material",
};

const ASSET_EXT: Record<AssetKind, string> = {
  model: ".model",
  image: ".image",
  audio: ".audio",
};

/** 拡張子 → 種類（素材は種類ごとに別の拡張子） */
const EXT_KIND = new Map<string, PathKind>([
  ...Object.entries(KIND_EXT).map(([k, ext]) => [ext, k as PathKind] as const),
  ...Object.values(ASSET_EXT).map((ext) => [ext, "asset" as PathKind] as const),
]);

export type NameProblem = "empty" | "slash" | "nul" | "dot" | "reserved";

/** リソース・フォルダに使えない名前なら、その理由を返す */
export function validateName(name: string): NameProblem | null {
  const n = name.normalize("NFC");
  if (n.trim() === "") return "empty";
  if (n.includes("/")) return "slash";
  if (n.includes("\0")) return "nul";
  if (n === "." || n === "..") return "dot";
  if (n.startsWith("@builtin")) return "reserved";
  return null;
}

/** 名前を比べるための形：NFC にして大文字・小文字をそろえる */
export function normalizeName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export interface PathEntry {
  id: string;
  kind: PathKind;
  name: string;
  /** 入っているフォルダ（null はいちばん上。ないフォルダを指していたら null 扱い） */
  parent: string | null;
  /** 拡張子（フォルダは ""） */
  ext: string;
}

export type ResolveResult =
  | { ok: true; id: string; kind: PathKind }
  | {
      ok: false;
      reason: "not-found" | "ambiguous" | "escapes-root" | "no-base" | "invalid";
    };

export interface NameCollision {
  /** ぶつかっている場所（null はいちばん上） */
  parent: string | null;
  /** 比べた形の名前 */
  key: string;
  /** ぶつかっているリソース・フォルダの ID（並べ替え済み） */
  ids: string[];
}

const ROOT = "\u0000root";
const parentKey = (p: string | null) => p ?? ROOT;

/** 制作データの論理パスの索引。制作データが変わったら作り直す（軽い） */
export class ResourcePathIndex {
  private readonly entries = new Map<string, PathEntry>();
  /** 親 → 名前（比べる形）→ その名前のもの */
  private readonly children = new Map<string, Map<string, PathEntry[]>>();
  private readonly builtinByKey = new Map<string, string>();
  private readonly builtinName = new Map<string, string>();
  private readonly inCycle = new Set<string>();
  private readonly cycleList: string[][] = [];
  private readonly pathCache = new Map<string, string | null>();

  static fromSnapshot(snap: ProjectSnapshot): ResourcePathIndex {
    return new ResourcePathIndex(snap);
  }

  private constructor(snap: ProjectSnapshot) {
    for (const b of BUILTIN_KOKOSTATES) {
      this.builtinByKey.set(normalizeName(b.name), b.id);
      this.builtinName.set(b.id, b.name);
    }
    const folders = snap.folders ?? [];
    const folderIds = new Set(folders.map((f) => f.id));
    const placement = snap.placement ?? {};
    const placed = (id: string) => {
      const f = placement[id];
      return f && folderIds.has(f) ? f : null;
    };
    const add = (e: PathEntry) => {
      this.entries.set(e.id, e);
      const pk = parentKey(e.parent);
      let byName = this.children.get(pk);
      if (!byName) {
        byName = new Map();
        this.children.set(pk, byName);
      }
      const key = normalizeName(e.name);
      byName.set(key, [...(byName.get(key) ?? []), e]);
    };
    for (const f of folders)
      add({
        id: f.id,
        kind: "folder",
        name: f.name,
        parent: f.parent && folderIds.has(f.parent) ? f.parent : null,
        ext: "",
      });
    for (const k of snap.kokostates)
      if (!k.builtin)
        add({ id: k.id, kind: "kokostate", name: k.name, parent: placed(k.id), ext: ".koko" });
    for (const s of snap.systems)
      add({ id: s.id, kind: "system", name: s.name, parent: placed(s.id), ext: ".system" });
    for (const m of snap.materials)
      add({ id: m.id, kind: "material", name: m.name, parent: placed(m.id), ext: ".material" });
    for (const a of snap.assets ?? [])
      add({ id: a.id, kind: "asset", name: a.name, parent: placed(a.id), ext: ASSET_EXT[a.kind] });
    this.findCycles(folders.map((f) => f.id));
  }

  /** フォルダの輪を見つける（マージなどで起こりうる） */
  private findCycles(folderIds: string[]): void {
    const done = new Set<string>();
    for (const start of folderIds) {
      const trail: string[] = [];
      let cur: string | null = start;
      while (cur && !done.has(cur)) {
        const at = trail.indexOf(cur);
        if (at >= 0) {
          const cycle = trail.slice(at).sort();
          for (const id of cycle) this.inCycle.add(id);
          this.cycleList.push(cycle);
          break;
        }
        trail.push(cur);
        cur = this.entries.get(cur)?.parent ?? null;
      }
      for (const id of trail) done.add(id);
    }
    this.cycleList.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
  }

  entry(id: string): PathEntry | undefined {
    return this.entries.get(id);
  }

  all(): PathEntry[] {
    return [...this.entries.values()];
  }

  /** いまの論理パス。フォルダの輪の中（またはその下）なら null */
  pathOf(id: string): string | null {
    const builtin = this.builtinName.get(id);
    if (builtin) return `${BUILTIN_PREFIX}${builtin}.koko`;
    if (this.pathCache.has(id)) return this.pathCache.get(id) ?? null;
    const e = this.entries.get(id);
    let path: string | null = null;
    if (e) {
      const leaf = e.name + e.ext;
      if (e.kind === "folder" && this.inCycle.has(e.id)) path = null;
      else if (e.parent === null) path = `/${leaf}`;
      else {
        const parent = this.pathOf(e.parent);
        path = parent === null ? null : `${parent}/${leaf}`;
      }
    }
    this.pathCache.set(id, path);
    return path;
  }

  /**
   * 書き方を ID に解決する。相対パス（`./`・`../`・名前だけ）は、`from` のリソースが
   * 入っているフォルダを基準にする。
   */
  resolve(spelling: string, from?: string): ResolveResult {
    if (spelling.startsWith(BUILTIN_PREFIX)) {
      const leaf = spelling.slice(BUILTIN_PREFIX.length);
      if (!leaf.toLowerCase().endsWith(".koko")) return { ok: false, reason: "not-found" };
      const id = this.builtinByKey.get(normalizeName(leaf.slice(0, -".koko".length)));
      return id ? { ok: true, id, kind: "kokostate" } : { ok: false, reason: "not-found" };
    }
    let folder: string | null;
    let rest: string;
    if (spelling.startsWith("/")) {
      folder = null;
      rest = spelling.slice(1);
    } else {
      const base = from === undefined ? undefined : this.entries.get(from);
      if (!base) return { ok: false, reason: "no-base" };
      if (base.parent !== null && this.pathOf(base.parent) === null)
        return { ok: false, reason: "no-base" };
      folder = base.parent;
      rest = spelling;
    }
    const segments = rest.split("/");
    if (segments.some((s) => s === "")) return { ok: false, reason: "invalid" };
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] ?? "";
      const last = i === segments.length - 1;
      if (seg === ".") {
        if (last) return { ok: false, reason: "invalid" };
        continue;
      }
      if (seg === "..") {
        if (folder === null) return { ok: false, reason: "escapes-root" };
        folder = this.entries.get(folder)?.parent ?? null;
        if (last) return { ok: false, reason: "invalid" };
        continue;
      }
      let kind: PathKind = "folder";
      let name = seg;
      let ext = "";
      if (last) {
        const dot = seg.lastIndexOf(".");
        const k = dot > 0 ? EXT_KIND.get(seg.slice(dot).toLowerCase()) : undefined;
        if (k) {
          kind = k;
          ext = seg.slice(dot).toLowerCase();
          name = seg.slice(0, dot);
        }
      }
      const found = this.children.get(parentKey(folder))?.get(normalizeName(name)) ?? [];
      if (found.length > 1) return { ok: false, reason: "ambiguous" };
      const hit = found[0];
      if (!hit || hit.kind !== kind || (kind !== "folder" && hit.ext !== ext))
        return { ok: false, reason: "not-found" };
      if (last) return { ok: true, id: hit.id, kind: hit.kind };
      folder = hit.id;
    }
    return { ok: false, reason: "invalid" };
  }

  /** 同じ親の直下で、種類をまたいでぶつかっている名前 */
  collisions(): NameCollision[] {
    const out: NameCollision[] = [];
    for (const [pk, byName] of this.children)
      for (const [key, list] of byName)
        if (list.length > 1)
          out.push({
            parent: pk === ROOT ? null : pk,
            key,
            ids: list.map((e) => e.id).sort(),
          });
    return out.sort(
      (a, b) => (a.parent ?? "").localeCompare(b.parent ?? "") || a.key.localeCompare(b.key),
    );
  }

  /** フォルダの輪（それぞれ ID を並べ替えたもの） */
  cycles(): string[][] {
    return this.cycleList.map((c) => [...c]);
  }
}
