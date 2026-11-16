import ts from "typescript6";
import { describe, expect, it } from "vitest";
import { nodeTypeCheckerOptions } from "./node";

/**
 * プレハブ型・インスタンス型の書き方を、tsc で確かめる（ロードマップの「プレハブを型で扱ってコードから
 * インスタンスを作る」の P0。ADR 0082）。Host の宣言とプレハブごとの宣言に入れる前に、型の決まりだけを見る。
 */
const HOST = `
type EntityRef = string & { readonly __tukurium: "EntityRef" };
type PrefabType<B, P, I> = string & {
  readonly __tukurium: "Prefab";
  readonly __prefab: B;
  readonly __create: (params: P) => I;
};
type PrefabInstance<B> = EntityRef & { readonly __instance: B };
type InstanceOf<T> = T extends PrefabType<any, any, infer I> ? I : never;
type PrefabParamsOf<T> = T extends PrefabType<any, infer P, any> ? P : never;
type PrefabSpawnArgs<T> = {} extends PrefabParamsOf<T>
  ? [params?: PrefabParamsOf<T>]
  : [params: PrefabParamsOf<T>];
declare const Prefab: {
  spawn<T extends PrefabType<any, any, any>>(
    prefab: T,
    ...params: PrefabSpawnArgs<T>
  ): InstanceOf<T> | undefined;
  destroy(instance: PrefabInstance<{}>): boolean;
};
declare const world: { getState(entity: EntityRef, koko: string): unknown };

// 駒（必須：Speed、省略できる：Damage）
type KomaBrand = { id_koma: true };
declare const Koma: PrefabType<KomaBrand, { Speed: number; Damage?: number }, PrefabInstance<KomaBrand>>;
type Koma = typeof Koma;
// 赤い駒：駒のバリアント。省略できるパラメータ Glow を足した
type AkaBrand = { id_koma: true; id_aka: true };
declare const Aka: PrefabType<
  AkaBrand,
  { Speed: number; Damage?: number; Glow?: boolean },
  PrefabInstance<AkaBrand>
>;
// 王の駒：駒のバリアント。必須のパラメータ Rank を足した
type OuBrand = { id_koma: true; id_ou: true };
declare const Ou: PrefabType<
  OuBrand,
  { Speed: number; Damage?: number; Rank: number },
  PrefabInstance<OuBrand>
>;
// 駒と同じ構造の、別のプレハブ
type BetsuBrand = { id_betsu: true };
declare const Betsu: PrefabType<
  BetsuBrand,
  { Speed: number; Damage?: number },
  PrefabInstance<BetsuBrand>
>;
// パラメータのないプレハブ（空のオブジェクトの型は何でも受けてしまうので、どの名前も渡せない形にする）
type IshiBrand = { id_ishi: true };
declare const Ishi: PrefabType<IshiBrand, { [name: string]: never }, PrefabInstance<IshiBrand>>;
declare const entity: EntityRef;
`;

const options = nodeTypeCheckerOptions();

