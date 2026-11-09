import {
  type Diagnostic,
  makeDiagnostic,
  type PackageResolution,
  type ProjectSnapshot,
} from "@tukurium/repo-model";
import ts from "typescript6";
import { HOST_FILE, virtualProject } from "./declarations";

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

/**
 * スクリプトの型を確かめる（ADR 0058）。TypeScript 6.0 の Language Service を、仮想のファイルの上で動かす。
 * 判定は厳しくする（strict）。型の誤りは「作っている途中の問題」で、再生は止めない（ADR 0010）。
 * 同じインスタンスを使い回すと、変わっていないファイルの解析を使い回せる。
 */
export class TypeChecker {
  private files = new Map<string, { text: string; version: number }>();
  private paths: Record<string, string[]> = {};
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

  /** 制作データを読み込み直す（中身の変わったファイルだけ版を上げる） */
  private load(input: TypeCheckInput): Map<string, string> {
    const v = virtualProject(input.snapshot, input.packages, input.hostDeclarations);
    const next = new Map<string, { text: string; version: number }>();
    for (const [path, text] of v.files) {
      const prev = this.files.get(path);
      next.set(
        path,
        prev && prev.text === text ? prev : { text, version: (prev?.version ?? 0) + 1 },
      );
    }
    this.files = next;
    this.paths = v.paths;
    return v.systemFiles;
  }

  check(input: TypeCheckInput): Diagnostic[] {
    const systemFiles = this.load(input);
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
