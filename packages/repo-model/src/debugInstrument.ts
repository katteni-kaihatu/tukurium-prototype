import { type Node, parse, type Token } from "acorn";

// コンパイラが型と import を処理したあとの JavaScript だけを受け取る。
type Tree = Node & {
  [key: string]: unknown;
  name?: string;
  kind?: string;
  body?: Tree | Tree[];
  params?: Tree[];
  id?: Tree;
  declarations?: Tree[];
  key?: Tree;
};
const node = (value: unknown): value is Tree =>
  value !== null && typeof value === "object" && "type" in value;
const children = (value: Tree): Tree[] =>
  Object.values(value).flatMap((v) => (node(v) ? [v] : Array.isArray(v) ? v.filter(node) : []));
const isFunction = (n: Tree) =>
  ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(n.type);

function bindings(n: Tree | undefined): string[] {
  if (!n) return [];
  if (n.type === "Identifier") return n.name ? [n.name] : [];
  if (n.type === "AssignmentPattern") return bindings(n.left as Tree);
  if (n.type === "Property") return bindings(n.value as Tree);
  return children(n).flatMap(bindings);
}

export interface DebugInstrumentation {
  javascript: string;
  lines: number[];
  /** スクリプトが同じ名前を宣言していても衝突しない別名。 */
  bridge: string;
}

