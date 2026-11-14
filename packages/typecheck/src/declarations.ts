import type { FieldDef, KokoStateDef } from "@tukurium/eks";
import {
  BUILTIN_KOKOSTATES,
  type PackageResolution,
  type ProjectSnapshot,
  packageResourceId,
  ResourcePathIndex,
} from "@tukurium/repo-model";
import ts from "typescript6";

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

/** 説明をコメントとして書く。コメントの終端を含む文章も宣言を壊さない。 */
const jsdoc = (text: string) =>
  `/**\n${text
    .replace(/\*\//g, "* / ")
    .split(/\r?\n/)
    .map((line) => ` * ${line}`)
    .join("\n")}\n */`;

/**
 * KokoState の宣言ファイルの中身。ID は実行時に __koko(ID, 名前) で渡るものと同じにする。
 * フィールドの型は、型の文をそのまま書く（ADR 0065）。型エラーのあるフィールド（badFields）は
 * unknown にして、ほかのフィールドを使えるままにする。imports は、使う型の定義の import 文。
 */
export function kokoStateDeclaration(
  id: string,
  def: Pick<KokoStateDef, "name" | "fields" | "description">,
  badFields?: ReadonlySet<string>,
  imports = "",
): string {
  const fields = def.fields
    .map(
      (f) =>
        `${f.description ? `${jsdoc(f.description)}\n` : ""}  ${key(f.name)}: ${badFields?.has(f.id) ? "unknown" : `(${f.type})`};`,
    )
    .join("\n");
  return [
    ...(imports ? [imports.trimEnd()] : []),
    jsdoc(def.description || def.name),
    `declare const koko: KokoState<${JSON.stringify(id)}, {\n${fields}\n}>;`,
    // 型としても使える（`KokoStateRef<Health>` のように、参照の型で指せる KokoState を書く。ADR 0065）
    "type koko = typeof koko;",
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
  /** KokoState の宣言ファイル → ID。同じ名前が別のフォルダにあっても区別する。 */
  kokoFiles: Map<string, string>;
  /** `@builtin/*` と `@別名/*` を、仮想のファイルの場所へつなぐ */
  paths: Record<string, string[]>;
}

/** フィールドの型を確かめるための仮想のファイルを置く所 */
export const FIELDS_DIR = "/__fields";

/** 型の定義のファイル（ADR 0065）。制作データのものと、依存から取り込んだもの */
export interface TypeDefFile {
  /** KokoState の `typeDefs` に書く ID（依存のものは `pkg:` の ID） */
  id: string;
  name: string;
  /** 仮想のファイルの場所（`/Types/Card.types.d.ts`） */
  file: string;
  /** import に書く場所（file から `.d.ts` を除いたもの） */
  spec: string;
  code: string;
  /** 制作データの型の定義か（型エラーを問題として出すのは、こちらだけ） */
  own: boolean;
  /** 公開している型の名前（`export type` と `export interface`） */
  names: string[];
}

/** 型の定義のコードが公開している型の名前を読む */
export function exportedTypeNames(code: string): string[] {
  const source = ts.createSourceFile("/types.d.ts", code, ts.ScriptTarget.ES2022, false);
  const names: string[] = [];
  for (const s of source.statements) {
    if (!ts.isTypeAliasDeclaration(s) && !ts.isInterfaceDeclaration(s)) continue;
    const exported = (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && !names.includes(s.name.text)) names.push(s.name.text);
  }
  return names;
}

/** 型の定義を、仮想のファイルにする（制作データは論理パス、依存は `/__packages/<別名>/` の下） */
export function typeDefFiles(
  snap: ProjectSnapshot,
  packages: ReadonlyMap<string, PackageResolution>,
  index: ResourcePathIndex = ResourcePathIndex.fromSnapshot(snap),
): TypeDefFile[] {
  const out: TypeDefFile[] = [];
  const add = (id: string, name: string, spec: string, code: string, own: boolean) =>
    out.push({ id, name, spec, file: `${spec}.d.ts`, code, own, names: exportedTypeNames(code) });
  for (const t of snap.types ?? []) {
    const path = index.pathOf(t.id);
    if (path) add(t.id, t.name, path, t.code, true);
  }
  for (const [alias, r] of packages) {
    if (r.status !== "ready") continue;
    for (const e of r.manifest.exports) {
      const def = e.definition as { name?: unknown; code?: unknown } | null;
      if (e.kind !== "typedef" || typeof def?.name !== "string" || typeof def.code !== "string")
        continue;
      const rel = e.path.replace(/^\/+/, "");
      add(
        packageResourceId(r.dependency, e.id),
        def.name,
        `${PACKAGES_DIR}/${alias}/${rel}`,
        def.code,
        false,
      );
    }
  }
  return out;
}

/** 使う型の定義の import 文（公開している型の名前を、そのままの名前で使えるようにする） */
export function typeImports(
  typeDefs: readonly string[] | undefined,
  files: ReadonlyMap<string, TypeDefFile>,
): string {
  let out = "";
  for (const id of typeDefs ?? []) {
    const f = files.get(id);
    if (!f || f.names.length === 0) continue;
    out += `import type { ${f.names.join(", ")} } from ${JSON.stringify(f.spec)};\n`;
  }
  return out;
}

/** 型の文から名前で指せる KokoState（`KokoStateRef<Health>` の `Health`）と、その宣言の場所 */
export interface KokoName {
  /** スクリプトから見える ID（依存のものは `pkg:` の ID） */
  id: string;
  name: string;
  /** import に書く場所（宣言のファイルから `.d.ts` を除いたもの） */
  spec: string;
}

/**
 * 型の文から名前で指せる KokoState を集める。同じ名前が複数あるときは、制作データのもの・Built-in・
 * ライブラリのものの順で、その中で一つに決まるものだけを使う（決まらない名前は、型の文で使えない）。
 */
export function kokoNames(
  snap: ProjectSnapshot,
  packages: ReadonlyMap<string, PackageResolution>,
  index: ResourcePathIndex = ResourcePathIndex.fromSnapshot(snap),
): KokoName[] {
  const tiers: KokoName[][] = [[], [], []];
  for (const k of snap.kokostates) {
    const path = index.pathOf(k.id);
    if (path) tiers[0]?.push({ id: k.id, name: k.name, spec: path });
  }
  for (const k of BUILTIN_KOKOSTATES)
    tiers[1]?.push({ id: k.id, name: k.name, spec: `${BUILTIN_DIR}/${k.name}.koko` });
  for (const [alias, r] of packages) {
    if (r.status !== "ready") continue;
    for (const e of r.manifest.exports) {
      const def = e.definition as Partial<KokoStateDef> | null;
      if (e.kind !== "kokostate" || typeof def?.name !== "string") continue;
      tiers[2]?.push({
        id: packageResourceId(r.dependency, e.id),
        name: def.name,
        spec: packageFile(alias, e.path).replace(/\.d\.ts$/, ""),
      });
    }
  }
  const out = new Map<string, KokoName>();
  for (const tier of tiers) {
    const count = new Map<string, number>();
    for (const k of tier) count.set(k.name, (count.get(k.name) ?? 0) + 1);
    for (const k of tier) if (count.get(k.name) === 1 && !out.has(k.name)) out.set(k.name, k);
  }
  return [...out.values()];
}

/**
 * フィールドの型を確かめる間だけ使う、KokoState の仮の宣言（ID だけ。フィールドは書かない）。
 * 型の文は `KokoStateRef<Health>` のように KokoState の ID だけを使うので、これで足りる。本当の宣言は、
 * フィールドの型を確かめたあとに作る（型エラーのあるフィールドを unknown にするため）。
 */
export function kokoStateStub(id: string): string {
  return `declare const koko: KokoState<${JSON.stringify(id)}>;
type koko = typeof koko;
export default koko;
`;
}

/** 型の文に出てくる KokoState の名前の import 文（出てこない名前は import しない） */
export function kokoImports(typeTexts: readonly string[], names: readonly KokoName[]): string {
  let out = "";
  for (const k of names) {
    if (!/^[A-Za-z_$][\w$]*$/.test(k.name)) continue;
    const word = new RegExp(`(?<![\\w$.])${k.name.replace(/\$/g, "\\$")}(?![\\w$])`);
    if (typeTexts.some((t) => typeof t === "string" && word.test(t)))
      out += `import type ${k.name} from ${JSON.stringify(k.spec)};\n`;
  }
  return out;
}

/** 型を確かめる KokoState（制作データのものと、依存から取り込んだもの） */
export interface FieldOwner {
  /** スクリプトから見える ID（依存のものは `pkg:` の ID） */
  id: string;
  name: string;
  fields: FieldDef[];
  /** 使う型の定義の ID（依存のものは `pkg:` の ID） */
  typeDefs?: string[];
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
    out.push({
      id: k.id,
      name: k.name,
      fields: k.fields,
      own: true,
      ...(k.typeDefs ? { typeDefs: k.typeDefs } : {}),
    });
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
        // ライブラリの KokoState が使う型の定義は、同じライブラリの中の ID で書いてある
        ...(Array.isArray(def.typeDefs)
          ? { typeDefs: def.typeDefs.map((t) => packageResourceId(r.dependency, String(t))) }
          : {}),
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
  const kokoFiles = new Map<string, string>();
  const paths: Record<string, string[]> = { "@builtin/*": [`${BUILTIN_DIR}/*`] };
  // 型の定義（ADR 0065）。KokoState の宣言は、使う型の定義を import する
  const typeDefs = new Map(typeDefFiles(snap, packages, index).map((f) => [f.id, f] as const));
  for (const f of typeDefs.values()) files.set(f.file, f.code);
  // 型の文から名前で指せる KokoState（参照の型で使う）
  const names = kokoNames(snap, packages, index);
  const importsOf = (def: Pick<KokoStateDef, "fields">, uses: readonly string[] | undefined) =>
    typeImports(uses, typeDefs) +
    kokoImports(
      def.fields.map((f) => f.type),
      names,
    );

  for (const k of BUILTIN_KOKOSTATES) {
    kokoFiles.set(`${BUILTIN_DIR}/${k.name}.koko.d.ts`, k.id);
    files.set(
      `${BUILTIN_DIR}/${k.name}.koko.d.ts`,
      kokoStateDeclaration(k.id, k, badFields.get(k.id), importsOf(k, undefined)),
    );
  }

  for (const k of snap.kokostates) {
    const path = index.pathOf(k.id);
    if (path) kokoFiles.set(`${path}.d.ts`, k.id);
    if (path)
      files.set(
        `${path}.d.ts`,
        kokoStateDeclaration(k.id, k, badFields.get(k.id), importsOf(k, k.typeDefs)),
      );
  }

  for (const [alias, r] of packages) {
    paths[`@${alias}/*`] = [`${PACKAGES_DIR}/${alias}/*`];
    if (r.status !== "ready") continue;
    for (const e of r.manifest.exports) {
      const def = e.definition as Partial<KokoStateDef> | null;
      if (e.kind !== "kokostate" || typeof def?.name !== "string" || !Array.isArray(def.fields))
        continue;
      const id = packageResourceId(r.dependency, e.id);
      kokoFiles.set(packageFile(alias, e.path), id);
      const uses = Array.isArray(def.typeDefs)
        ? def.typeDefs.map((t) => packageResourceId(r.dependency, String(t)))
        : undefined;
      files.set(
        packageFile(alias, e.path),
        kokoStateDeclaration(
          id,
          {
            name: def.name,
            fields: def.fields,
            ...(typeof def.description === "string" ? { description: def.description } : {}),
          },
          badFields.get(id),
          importsOf({ fields: def.fields }, uses),
        ),
      );
    }
  }

  for (const s of snap.systems) {
    const path = `${index.pathOf(s.id) ?? `/${s.name}.system`}.ts`;
    files.set(path, s.code);
    systemFiles.set(s.id, path);
  }
  return { files, systemFiles, kokoFiles, paths };
}
