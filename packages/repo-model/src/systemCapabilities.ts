import { parse } from "acorn";
import { type Diagnostic, makeDiagnostic } from "./diagnostics/types";
import { stripTypes } from "./typescriptStrip";

/**
 * System のコードから、要る Capability を読み取る（ADR 0012。利用者は宣言を書かない）。
 * 読み取った一覧が、その System の「宣言」になり、セッションではこれを置いた物への付与と
 * World の上限で絞って強制する。動的な呼び方（world[name]() など）は読み取れないので問題にする。
 */

/** Capability の ID。`名前空間.操作` で、意味を変えるときは version を上げる */
export type CapabilityId =
  | "time.read"
  | "audio.play"
  | "effects.spawn"
  | "physics.raycast"
  | "interaction.send"
  | "entity.discover"
  | "state.read"
  | "state.write"
  | "entity.spawn"
  | "entity.destroy"
  | "bag.read"
  | "bag.write";

/** Host API（名前空間.関数名）→ 要る Capability。runtime の HOST_API_POLICY と一致させる（テストで検査） */
export const HOST_CAPABILITIES: Record<string, CapabilityId> = {
  "time.now": "time.read",
  "audio.play": "audio.play",
  "world.raycast": "physics.raycast",
  "world.emit": "interaction.send",
  "world.find": "entity.discover",
  "world.get": "state.read",
  "world.set": "state.write",
  "world.spawn": "entity.spawn",
  "world.destroy": "entity.destroy",
  "contract.send": "interaction.send",
  "effects.spawn": "effects.spawn",
  "bag.add": "bag.write",
  "bag.take": "bag.write",
  "bag.count": "bag.read",
  "bag.list": "bag.read",
};

/** Host API の名前空間 */
const HOST_NAMESPACES = new Set(Object.keys(HOST_CAPABILITIES).map((k) => k.split(".")[0]));

/** Raycast の結果（hit）のメソッド → 要る Capability */
const HIT_METHODS: Record<string, CapabilityId> = {
  send: "interaction.send",
  effect: "effects.spawn",
};

interface AstNode {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

const isNode = (v: unknown): v is AstNode =>
  v !== null && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";

export interface InferredCapabilities {
  /** 要る Capability（並べ替え済み） */
  capabilities: CapabilityId[];
  diagnostics: Diagnostic[];
}

export function inferCapabilities(systemId: string, source: string): InferredCapabilities {
  // スクリプトは TypeScript。型を消してから読む（行の数は変わらない。ADR 0058）
  const stripped = stripTypes(source);
  if (!stripped.ok) return { capabilities: [], diagnostics: [] };
  let ast: AstNode;
  try {
    ast = parse(stripped.javascript, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    }) as never;
  } catch {
    return { capabilities: [], diagnostics: [] };
  }
  const caps = new Set<CapabilityId>();
  const diagnostics: Diagnostic[] = [];
  const dynamic = (node: AstNode, ns: string) =>
    diagnostics.push(
      makeDiagnostic({
        code: "dynamic-host-access",
        severity: "warning",
        phase: "authoring",
        provider: "script",
        subject: { kind: "system", id: systemId },
        location: { kind: "script", line: node.loc?.start.line ?? null, symbol: ns },
        related: [],
        message: `「${ns}」の使い方から、要る権限を読み取れません（${ns}.関数名(...) の形で呼んでください）。セッションでは拒まれることがあります`,
      }),
    );

  const visit = (node: AstNode, parent: AstNode | null, key: string | null) => {
    if (node.type === "MemberExpression") {
      const obj = node.object as AstNode;
      const prop = node.property as AstNode;
      if (obj.type === "Identifier" && HOST_NAMESPACES.has(obj.name as string)) {
        const ns = obj.name as string;
        if (!node.computed && prop.type === "Identifier") {
          const cap = HOST_CAPABILITIES[`${ns}.${prop.name as string}`];
          if (cap) caps.add(cap);
        } else dynamic(node, ns);
        // 名前空間そのものは見終わったので、object の Identifier は見ない
        if (node.computed) visit(prop, node, "property");
        return;
      }
    }
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      if (callee.type === "MemberExpression" && !callee.computed) {
        const prop = callee.property as AstNode;
        const obj = callee.object as AstNode;
        const isHostNs = obj.type === "Identifier" && HOST_NAMESPACES.has(obj.name as string);
        const cap = prop.type === "Identifier" ? HIT_METHODS[prop.name as string] : undefined;
        if (cap && !isHostNs) caps.add(cap);
      }
    }
    if (
      node.type === "Identifier" &&
      HOST_NAMESPACES.has(node.name as string) &&
      parent &&
      !(parent.type === "MemberExpression" && key === "property" && !parent.computed) &&
      !(parent.type === "Property" && key === "key" && !parent.computed)
    ) {
      // const w = world; f(world) など、名前空間をそのまま渡すと読み取れない
      dynamic(node, node.name as string);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "loc") continue;
      if (Array.isArray(v)) for (const c of v) isNode(c) && visit(c, node, k);
      else if (isNode(v)) visit(v, node, k);
    }
  };
  visit(ast, null, null);
  return { capabilities: [...caps].sort(), diagnostics };
}
