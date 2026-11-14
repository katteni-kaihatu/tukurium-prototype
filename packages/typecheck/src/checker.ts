import type { FieldSchemas, ValueSchema } from "@tukurium/eks";
import {
  type Diagnostic,
  makeDiagnostic,
  type PackageResolution,
  type ProjectSnapshot,
} from "@tukurium/repo-model";
import ts from "typescript6";
import {
  FIELDS_DIR,
  type FieldOwner,
  fieldOwners,
  HOST_FILE,
  kokoImports,
  kokoNames,
  kokoStateStub,
  type TypeDefFile,
  typeDefFiles,
  typeImports,
  virtualProject,
} from "./declarations";
import type { EditorDefinition, EditorLocation, EditorQuery, EditorResults } from "./editor";
import { fieldTypeSyntaxError, typeToSchema, UnsaveableType } from "./fieldSchema";

/** 型の誤りの担い手（問題の一覧の「出どころ」） */
export const TYPES_PROVIDER = "types";

export interface TypeCheckerOptions {
  /** TypeScript の標準ライブラリの宣言（`lib.es2022.d.ts` など）をファイル名から読む */
  readLib(fileName: string): string | undefined;
  /** 型の誤りの文を日本語にする（TypeScript の `lib/ja/diagnosticMessages.generated.json` の中身） */
  messages?: Record<string, string>;
}

export interface TypeCheckInput {
  snapshot: ProjectSnapshot;
  /** 依存の中身（別名ごと） */
  packages: ReadonlyMap<string, PackageResolution>;
  /** Host API の宣言（`hostApiDeclarations()`） */
  hostDeclarations: string;
  /** 確かめる System（省略すると全部） */
  systemIds?: readonly string[];
}

const LIB_PREFIX = "/__lib/";

export interface TypeCheckResult {
  /** スクリプトの型エラーと、フィールドの型の型エラー */
  diagnostics: Diagnostic[];
  /** フィールドのスキーマ（型エラーで作れなかったフィールドは入らない。ADR 0065） */
  schemas: FieldSchemas;
}

/** フィールドの型を確かめた結果 */
interface FieldCheck {
  schemas: FieldSchemas;
  diagnostics: Diagnostic[];
  /** 型エラーのあるフィールド（KokoState の ID → フィールドの ID） */
  bad: Map<string, Set<string>>;
}

/** フィールドの型を確かめるファイル 1 つ（KokoState 1 つ分） */
interface FieldFile {
  owner: FieldOwner;
  path: string;
  text: string;
  /** 文として読めたフィールドと、ファイルの中の範囲 */
  entries: { fieldId: string; start: number; end: number }[];
  /** 頭の、型の定義の import 文の長さ（ここで起きた型エラーは、使う型の定義の問題） */
  importsEnd: number;
}

/**
 * スクリプトの型を確かめる（ADR 0058）。TypeScript 6.0 の Language Service を、仮想のファイルの上で動かす。
 * 判定は厳しくする（strict）。型の誤りは「作っている途中の問題」で、再生は止めない（ADR 0010）。
 * 同じインスタンスを使い回すと、変わっていないファイルの解析を使い回せる。
 */
export class TypeChecker {
  private files = new Map<string, { text: string; version: number }>();
  private paths: Record<string, string[]> = {};
  /** System の ID → そのファイルのパス（最後に読み込んだ制作データのもの） */
  private systemFiles = new Map<string, string>();
  private codeFiles = new Map<string, string>();
  private definitions = new Map<string, { kind: "koko" | "code"; id: string }>();
  private readonly service: ts.LanguageService;

