import { type Expression, parse } from "acorn";

export type DebugExpression = unknown[];

/** 呼び出し・代入を含まない式だけを、VM と共有できる木にする。 */
export function compileDebugExpression(source: string): DebugExpression {
  if (source.length > 2000) throw new Error("式は2000文字以内にしてください");
  const program = parse(`(${source}\n)`, { ecmaVersion: "latest" });
  const statement = program.body[0];
  if (program.body.length !== 1 || statement?.type !== "ExpressionStatement")
    throw new Error("式を一つだけ書いてください");
  const walk = (n: Expression, depth = 0): DebugExpression => {
    if (depth > 32) throw new Error("式が深すぎます");
    const child = (v: Expression) => walk(v, depth + 1);
    switch (n.type) {
      case "Literal":
        if (n.regex || n.bigint) throw new Error("このリテラルは使えません");
        return ["literal", n.value];
      case "Identifier":
        return ["name", n.name];
      case "MemberExpression":
        return [
          "member",
          child(n.object as Expression),
          n.computed
            ? child(n.property as Expression)
            : ["literal", n.property.type === "Identifier" ? n.property.name : ""],
          Boolean(n.optional),
        ];
      case "ChainExpression":
        return ["chain", child(n.expression)];
      case "UnaryExpression":
        if (!["!", "+", "-", "~", "typeof", "void"].includes(n.operator)) break;
        return ["unary", n.operator, child(n.argument)];
      case "BinaryExpression":
        if (
          ![
            "+",
            "-",
            "*",
            "/",
            "%",
            "**",
            "===",
            "!==",
            "==",
            "!=",
            "<",
            "<=",
            ">",
            ">=",
            "&",
            "|",
            "^",
            "<<",
            ">>",
            ">>>",
          ].includes(n.operator)
        )
          break;
        return ["binary", n.operator, child(n.left as Expression), child(n.right)];
      case "LogicalExpression":
        return ["logical", n.operator, child(n.left), child(n.right)];
      case "ConditionalExpression":
        return ["conditional", child(n.test), child(n.consequent), child(n.alternate)];
      case "ArrayExpression":
        return [
          "array",
          ...n.elements.map((e) => (e ? child(e as Expression) : ["name", "undefined"])),
        ];
    }
    throw new Error("式では、値の参照と計算だけが使えます。代入や関数呼び出しはできません");
  };
  return walk(statement.expression);
}
