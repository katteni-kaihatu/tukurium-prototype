import { type Expression, type ImportDeclaration, parse } from "acorn";
import { type Diagnostic, makeDiagnostic } from "./diagnostics/types";
import { BUILTIN_PREFIX, ResourcePathIndex } from "./resourcePath";
import type { ProjectSnapshot } from "./schema";

/**
 * System スクリプトのコンパイル（ADR 0010 §3、計画 Phase 4）。
 *
 * `import Gun from "../States/Gun.koko";` を AST で読み取り、論理パスを安定 ID に解決して、
 * `const Gun = __koko("<ID>", "<名前>");` に書き換える。QuickJS には書き換えた JS を渡す。
 * - 書き換えは import 文の範囲だけ。行の数を保つので、実行時のエラーの行番号はそのまま使える。
 * - 正規表現での読み取りや書き換えはしない。
 * - 結び付けの表（bindings）は派生データで、保存しない。
 */

export interface SystemBinding {
  /** System の中での名前（import のローカル名） */
  alias: string;
  kind: "kokostate";
  /** 書かれたパス */
  spelling: string;
  /** 解決した安定 ID */
  resourceId: string;
  /** 解決した KokoState の表示名（移行の間、実行時に名前でも引けるように渡す） */
  name: string;
  /** import が書かれた行 */
  line: number;
  /** パスの文字列（引用符を含む）がソースのどこにあるか [始め, 終わり) */
  range: [number, number];
}

export interface CompiledSystem {
  /** 読み込んでよいか（import に問題があれば false） */
  ok: boolean;
  javascript: string;
  bindings: SystemBinding[];
  diagnostics: Diagnostic[];
}

const KOKO_EXT = ".koko";

export function compileSystem(
  systemId: string,
  source: string,
  index: ResourcePathIndex,
): CompiledSystem {
  let imports: ImportDeclaration[];
  try {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
    imports = ast.body.filter((n): n is ImportDeclaration => n.type === "ImportDeclaration");
  } catch {
    // 構文の誤りは、QuickJS が読み込むときに行番号つきで知らせる
    return { ok: true, javascript: source, bindings: [], diagnostics: [] };
  }
  if (imports.length === 0) return { ok: true, javascript: source, bindings: [], diagnostics: [] };

  const bindings: SystemBinding[] = [];
  const diagnostics: Diagnostic[] = [];
  const problem = (code: string, line: number, spelling: string, message: string) =>
    diagnostics.push(
      makeDiagnostic({
        code,
        severity: "error",
        phase: "authoring",
        provider: "script",
        subject: { kind: "system", id: systemId },
        location: { kind: "script", line, symbol: spelling },
        related: [],
        message,
      }),
    );

  let out = "";
  let at = 0;
  for (const node of imports) {
    const line = node.loc?.start.line ?? 1;
    const spelling = String(node.source.value);
    const spec = node.specifiers;
    let replacement = "";
    const only = spec.length === 1 ? spec[0] : undefined;
    if (!spelling.endsWith(KOKO_EXT)) {
      problem(
        "import-unsupported",
        line,
        spelling,
        `import できるのは KokoState（.koko）だけです：${spelling}`,
      );
    } else if (only?.type !== "ImportDefaultSpecifier") {
      problem(
        "import-unsupported",
        line,
        spelling,
        `KokoState は「import 名前 from "${spelling}"」の形で読み込みます`,
      );
    } else {
      const r = index.resolve(spelling, systemId);
      if (r.ok && r.kind === "kokostate") {
        const name = index.nameOf(r.id) ?? r.id;
        bindings.push({
          alias: only.local.name,
          kind: "kokostate",
          spelling,
          resourceId: r.id,
          name,
          line,
          range: [node.source.start, node.source.end],
        });
        replacement = `const ${only.local.name} = __koko(${JSON.stringify(r.id)}, ${JSON.stringify(name)});`;
      } else if (!r.ok && r.reason === "ambiguous") {
        problem(
          "import-ambiguous",
          line,
          spelling,
          `「${spelling}」に当てはまるものが複数あります（同じ場所で名前がぶつかっています）`,
        );
      } else {
        problem("import-unresolved", line, spelling, `KokoState「${spelling}」が見つかりません`);
      }
    }
    // 行の数を保つ：元の範囲にあった改行を足す
    const original = source.slice(node.start, node.end);
    out +=
      source.slice(at, node.start) + replacement + "\n".repeat(original.split("\n").length - 1);
    at = node.end;
  }
  out += source.slice(at);
  return { ok: diagnostics.length === 0, javascript: out, bindings, diagnostics };
}