  constructor(private readonly options: TypeCheckerOptions) {
    // 日本語の文に差し替える。公開の型には無いが、TypeScript がもつ関数（ファイルを読まずに渡せる）
    const localize = (
      ts as unknown as { setLocalizedDiagnosticMessages?: (m: Record<string, string>) => void }
    ).setLocalizedDiagnosticMessages;
    if (options.messages && localize) localize(options.messages);
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...this.files.keys()],
      getScriptVersion: (f) => String(this.files.get(f)?.version ?? 0),
      getScriptSnapshot: (f) => {
        const text = this.read(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => "/",
      getCompilationSettings: () => this.settings(),
      getDefaultLibFileName: (o) => `${LIB_PREFIX}${ts.getDefaultLibFileName(o)}`,
      fileExists: (f) => this.read(f) !== undefined,
      readFile: (f) => this.read(f),
      directoryExists: (d) =>
        d === "/" ||
        [...this.files.keys()].some((f) => f.startsWith(d.endsWith("/") ? d : `${d}/`)),
      getDirectories: () => [],
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  private read(fileName: string): string | undefined {
    if (fileName.startsWith(LIB_PREFIX))
      return this.options.readLib(fileName.slice(LIB_PREFIX.length));
    return this.files.get(fileName)?.text;
  }

  private settings(): ts.CompilerOptions {
    return {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts"],
      types: [],
      paths: this.paths,
    };
  }

  /** 仮想のファイルを入れ替える（中身の変わったファイルだけ版を上げる） */
  private setFiles(files: ReadonlyMap<string, string>): void {
    const next = new Map<string, { text: string; version: number }>();
    for (const [path, text] of files) {
      const prev = this.files.get(path);
      next.set(
        path,
        prev && prev.text === text ? prev : { text, version: (prev?.version ?? 0) + 1 },
      );
    }
    this.files = next;
  }

  /**
   * 制作データを読み込み直す。先にフィールドの型を確かめ、型エラーのあるフィールドは、KokoState の宣言で
   * unknown にする（そのフィールドだけが使えなくなり、ほかのフィールドとスクリプトは確かめられる）。
   */
  private load(input: TypeCheckInput): FieldCheck {
    const typeDefs = typeDefFiles(input.snapshot, input.packages);
    const fieldFiles = this.fieldFiles(input, typeDefs);
    const fieldTexts = new Map(fieldFiles.map((f) => [f.path, f.text] as const));
    this.setFiles(
      new Map([
        [HOST_FILE, input.hostDeclarations],
        ...typeDefs.map((f) => [f.file, f.code] as const),
        // 型の文から名前で指す KokoState（`KokoStateRef<Health>`）の、仮の宣言
        ...kokoNames(input.snapshot, input.packages).map(
          (k) => [`${k.spec}.d.ts`, kokoStateStub(k.id)] as const,
        ),
        ...fieldTexts,
      ]),
    );
    const fields = this.checkFields(fieldFiles);
    fields.diagnostics.push(...this.checkTypeDefs(typeDefs));
    const v = virtualProject(input.snapshot, input.packages, input.hostDeclarations, fields.bad);
    this.setFiles(new Map([...v.files, ...fieldTexts]));
    this.paths = v.paths;
    this.systemFiles = v.systemFiles;
    this.codeFiles = new Map([...v.systemFiles, ...typeDefs.map((f) => [f.id, f.file] as const)]);
    this.definitions = new Map<string, { kind: "koko" | "code"; id: string }>([
      ...[...v.kokoFiles].map(([file, id]) => [file, { kind: "koko" as const, id }] as const),
      ...[...this.codeFiles].map(([id, file]) => [file, { kind: "code" as const, id }] as const),
    ]);
    return fields;
  }

  /** 制作データを読み込み、スクリプトごとの確認の準備をする。 */
  prepare(input: TypeCheckInput): TypeCheckResult {
    const fields = this.load(input);
    return { diagnostics: fields.diagnostics, schemas: fields.schemas };
  }

  /** 読み込み済みの System だけを確かめる。Worker はこの間に別の頼みを受け取れる。 */
  checkSystem(id: string): Diagnostic[] {
    return this.scripts({ systemIds: [id] });
  }

  private editorFile(location: EditorLocation): string | undefined {
    const file = this.codeFiles.get(location.fileId);
    if (!file || location.position < 0 || location.position > location.code.length) return;
    const previous = this.files.get(file);
    if (previous && previous.text !== location.code)
      this.files.set(file, { text: location.code, version: previous.version + 1 });
    return file;
  }

  private definition(file: string, position: number): EditorDefinition | null {
    for (const def of this.service.getDefinitionAtPosition(file, position) ?? []) {
      const target = this.definitions.get(def.fileName);
      const source = this.service.getProgram()?.getSourceFile(def.fileName);
      if (target && source)
        return {
          ...target,
          position: def.textSpan.start,
          line: source.getLineAndCharacterOfPosition(def.textSpan.start).line + 1,
        };
    }
    return null;
  }

  query<K extends EditorQuery["kind"]>(query: Extract<EditorQuery, { kind: K }>): EditorResults[K];
  query(query: EditorQuery): EditorResults[EditorQuery["kind"]];
  query(query: EditorQuery): EditorResults[EditorQuery["kind"]] {
    const file = this.editorFile(query);
    let result: EditorResults[EditorQuery["kind"]] = null;
    if (!file) return query.kind === "completions" ? [] : null;
    const position = query.position;
    switch (query.kind) {
      case "hover": {
        const info = this.service.getQuickInfoAtPosition(file, position);
        const diagnostics = [
          ...this.service.getSyntacticDiagnostics(file),
          ...this.service.getSemanticDiagnostics(file),
        ].filter(
          (d) =>
            d.start !== undefined && d.start <= position && position < d.start + (d.length ?? 1),
        );
        if (info || diagnostics.length)
          result = {
            from: info?.textSpan.start ?? position,
            to: info ? info.textSpan.start + info.textSpan.length : position + 1,
            display: ts.displayPartsToString(info?.displayParts),
            documentation: documentation(info),
            diagnostics: diagnostics.map((d) =>
              ts.flattenDiagnosticMessageText(d.messageText, "\n"),
            ),
            definition: this.definition(file, position),
          };
        break;
      }
      case "completions":
        result = (this.service.getCompletionsAtPosition(file, position, {})?.entries ?? []).map(
          (e) => ({
            name: e.name,
            kind: e.kind,
            sortText: e.sortText,
            ...(e.source ? { source: e.source } : {}),
            ...(e.insertText ? { insertText: e.insertText } : {}),
          }),
        );
        break;
      case "details": {
        const info = this.service.getCompletionEntryDetails(
          file,
          position,
          query.name,
          {},
          query.source,
          {},
          undefined,
        );
        result = info
          ? {
              display: ts.displayPartsToString(info.displayParts),
              documentation: documentation(info),
            }
          : null;
        break;
      }
      case "definition":
        result = this.definition(file, position);
        break;
    }
    return result;
  }

  /** フィールドの型の文を、KokoState ごとのファイルにする（文として読めないものは入れない） */
  private fieldFiles(input: TypeCheckInput, typeDefs: TypeDefFile[]): FieldFile[] {
    const byId = new Map(typeDefs.map((f) => [f.id, f] as const));
    const names = kokoNames(input.snapshot, input.packages);
    return fieldOwners(input.snapshot, input.packages).map((owner, i) => {
      // 使う型の定義が公開している型と、型の文に出てくる KokoState を、そのままの名前で使えるようにする
      const imports =
        typeImports(owner.typeDefs, byId) +
        kokoImports(
          owner.fields.map((f) => f.type),
          names,
        );
      const file: FieldFile = {
        owner,
        path: `${FIELDS_DIR}/${i}.ts`,
        text: imports,
        entries: [],
        importsEnd: imports.length,
      };
      for (const f of owner.fields) {
        if (typeof f.type !== "string" || fieldTypeSyntaxError(f.type) !== null) continue;
        const head = `export type F${file.entries.length} = (\n`;
        const start = file.text.length + head.length;
        file.text += `${head}${f.type}\n);\n`;
        file.entries.push({ fieldId: f.id, start, end: start + f.type.length });
      }
      if (file.entries.length === 0) file.text += "export {};\n";
      return file;
    });
  }

  private checkFields(files: FieldFile[]): FieldCheck {
    const out: FieldCheck = { schemas: {}, diagnostics: [], bad: new Map() };
    const program = this.service.getProgram();
    const checker = program?.getTypeChecker();
    const ctx = checker
      ? {
          checker,
          isLibFile: (fileName: string) => fileName.startsWith(LIB_PREFIX),
          isHostFile: (fileName: string) => fileName === HOST_FILE,
        }
      : null;
    for (const file of files) {
      const { owner } = file;
      const fail = (fieldId: string, code: string, message: string) => {
        const bad = out.bad.get(owner.id) ?? new Set<string>();
        bad.add(fieldId);
        out.bad.set(owner.id, bad);
        // 依存から取り込んだ KokoState の型エラーは、ライブラリの側で直すものなので出さない
        if (!owner.own) return;
        const field = owner.fields.find((f) => f.id === fieldId);
        out.diagnostics.push(
          makeDiagnostic({
            code,
            severity: "error",
            phase: "authoring",
            provider: TYPES_PROVIDER,
            subject: { kind: "kokostate", id: owner.id },
            location: { kind: "property", path: [fieldId, "type"] },
            related: [],
            message: `「${owner.name}」の ${field?.name ?? fieldId} の型：${message}`,
          }),
        );
      };
      const parsed = new Set(file.entries.map((e) => e.fieldId));
      for (const f of owner.fields) {
        if (parsed.has(f.id)) continue;
        const reason = typeof f.type === "string" ? fieldTypeSyntaxError(f.type) : "型がありません";
        fail(f.id, "field-type-syntax", reason ?? "型を読めません");
      }
      if (file.entries.length === 0 || !ctx) continue;
      const source = program?.getSourceFile(file.path);
      if (!source) continue;
      // 型の文の中の型エラー（知らない名前など）
      for (const d of this.service.getSemanticDiagnostics(file.path)) {
        // import 文の型エラー（二つの型の定義が同じ名前の型を公開している、など）
        if (d.start !== undefined && d.start < file.importsEnd) {
          if (owner.own)
            out.diagnostics.push(
              makeDiagnostic({
                code: `ts${d.code}`,
                severity: "error",
                phase: "authoring",
                provider: TYPES_PROVIDER,
                subject: { kind: "kokostate", id: owner.id },
                location: { kind: "property", path: ["typeDefs"] },
                related: [],
                message: `「${owner.name}」が使う型の定義：${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
              }),
            );
          continue;
        }
        const entry = file.entries.find(
          (e) => d.start !== undefined && d.start >= e.start && d.start <= e.end,
        );
        if (!entry || out.bad.get(owner.id)?.has(entry.fieldId)) continue;
        fail(entry.fieldId, `ts${d.code}`, ts.flattenDiagnosticMessageText(d.messageText, " "));
      }
      const aliases = source.statements.filter(ts.isTypeAliasDeclaration);
      const schemas: Record<string, ValueSchema> = {};
      file.entries.forEach((entry, i) => {
        const alias = aliases[i];
        if (!alias || out.bad.get(owner.id)?.has(entry.fieldId)) return;
        try {
          schemas[entry.fieldId] = typeToSchema(ctx, ctx.checker.getTypeFromTypeNode(alias.type));
        } catch (e) {
          if (!(e instanceof UnsaveableType)) throw e;
          fail(entry.fieldId, "field-type-unsaveable", e.message);
        }
      });
      out.schemas[owner.id] = schemas;
    }
    return out;
  }

  /**
   * 型の定義（ADR 0065）を確かめる：書けるのは `type` と `interface` だけ。公開している型は、保存できる型に限る。
   * 依存から取り込んだ型の定義の問題は、ライブラリの側で直すものなので出さない。
   */
  private checkTypeDefs(typeDefs: TypeDefFile[]): Diagnostic[] {
    const out: Diagnostic[] = [];
    const program = this.service.getProgram();
    const checker = program?.getTypeChecker();
    for (const def of typeDefs) {
      if (!def.own) continue;
      const source = program?.getSourceFile(def.file);
      if (!source || !checker) continue;
      const push = (code: string, start: number | undefined, message: string) => {
        const pos = start === undefined ? null : source.getLineAndCharacterOfPosition(start);
        out.push(
          makeDiagnostic({
            code,
            severity: "error",
            phase: "authoring",
            provider: TYPES_PROVIDER,
            subject: { kind: "typedef", id: def.id },
            location: {
              kind: "script",
              line: pos ? pos.line + 1 : null,
              ...(pos ? { column: pos.character + 1 } : {}),
              symbol: `${code}:${message.slice(0, 80)}`,
            },
            related: [],
            message,
          }),
        );
      };
      const found = [
        ...this.service.getSyntacticDiagnostics(def.file),
        ...this.service.getSemanticDiagnostics(def.file),
      ];
      for (const d of found)
        push(`ts${d.code}`, d.start, ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      const syntaxOk = this.service.getSyntacticDiagnostics(def.file).length === 0;
      const ctx = {
        checker,
        isLibFile: (fileName: string) => fileName.startsWith(LIB_PREFIX),
        isHostFile: (fileName: string) => fileName === HOST_FILE,
      };
      for (const s of source.statements) {
        if (ts.isImportDeclaration(s) || ts.isExportDeclaration(s) || ts.isEmptyStatement(s))
          continue;
        if (!ts.isTypeAliasDeclaration(s) && !ts.isInterfaceDeclaration(s)) {
          push(
            "typedef-unsupported",
            s.getStart(source),
            "型の定義には、type と interface だけを書けます（関数・変数・クラスなどは書けません）",
          );
          continue;
        }
        // 型の引数を持つ型は、使う所で形が決まるので、ここでは確かめない
        if (!syntaxOk || (s.typeParameters?.length ?? 0) > 0) continue;
        const exported = (ts.getModifiers(s) ?? []).some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (!exported) continue;
        // この型の中に、もう型エラー（知らない名前など）が出ているなら、重ねて出さない
        if (found.some((d) => d.start !== undefined && d.start >= s.pos && d.start < s.end))
          continue;
        try {
          typeToSchema(ctx, checker.getTypeAtLocation(s.name));
        } catch (e) {
          if (!(e instanceof UnsaveableType)) throw e;
          push("typedef-unsaveable", s.name.getStart(source), `${s.name.text}：${e.message}`);
        }
      }
    }
    return out;
  }

  /** スクリプトの型エラー・フィールドの型の型エラー・フィールドのスキーマを、まとめて作る */
  checkAll(input: TypeCheckInput): TypeCheckResult {
    const fields = this.load(input);
    return {
      diagnostics: [...fields.diagnostics, ...this.scripts(input)],
      schemas: fields.schemas,
    };
  }

  check(input: TypeCheckInput): Diagnostic[] {
    return this.checkAll(input).diagnostics;
  }

  /** フィールドのスキーマだけを作る（スクリプトは確かめない） */
  schemas(input: TypeCheckInput): FieldSchemas {
    return this.load(input).schemas;
  }

  /** 読み込んだあとの、スクリプトの型エラー */
  private scripts(input: Pick<TypeCheckInput, "systemIds">): Diagnostic[] {
    const systemFiles = this.systemFiles;
    const only = input.systemIds ? new Set(input.systemIds) : null;
    const out: Diagnostic[] = [];
    for (const [systemId, file] of systemFiles) {
      if (only && !only.has(systemId)) continue;
      const found = [
        ...this.service.getSyntacticDiagnostics(file),
        ...this.service.getSemanticDiagnostics(file),
      ];
      for (const d of found) {
        if (d.file && d.file.fileName !== file) continue;
        const pos =
          d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
        out.push(
          makeDiagnostic({
            code: `ts${d.code}`,
            severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
            phase: "authoring",
            provider: TYPES_PROVIDER,
            subject: { kind: "system", id: systemId },
            location: {
              kind: "script",
              line: pos ? pos.line + 1 : null,
              ...(pos ? { column: pos.character + 1 } : {}),
              // 同じ System の別の誤りを分ける（行番号は指紋に入れないので、文の頭で分ける）
              symbol: `ts${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 80)}`,
            },
            related: [],
            message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          }),
        );
      }
    }
    return out;
  }

  /** 宣言のファイル（Host API）だけを確かめる（宣言そのものの誤りを見つけるテスト用） */
  checkHost(input: TypeCheckInput): string[] {
    this.load(input);
    return this.service
      .getSemanticDiagnostics(HOST_FILE)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  }
}

function documentation(
  info: { documentation?: ts.SymbolDisplayPart[]; tags?: readonly ts.JSDocTagInfo[] } | undefined,
): string {
  return [
    ts.displayPartsToString(info?.documentation),
    ...(info?.tags ?? []).map((tag) => `@${tag.name} ${ts.displayPartsToString(tag.text)}`.trim()),
  ]
    .filter(Boolean)
    .join("\n");
}
