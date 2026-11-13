import type { FieldDef, KokoStateDef } from "@tukurium/eks";
import {
  BUILTIN_KOKOSTATES,
  type PackageResolution,
  type ProjectSnapshot,
  packageResourceId,
  ResourcePathIndex,
} from "@tukurium/repo-model";

/**
 * 型を確かめるための仮想のファイル（ADR 0058）。
 * - KokoState は、論理パスに合わせた宣言（`/States/Gun.koko.d.ts`）にする。
 *   `import Gun from "./States/Gun.koko"` を、TypeScript がそのまま結び付けられる。
 * - Built-in は `/__builtin/`、ライブラリは `/__packages/<別名>/` に置き、
 *   `@builtin/...`・`@別名/...` を compilerOptions の paths でつなぐ。
 * - System は、論理パスに `.ts` を付けたファイル（`/Shoot.system.ts`）にする。
 */

export const HOST_FILE = "/__host.d.ts";
export const BUILTIN_DIR = "/__builtin";
export const PACKAGES_DIR = "/__packages";

/** プロパティの名前として書ける形にする（書けない名前は引用符で囲む） */
const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

/**
 * KokoState の宣言ファイルの中身。ID は実行時に __koko(ID, 名前) で渡るものと同じにする。
 * フィールドの型は、型の文をそのまま書く（ADR 0065）。型エラーのあるフィールド（badFields）は
 * unknown にして、ほかのフィールドを使えるままにする。
 */
export function kokoStateDeclaration(
  id: string,
  def: Pick<KokoStateDef, "name" | "fields">,
  badFields?: ReadonlySet<string>,
): string {
  const fields = def.fields
    .map((f) => `  ${key(f.name)}: ${badFields?.has(f.id) ? "unknown" : `(${f.type})`};`)
    .join("\n");
  return [
    `/** ${def.name} */`,
    `declare const koko: KokoState<${JSON.stringify(id)}, {\n${fields}\n}>;`,
    "export default koko;",
    "",
  ].join("\n");
}

/** ライブラリの公開パスを、`/__packages/<別名>/` の下のファイルの場所にする */
function packageFile(alias: string, path: string): string {
  const rel = path.replace(/^\/+/, "");
  return `${PACKAGES_DIR}/${alias}/${rel.endsWith(".koko") ? rel : `${rel}.koko`}.d.ts`;
}

export interface VirtualProject {
  /** パス → 中身 */
  files: Map<string, string>;
  /** System の ID → そのファイルのパス */
  systemFiles: Map<string, string>;
  /** `@builtin/*` と `@別名/*` を、仮想のファイルの場所へつなぐ */
  paths: Record<string, string[]>;
}

/** フィールドの型を確かめるための仮想のファイルを置く所 */
export const FIELDS_DIR = "/__fields";

/** 型を確かめる KokoState（制作データのものと、依存から取り込んだもの） */
export interface FieldOwner {
  /** スクリプトから見える ID（依存のものは `pkg:` の ID） */
  id: string;
  name: string;
  fields: FieldDef[];
  /** 制作データの KokoState か（型エラーを問題として出すのは、こちらだけ） */
  own: boolean;
}

/** フィールドの型を持つ KokoState を、Built-in・制作データ・依存の順に並べる */
export function fieldOwners(
  snap: ProjectSnapshot,
  packages: ReadonlyMap<string, PackageResolution>,
): FieldOwner[] {
  const out: FieldOwner[] = [];
  for (const k of BUILTIN_KOKOSTATES)
    out.push({ id: k.id, name: k.name, fields: k.fields, own: false });
  for (const k of snap.kokostates)
    out.push({ id: k.id, name: k.name, fields: k.fields, own: true });
  for (const r of packages.values()) {
    if (r.status !== "ready") continue;
    for (const e of r.manifest.exports) {
      const def = e.definition as Partial<KokoStateDef> | null;
      if (e.kind !== "kokostate" || typeof def?.name !== "string" || !Array.isArray(def.fields))
        continue;
      out.push({
        id: packageResourceId(r.dependency, e.id),
        name: def.name,
        fields: def.fields,
        own: false,
      });
    }
  }
  return out;
}

export function virtualProject(
  snap: ProjectSnapshot,
  packages: ReadonlyMap<string, PackageResolution>,
  hostDeclarations: string,
  /** 型エラーのあるフィールド（KokoState の ID → フィールドの ID）。宣言では unknown にする */
  badFields: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): VirtualProject {
  const index = ResourcePathIndex.fromSnapshot(snap);
  const files = new Map<string, string>([[HOST_FILE, hostDeclarations]]);
  const systemFiles = new Map<string, string>();
  const paths: Record<string, string[]> = { "@builtin/*": [`${BUILTIN_DIR}/*`] };

  for (const k of BUILTIN_KOKOSTATES)
    files.set(
      `${BUILTIN_DIR}/${k.name}.koko.d.ts`,
      kokoStateDeclaration(k.id, k, badFields.get(k.id)),
    );

  for (const k of snap.kokostates) {
    const path = index.pathOf(k.id);
    if (path) files.set(`${path}.d.ts`, kokoStateDeclaration(k.id, k, badFields.get(k.id)));
  }

  for (const [alias, r] of packages) {
    paths[`@${alias}/*`] = [`${PACKAGES_DIR}/${alias}/*`];
    if (r.status !== "ready") continue;
    for (const e of r.manifest.exports) {
      const def = e.definition as Partial<KokoStateDef> | null;
      if (e.kind !== "kokostate" || typeof def?.name !== "string" || !Array.isArray(def.fields))
        continue;
      const id = packageResourceId(r.dependency, e.id);
      files.set(
        packageFile(alias, e.path),
        kokoStateDeclaration(id, { name: def.name, fields: def.fields }, badFields.get(id)),
      );
    }
  }

  for (const s of snap.systems) {
    const path = `${index.pathOf(s.id) ?? `/${s.name}.system`}.ts`;
    files.set(path, s.code);
    systemFiles.set(s.id, path);
  }
  return { files, systemFiles, paths };
}