/** 本文を型で確かめて、型エラーの文を返す */
function errors(body: string): string[] {
  const files = new Map([
    ["/host.d.ts", HOST],
    ["/main.ts", `${body}\nexport {};\n`],
  ]);
  const read = (name: string) =>
    files.get(name) ?? (name.startsWith("/lib.") ? options.readLib(name.slice(1)) : undefined);
  const host: ts.CompilerHost = {
    fileExists: (name) => read(name) !== undefined,
    readFile: read,
    getSourceFile: (name, version) => {
      const text = read(name);
      return text === undefined ? undefined : ts.createSourceFile(name, text, version);
    },
    getDefaultLibFileName: () => "/lib.es2022.d.ts",
    getDefaultLibLocation: () => "/",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram({
    rootNames: ["/host.d.ts", "/main.ts"],
    options: {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts"],
      types: [],
    },
    host,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("プレハブ型・インスタンス型の書き方", () => {
  it("宣言そのものに誤りがない", () => {
    expect(errors("")).toEqual([]);
  });

  it("プレハブ型：そのプレハブと、パラメータの合うバリアントは当てはまる", () => {
    expect(errors("const a: Koma = Koma; const b: Koma = Aka;")).toEqual([]);
  });

  it("プレハブ型：必須のパラメータを足したバリアントは当てはまらない", () => {
    expect(errors("const a: Koma = Ou;")).toHaveLength(1);
  });

  it("プレハブ型：同じ構造の別のプレハブは当てはまらない", () => {
    expect(errors("const a: Koma = Betsu;")).toHaveLength(1);
  });

  it("プレハブ型：ただの文字は当てはまらない", () => {
    expect(errors('const a: Koma = "id_koma";')).toHaveLength(1);
  });

  it("インスタンス型：バリアントのインスタンスは、いつも元のインスタンス型に当てはまる", () => {
    expect(
      errors(
        [
          "declare const aka: InstanceOf<typeof Aka>;",
          "declare const ou: InstanceOf<typeof Ou>;",
          "const a: InstanceOf<Koma> = aka;",
          "const b: InstanceOf<Koma> = ou;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("インスタンス型：別のプレハブのインスタンスと、元のプレハブのインスタンスは当てはまらない", () => {
    expect(
      errors(
        [
          "declare const betsu: InstanceOf<typeof Betsu>;",
          "declare const koma: InstanceOf<Koma>;",
          "const a: InstanceOf<Koma> = betsu;",
          "const b: InstanceOf<typeof Aka> = koma;",
        ].join("\n"),
      ),
    ).toHaveLength(2);
  });

  it("インスタンスは Entity の参照として、今の Host API に渡せる", () => {
    expect(
      errors('const b = Prefab.spawn(Koma, { Speed: 1 }); if (b) world.getState(b, "X");'),
    ).toEqual([]);
  });

  it("Prefab.spawn：必須を渡し、省略できるものは渡しても渡さなくてもよい", () => {
    expect(
      errors(
        [
          "Prefab.spawn(Koma, { Speed: 20 });",
          "Prefab.spawn(Koma, { Speed: 20, Damage: 5 });",
          "Prefab.spawn(Aka, { Speed: 20, Glow: true });",
          "Prefab.spawn(Ishi);",
          "Prefab.spawn(Ishi, {});",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("Prefab.spawn：必須が足りない・パラメータを渡さない", () => {
    expect(errors("Prefab.spawn(Koma, { Damage: 5 });")).toHaveLength(1);
    expect(errors("Prefab.spawn(Koma, {});")).toHaveLength(1);
    expect(errors("Prefab.spawn(Koma);")).toHaveLength(1);
  });

  it("Prefab.spawn：ないパラメータ・型の合わない値", () => {
    expect(errors("Prefab.spawn(Koma, { Speed: 20, Nai: 1 });")).toHaveLength(1);
    expect(errors('Prefab.spawn(Koma, { Speed: "速い" });')).toHaveLength(1);
    expect(errors("Prefab.spawn(Ishi, { Nai: 1 });")).toHaveLength(1);
  });

  it("Prefab.spawn：戻り値は、確かめずには使えない（作れないと undefined）", () => {
    expect(errors("const b: InstanceOf<Koma> = Prefab.spawn(Koma, { Speed: 1 });")).toHaveLength(1);
    expect(
      errors(
        "const b = Prefab.spawn(Koma, { Speed: 1 }); if (b) { const c: InstanceOf<Koma> = b; }",
      ),
    ).toEqual([]);
  });

  it("Prefab.spawn：プレハブ型の値（フィールドの値など）から作ると、その型のインスタンスになる", () => {
    expect(
      errors(
        [
          "declare const held: Koma | undefined;",
          "if (held) {",
          "  const b = Prefab.spawn(held, { Speed: 1 });",
          "  if (b) { const c: InstanceOf<Koma> = b; }",
          "}",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("Prefab.destroy：作ったインスタンスは渡せ、ふつうの Entity の参照は渡せない", () => {
    expect(errors("const b = Prefab.spawn(Aka, { Speed: 1 }); if (b) Prefab.destroy(b);")).toEqual(
      [],
    );
    expect(errors("Prefab.destroy(entity);")).toHaveLength(1);
    expect(errors('Prefab.destroy("rt:1");')).toHaveLength(1);
  });
});