/** 文の前と関数の出入りにフックを足す。改行は一つも足したり消したりしない。 */
export function instrumentDebug(source: string): DebugInstrumentation {
  const tokens: Token[] = [];
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
    onToken: tokens,
  }) as unknown as Tree;
  let bridge = "__tukuriumDebug";
  while (source.includes(bridge)) bridge += "_";
  const edits = new Map<number, { order: number; text: string }[]>();
  const replacements: { start: number; end: number; text: string }[] = [];
  const skipped = new Set<Tree>();
  const lines = new Set<number>();
  const add = (at: number, text: string, order = 0) => {
    const list = edits.get(at) ?? [];
    list.push({ order, text });
    edits.set(at, list);
  };
  type Scope = Map<string, boolean>;
  const declared = (body: Tree[], includeVar = true): Scope => {
    const result: Scope = new Map();
    for (const statement of body) {
      if (statement.type === "VariableDeclaration" && (includeVar || statement.kind !== "var"))
        for (const d of statement.declarations ?? [])
          for (const name of bindings(d.id)) result.set(name, statement.kind !== "const");
      if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration")
        for (const name of bindings(statement.id)) result.set(name, true);
    }
    return result;
  };
  const walk = (n: Tree, scopes: Scope[], frame: string | null, parent?: Tree) => {
    if (skipped.has(n)) return;
    if (isFunction(n)) {
      if (n.generator || n.async)
        throw new Error("デバッグ実行では async 関数・generator はまだ使えません");
      const body = n.body as Tree;
      const frameName = `${bridge}_frame_${n.start}`;
      const params: Scope = new Map((n.params ?? []).flatMap(bindings).map((name) => [name, true]));
      for (const param of n.params ?? []) walk(param, [...scopes, new Map(params)], null, n);
      // var はブロックを越えて関数全体に見える。
      const vars = (v: Tree) => {
        if (v !== n && isFunction(v)) return;
        if (v.type === "VariableDeclaration" && v.kind === "var")
          for (const d of v.declarations ?? [])
            for (const name of bindings(d.id)) params.set(name, true);
        for (const c of children(v)) vars(c);
      };
      vars(body);
      const name = n.id?.name ?? parent?.key?.name ?? parent?.id?.name ?? "無名関数";
      let hoisted = "";
      if (body.type === "BlockStatement") {
        const functions = new Map<string, Tree>();
        for (const s of body.body as Tree[])
          if (s.type === "FunctionDeclaration" && s.id?.name) {
            const earlier = functions.get(s.id.name);
            if (earlier) {
              skipped.add(earlier);
              replacements.push({
                start: earlier.start,
                end: earlier.end,
                text: source.slice(earlier.start, earlier.end).replace(/[^\r\n]/g, " "),
              });
            }
            functions.set(s.id.name, s);
          }
        // try の内側の関数宣言は lexical になる。同名の var は宣言を外へ出し、代入だけ残す。
        const normalize = (v: Tree, p?: Tree) => {
          if (isFunction(v)) return;
          if (
            v.type === "VariableDeclaration" &&
            v.kind === "var" &&
            (v.declarations ?? []).some((d) => bindings(d.id).some((b) => functions.has(b)))
          ) {
            for (const d of v.declarations ?? [])
              for (const b of bindings(d.id)) if (!functions.has(b)) hoisted += `var ${b};`;
            replacements.push({ start: v.start, end: v.start + 3, text: "   " });
            if (!p?.type.startsWith("For") || p.type === "ForStatement") {
              add(v.start + 3, "(");
              const end = source[v.end - 1] === ";" ? v.end - 1 : v.end;
              add(end, ")");
              for (const d of v.declarations ?? [])
                if (!d.init)
                  replacements.push({
                    start: d.start,
                    end: d.end,
                    text: `void 0${source.slice(d.start, d.end).replace(/[^\r\n]/g, " ")}`,
                  });
            }
          }
          for (const c of children(v)) normalize(c, v);
        };
        normalize(body);
      }
      const entry = `;${hoisted}const ${frameName}=${bridge}.enter(${JSON.stringify(name)},${n.loc?.start.line ?? 1});try{`;
      const end = `}catch(${frameName}_error){${bridge}.error(${frameName},${frameName}_error);throw ${frameName}_error;}finally{${bridge}.leave(${frameName});}`;
      if (body.type === "BlockStatement") {
        // use strict などの directive は関数の先頭のままにする。
        const statements = body.body as Tree[];
        const directives = statements.filter((s) => typeof s.directive === "string");
        const start = directives.at(-1)?.end ?? body.start + 1;
        add(start, entry, -100);
        add(body.end - 1, end, 100);
        walk(body, [...scopes, params], frameName, n);
      } else {
        // Acorn は式を囲む括弧を body の範囲に含めない。矢印の直後から包む。
        const start = tokens
          .filter((t) => t.type.label === "=>" && t.start >= n.start && t.end <= body.start)
          .at(-1)?.end;
        if (start === undefined) throw new Error("矢印関数の位置を読み取れません");
        add(start, `{${entry}`, -100);
        const scopesIn = [...scopes, params];
        point(body, scopesIn, frameName, start);
        add(start, "return (", 10);
        walk(body, scopesIn, frameName, n);
        add(n.end, `);${end}}`, 100);
      }
      return;
    }
    let current = scopes;
    if (n.type === "Program" || n.type === "BlockStatement")
      current = [...scopes, declared(n.body as Tree[])];
    if (n.type === "CatchClause")
      current = [...scopes, new Map(bindings(n.param as Tree).map((name) => [name, true]))];
    if (n.type === "SwitchStatement")
      current = [...scopes, declared((n.cases as Tree[]).flatMap((c) => c.consequent as Tree[]))];
    // for の宣言はループの中からだけ見える。
    if (["ForStatement", "ForOfStatement", "ForInStatement"].includes(n.type)) {
      const declaration = (n.init ?? n.left) as Tree | undefined;
      if (declaration?.type === "VariableDeclaration")
        current = [...current, declared([declaration])];
    }
    if (frame && parent && eligible(n, parent)) {
      const single =
        !Array.isArray(parent.body) && parent.body === n && n.type !== "BlockStatement";
      // if/else と label の直下も、フックと元の文を一つのブロックにする。
      const branch =
        parent.consequent === n || parent.alternate === n || parent.type === "LabeledStatement";
      if (single || branch) {
        add(n.start, "{", -20);
        add(n.end, "}", 20);
      }
      point(n, scopes, frame);
    }
    for (const c of children(n)) walk(c, current, frame, n);
  };
  function point(n: Tree, scopes: Scope[], frame: string, at = n.start) {
    const line = n.loc?.start.line ?? 1;
    lines.add(line);
    const visible = new Map(scopes.flatMap((scope) => [...scope]));
    const reads = [...visible].map(
      ([name, writable]) => `[${JSON.stringify(name)},${bridge}.read(()=>${name}),${writable}]`,
    );
    const writes = [...visible]
      .filter(([, writable]) => writable)
      .map(([name]) => `case ${JSON.stringify(name)}:${name}=${bridge}_value;break;`);
    add(
      at,
      `${bridge}.point(${frame},${line},()=>[${reads.join(",")}],(${bridge}_name,${bridge}_value)=>{switch(${bridge}_name){${writes.join("")}}});`,
    );
  }
  walk(ast, [], null);
  let javascript = source;
  const changes = [...replacements];
  for (const [at, list] of edits) {
    const text = list
      .sort((a, b) => a.order - b.order)
      .map((e) => e.text)
      .join("");
    changes.push({ start: at, end: at, text });
  }
  for (const change of changes.sort((a, b) => b.start - a.start || b.end - a.end)) {
    javascript = javascript.slice(0, change.start) + change.text + javascript.slice(change.end);
  }
  return {
    javascript: `const ${bridge}=globalThis.__debugBridge;${javascript}`,
    lines: [...lines].sort((a, b) => a - b),
    bridge,
  };
}

function eligible(n: Tree, parent: Tree): boolean {
  // ラベルとループの間にブロックを置くと continue label が使えなくなる。
  if (parent.type === "LabeledStatement") return false;
  if (typeof n.directive === "string") return false;
  if (
    ["BlockStatement", "EmptyStatement", "FunctionDeclaration", "ClassDeclaration"].includes(n.type)
  )
    return false;
  if (n.type === "VariableDeclaration" && parent.type.startsWith("For")) return false;
  return n.type.endsWith("Statement") || n.type === "VariableDeclaration";
}
