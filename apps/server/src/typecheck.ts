import type { FieldSchemas } from "@tukurium/eks";
import type { PackageResolution, ProjectSnapshot } from "@tukurium/repo-model";
import { hostApiDeclarations } from "@tukurium/runtime";
import { TypeChecker } from "@tukurium/typecheck";
import { nodeTypeCheckerOptions } from "@tukurium/typecheck/node";

/**
 * サーバーで型を確かめる（ADR 0058・0065）。TypeScript の本体は重いので、初めて使うときに作り、使い回す。
 * エージェントの確認（check）と、フィールドのスキーマを作るのに使う。
 */
let checker: TypeChecker | null = null;

export const HOST_DECLARATIONS = hostApiDeclarations();

export function sharedTypeChecker(): TypeChecker {
  checker ??= new TypeChecker(nodeTypeCheckerOptions());
  return checker;
}

/** 依存の中身を、別名から引ける形にする（型の確かめは、別名で import を結び付ける） */
export function packagesByAlias(
  packages: readonly PackageResolution[] | undefined,
): Map<string, PackageResolution> {
  return new Map((packages ?? []).map((r) => [r.dependency.alias, r]));
}

/**
 * 制作データのフィールドのスキーマを作る。作れなかったとき（制作データが壊れているなど）は空を返す
 * （スキーマがないフィールドは、型の文から分かる分だけで確かめる）。
 */
export function fieldSchemasOf(
  snapshot: ProjectSnapshot,
  packages: ReadonlyMap<string, PackageResolution>,
): FieldSchemas {
  try {
    return sharedTypeChecker().schemas({
      snapshot,
      packages,
      hostDeclarations: HOST_DECLARATIONS,
    });
  } catch {
    return {};
  }
}
