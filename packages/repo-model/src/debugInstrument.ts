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
export function instrumentDebug(source: string, systemId?: string): DebugInstrumentation {
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
  const scopeOwner = new WeakMap<Scope, string | null>();
  const scopeKeys = new WeakMap<Scope, Map<string, string>>();
  let nextBinding = 0;
  const binding = (scope: Scope, name: string) => {
    let ids = scopeKeys.get(scope);
    if (!ids) {
      ids = new Map();
      scopeKeys.set(scope, ids);
    }
    let id = ids.get(name);
    if (!id) {
      id = `${systemId ?? ""}:binding:${++nextBinding}`;
      ids.set(name, id);
    }
    const owner = scopeOwner.get(scope);
    return owner ? `${bridge}.binding?.(${JSON.stringify(id)},()=>(${owner}))` : JSON.stringify(id);
  };
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
  const walk = (
    n: Tree,
    scopes: Scope[],
    frame: string | null,
    parent?: Tree,
    inChain = false,
    inPattern = false,
  ) => {
    if (skipped.has(n)) return;
    if (isFunction(n)) {
      if (n.generator || n.async)
        throw new Error("デバッグ実行では async 関数・generator はまだ使えません");
      const body = n.body as Tree;
      const frameName = `${bridge}_frame_${n.start}`;
      const params: Scope = new Map((n.params ?? []).flatMap(bindings).map((name) => [name, true]));
      const complexParams = (n.params ?? []).some((p) => p.type !== "Identifier");
      const containsFunction = (node: Tree): boolean =>
        isFunction(node) || children(node).some(containsFunction);
      const parameterClosures = (n.params ?? []).some(containsFunction);
      let parameterOwner = `${frameName}.id`;
      if (complexParams && parameterClosures) {
        if (n.type !== "ArrowFunctionExpression") parameterOwner = `${bridge}.scopeFor(arguments)`;
        else {
          const rest = (n.params ?? []).find((p) => p.type === "RestElement");
          if (rest)
            throw new Error(
              "デバッグ実行では、矢印関数の既定引数内の関数と rest 引数の併用はできません。通常の function にすると使えます。",
            );
          let argsName: string | undefined;
          if (!argsName) {
            argsName = `${bridge}_args_${n.start}`;
            const arrow = tokens
              .filter((t) => t.type.label === "=>" && t.start >= n.start && t.end <= body.start)
              .at(-1);
            const close = tokens
              .filter(
                (t) =>
                  t.type.label === ")" && t.start >= n.start && t.end <= (arrow?.start ?? n.start),
              )
              .at(-1);
            if (!close) throw new Error("引数の位置を読み取れません");
            const previous = tokens
              .filter((t) => t.end <= close.start && t.start >= n.start)
              .at(-1);
            add(
              close.start,
              `${(n.params?.length ?? 0) > 0 && previous?.type.label !== "," ? "," : ""}...${argsName}`,
            );
          }
          parameterOwner = `${bridge}.scopeFor(${argsName})`;
        }
      }
      scopeOwner.set(params, parameterOwner);
      for (const name of params.keys()) binding(params, name);
      const defaults = new Map(params);
      scopeOwner.set(defaults, parameterOwner);
      scopeKeys.set(defaults, scopeKeys.get(params) as Map<string, string>);
      for (const param of n.params ?? []) walk(param, [...scopes, defaults], null, n);
      // 非単純引数では、body の var と既定値の引数環境は別の束縛になる。
      const bodyVars: Scope = complexParams ? new Map() : params;
      if (complexParams) scopeOwner.set(bodyVars, `${frameName}.id`);
      // var はブロックを越えて関数全体に見える。
      const vars = (v: Tree) => {
        if (v !== n && isFunction(v)) return;
        if (v.type === "VariableDeclaration" && v.kind === "var")
          for (const d of v.declarations ?? [])
            for (const name of bindings(d.id)) bodyVars.set(name, true);
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
      const entry = `;${hoisted}const ${frameName}=${bridge}.enter(${JSON.stringify(name)},${n.loc?.start.line ?? 1},${JSON.stringify(systemId) ?? "undefined"});try{`;
      const end = `}catch(${frameName}_error){${bridge}.error(${frameName},${frameName}_error);throw ${frameName}_error;}finally{${bridge}.leave(${frameName});}`;
      if (body.type === "BlockStatement") {
        // use strict などの directive は関数の先頭のままにする。
        const statements = body.body as Tree[];
        const directives = statements.filter((s) => typeof s.directive === "string");
        const start = directives.at(-1)?.end ?? body.start + 1;
        add(start, entry, -100);
        add(body.end - 1, end, 100);
        walk(body, [...scopes, params, bodyVars], frameName, n);
      } else {
        // Acorn は式を囲む括弧を body の範囲に含めない。矢印の直後から包む。
        const start = tokens
          .filter((t) => t.type.label === "=>" && t.start >= n.start && t.end <= body.start)
          .at(-1)?.end;
        if (start === undefined) throw new Error("矢印関数の位置を読み取れません");
        add(start, `{${entry}`, -100);
        const scopesIn = [...scopes, params];
        point(body, scopesIn, frameName, start);
        add(start, "return (", 1);
        walk(body, scopesIn, frameName, n);
        add(n.end, `);${end}}`, 100);
      }
      return;
    }
    let current = scopes;
    let loopBodyScopes: Scope[] | undefined;
    if (n.type === "Program" || n.type === "BlockStatement") {
      const block = declared(n.body as Tree[], n.type === "Program");
      if (frame && block.size > 0 && !isFunction(parent as Tree)) {
        const token = `${bridge}_scope_${n.start}`;
        add(n.start + 1, `const ${token}=${bridge}.scope();`, -90);
        scopeOwner.set(block, token);
      } else scopeOwner.set(block, frame ? `${frame}.id` : null);
      current = [...scopes, block];
    }
    if (n.type === "CatchClause") {
      const scope: Scope = new Map(bindings(n.param as Tree).map((name) => [name, true]));
      const token = `${bridge}_catch_${n.start}`;
      if (frame) add((n.body as Tree).start + 1, `const ${token}=${bridge}.scope();`, -90);
      scopeOwner.set(scope, frame ? token : null);
      current = [...scopes, scope];
    }
    if (n.type === "SwitchStatement") {
      const scope = declared(
        (n.cases as Tree[]).flatMap((c) => c.consequent as Tree[]),
        false,
      );
      const token = `${bridge}_switch_${n.start}`;
      if (frame) {
        add(n.start, `{const ${token}=${bridge}.scope();`, -30);
        add(n.end, "}", 30);
      }
      scopeOwner.set(scope, frame ? token : null);
      current = [...scopes, scope];
    }
    // for の宣言はループの中からだけ見える。
    if (["ForStatement", "ForOfStatement", "ForInStatement"].includes(n.type)) {
      const declaration = (n.init ?? n.left) as Tree | undefined;
      if (declaration?.type === "VariableDeclaration" && declaration.kind !== "var") {
        const loop = declared([declaration]);
        if (frame && n.type === "ForStatement" && declaration.kind === "let") {
          const token = `${bridge}_loop_${n.start}`;
          add(declaration.start + 3, ` ${token}=${bridge}.scope(),`);
          const update = n.update as Tree | null;
          if (update) {
            add(update.start, `(${token}=${bridge}.scope(),`);
            add(update.end, ")");
          } else {
            const close = tokens
              .filter(
                (t) =>
                  t.type.label === ")" && t.start < (n.body as Tree).start && t.start > n.start,
              )
              .at(-1);
            if (close) add(close.start, `${token}=${bridge}.scope()`);
          }
          scopeOwner.set(loop, token);
        } else if (frame && n.type !== "ForStatement") {
          const token = `${bridge}_loop_${n.start}`;
          const body = n.body as Tree;
          // for-of/in の各周回の束縛は、その本体の中で識別する。
          if (body.type === "BlockStatement")
            add(body.start + 1, `const ${token}=${bridge}.scope();`, -90);
          else {
            add(body.start, `{const ${token}=${bridge}.scope();`, -30);
            add(body.end, "}", 30);
          }
          const bodyLoop = new Map(loop);
          for (const name of loop.keys()) binding(loop, name);
          scopeKeys.set(bodyLoop, scopeKeys.get(loop) as Map<string, string>);
          scopeOwner.set(bodyLoop, token);
          scopeOwner.set(loop, `${frame}.id`);
          // 本体以外（iterable など）では、本体の token はまだ存在しない。
          loopBodyScopes = [...scopes, bodyLoop];
        } else scopeOwner.set(loop, frame ? `${frame}.id` : null);
        current = [...current, loop];
      }
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
    if (frame && n.type === "TryStatement") {
      const block = n.block as Tree;
      const errorName = `${bridge}_caught_${n.start}`;
      add(block.start + 1, "try{", -80);
      add(
        block.end - 1,
        `}catch(${errorName}){${bridge}.error(${frame},${errorName});throw ${errorName};}`,
        80,
      );
      if (n.handler && n.finalizer) {
        const finalizer = n.finalizer as Tree;
        const keyword = tokens.find(
          (t) =>
            t.type.label === "finally" &&
            t.start >= (n.handler as Tree).end &&
            t.end <= finalizer.start,
        );
        if (keyword) {
          add(n.start, "try{", -40);
          add(
            keyword.start,
            `}catch(${errorName}_outer){${bridge}.error(${frame},${errorName}_outer);throw ${errorName}_outer;}`,
            -40,
          );
        }
      }
    }
    if (frame && parent) {
      if (
        n.type === "MemberExpression" &&
        !inPattern &&
        !inChain &&
        !(parent.type === "TaggedTemplateExpression" && parent.tag === n) &&
        !(
          (parent.type === "CallExpression" || parent.type === "NewExpression") &&
          parent.callee === n
        ) &&
        !(parent.type === "AssignmentExpression" && parent.left === n) &&
        !(
          (parent.type === "ForOfStatement" || parent.type === "ForInStatement") &&
          parent.left === n
        ) &&
        !(parent.type === "UpdateExpression" && parent.argument === n) &&
        !(parent.type === "UnaryExpression" && parent.operator === "delete")
      ) {
        add(
          n.start,
          `${bridge}.protect(${frame},${(n.property as Tree)?.loc?.start.line ?? n.loc?.start.line ?? 1},()=> (`,
          4 - n.end / (source.length + 1),
        );
        add(n.end, "))", -4);
      }
      if (parent.type === "ThrowStatement" && parent.argument === n) {
        add(
          n.start,
          `${bridge}.raise(${frame},${n.loc?.start.line ?? 1},${bridge}.protect(${frame},${n.loc?.start.line ?? 1},()=> (`,
          2.5,
        );
        add(n.end, ")))", -4);
      }
    }
    if (
      frame &&
      ([
        "AssignmentExpression",
        "UpdateExpression",
        "CallExpression",
        "NewExpression",
        "TaggedTemplateExpression",
        "ChainExpression",
      ].includes(n.type) ||
        (n.type === "UnaryExpression" && n.operator === "delete")) &&
      !(inChain && n.type === "CallExpression") &&
      (n.callee as Tree | undefined)?.type !== "Super"
    ) {
      add(
        n.start,
        `${bridge}.changed(${frame},${n.loc?.start.line ?? 1},()=> (`,
        4 - n.end / (source.length + 1),
      );
      add(n.end, "))", -5);
    }
    if (frame && (n.type === "ForOfStatement" || n.type === "ForInStatement")) {
      const body = n.body as Tree;
      add(
        body.type === "BlockStatement" ? body.start + 1 : body.start,
        `${bridge}.changed(${frame},${n.loc?.start.line ?? 1},()=>{});`,
        body.type === "BlockStatement" ? -80 : -10,
      );
    }
    for (const c of children(n))
      walk(
        c,
        c === n.body && loopBodyScopes ? loopBodyScopes : current,
        frame,
        n,
        n.type === "ChainExpression" ||
          (inChain &&
            ((n.type === "MemberExpression" && c === n.object) ||
              (n.type === "CallExpression" && c === n.callee))),
        inPattern ||
          ["ObjectPattern", "ArrayPattern", "RestElement"].includes(n.type) ||
          (n.type === "AssignmentPattern" && c === n.left),
      );
  };
  function point(n: Tree, scopes: Scope[], frame: string, at = n.start) {
    const line = n.loc?.start.line ?? 1;
    lines.add(line);
    const visible = new Map(
      scopes.flatMap((scope) =>
        [...scope].map(
          ([name, writable]) => [name, { writable, binding: binding(scope, name) }] as const,
        ),
      ),
    );
    const reads = [...visible].map(
      ([name, info]) =>
        `[${JSON.stringify(name)},${bridge}.read(()=>${name}),${info.writable},${info.binding}]`,
    );
    const writes = [...visible]
      .filter(([, info]) => info.writable)
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