export interface QueryItem {
  /** KokoState の表示名 */
  name: string;
  /** 解決できた KokoState の ID（解決できなければ null） */
  id: string | null;
}

/**
 * System の Query を AST で読み取る（表示・Entity との照合用）。
 * import した名前（`with: [Gun]`）は結び付けた ID に、移行の間の文字列の名前
 * （`with: ["Gun"]`）は表示名がちょうど一つ当てはまる KokoState の ID に読み替える。
 * 実際に使われる Query は、実行時にスクリプトを評価して決まる。
 */
export function readSystemQuery(
  systemId: string,
  source: string,
  index: ResourcePathIndex,
): { with: QueryItem[]; without: QueryItem[] } {
  const empty = { with: [], without: [] };
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return empty;
  }
  const exported = ast.body.find((n) => n.type === "ExportDefaultDeclaration");
  if (exported?.type !== "ExportDefaultDeclaration") return empty;
  const decl = exported.declaration;
  const def =
    decl.type === "CallExpression" && decl.arguments[0]?.type === "ObjectExpression"
      ? decl.arguments[0]
      : decl;
  if (def.type !== "ObjectExpression") return empty;
  const prop = (obj: Expression, key: string): Expression | null => {
    if (obj.type !== "ObjectExpression") return null;
    for (const p of obj.properties) {
      if (p.type !== "Property") continue;
      const k =
        p.key.type === "Identifier"
          ? p.key.name
          : p.key.type === "Literal"
            ? String(p.key.value)
            : null;
      if (k === key) return p.value as Expression;
    }
    return null;
  };
  const query = prop(def, "query");
  if (!query) return empty;
  const aliases = new Map(
    compileSystem(systemId, source, index).bindings.map((b) => [b.alias, b] as const),
  );
  const list = (key: string): QueryItem[] => {
    const arr = prop(query, key);
    if (arr?.type !== "ArrayExpression") return [];
    const out: QueryItem[] = [];
    for (const el of arr.elements) {
      if (el?.type === "Literal" && typeof el.value === "string")
        out.push({ name: el.value, id: index.kokoIdByName(el.value) });
      else if (el?.type === "Identifier") {
        const b = aliases.get(el.name);
        out.push(b ? { name: b.name, id: b.resourceId } : { name: el.name, id: null });
      }
    }
    return out;
  };
  return { with: list("with"), without: list("without") };
}

/** import のパスの書き直し（Y.Text のこの範囲を text に置き換える） */
export interface ImportEdit {
  systemId: string;
  start: number;
  end: number;
  /** 引用符を含む新しいパス */
  text: string;
}

/**
 * 名前の変更・移動の前後の制作データを比べ、import のパスの書き直しを求める（ADR 0010 §3）。
 * 前の構造で結び付いていた ID を基準にし、今の構造でその ID を指す書き方に直す。
 * - 相対パスは相対パス、いちばん上からのパスはいちばん上からのまま。Built-in はそのまま。
 * - 今の構造でも同じ ID に解決できる import、前から解決できない import、
 *   指していたものが消えた import には手を付けない（勝手に別のものへ付け替えない）。
 * - 書き換えるのはパスの文字列の範囲だけ（正規表現や文字列の置換は使わない）。
 */
export function planImportRefactor(prev: ProjectSnapshot, next: ProjectSnapshot): ImportEdit[] {
  const edits: ImportEdit[] = [];
  let before: ResourcePathIndex | null = null;
  let after: ResourcePathIndex | null = null;
  for (const s of next.systems) {
    if (!s.code.includes("import")) continue;
    before ??= ResourcePathIndex.fromSnapshot(prev);
    after ??= ResourcePathIndex.fromSnapshot(next);
    for (const b of compileSystem(s.id, s.code, before).bindings) {
      if (b.spelling.startsWith(BUILTIN_PREFIX)) continue;
      const now = after.resolve(b.spelling, s.id);
      if (now.ok && now.id === b.resourceId) continue;
      if (!after.entry(b.resourceId)) continue;
      const spelling = after.spellingFor(
        b.resourceId,
        s.id,
        b.spelling.startsWith("/") ? "absolute" : "relative",
      );
      if (spelling === null || spelling === b.spelling) continue;
      edits.push({
        systemId: s.id,
        start: b.range[0],
        end: b.range[1],
        text: JSON.stringify(spelling),
      });
    }
  }
  return edits;
}
