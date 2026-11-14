/** 自己完結させ、同じ関数を VM にも渡す。利用者の getter や型変換は呼ばない。 */
export function evaluateDebugExpression(tree: unknown[], values: Record<string, unknown>): unknown {
  const shortCircuit = Symbol();
  const ops = {
    // biome-ignore lint/suspicious/noExplicitAny: 演算子ごとのJavaScriptのプリミティブ変換を再現する。
    primitive(v: any): any {
      if ((typeof v === "object" && v !== null) || typeof v === "function" || typeof v === "symbol")
        throw new Error("オブジェクトを暗黙に変換する計算はできません");
      return v;
    },
    // biome-ignore lint/suspicious/noExplicitAny: 検証済みの式の木をVMでも同じ関数で評価する。
    visit(n: any): any {
      switch (n[0]) {
        case "literal":
          return n[1];
        case "name": {
          if (Object.hasOwn(values, n[1])) return values[n[1]];
          if (n[1] === "undefined") return undefined;
          if (n[1] === "NaN") return NaN;
          if (n[1] === "Infinity") return Infinity;
          throw new Error(`変数「${n[1]}」はこの位置では読めません`);
        }
        case "member": {
          const object = ops.visit(n[1]);
          if (object === shortCircuit || (n[3] && object == null)) return shortCircuit;
          if (object == null) throw new Error("値がないためフィールドを読めません");
          const key = ops.primitive(ops.visit(n[2]));
          if (typeof key !== "string" && typeof key !== "number")
            throw new Error("フィールド名を指定してください");
          if (["__proto__", "prototype", "constructor"].includes(String(key)))
            throw new Error("このフィールドは読めません");
          const field = Object.getOwnPropertyDescriptor(Object(object), key);
          if (field?.get || field?.set) throw new Error("getter は呼び出しません");
          if (field) return field.value;
          if (key === "size" && object instanceof Map)
            return Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get?.call(object);
          if (key === "size" && object instanceof Set)
            return Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get?.call(object);
          return undefined;
        }
        case "chain": {
          const value = ops.visit(n[1]);
          return value === shortCircuit ? undefined : value;
        }
        case "unary": {
          const v = ops.visit(n[2]);
          switch (n[1]) {
            case "!":
              return !v;
            case "typeof":
              return typeof v;
            case "void":
              return undefined;
            case "+":
              return +ops.primitive(v);
            case "-":
              return -ops.primitive(v);
            case "~":
              return ~ops.primitive(v);
          }
          break;
        }
        case "logical": {
          const a = ops.visit(n[2]);
          return n[1] === "&&"
            ? a && ops.visit(n[3])
            : n[1] === "||"
              ? a || ops.visit(n[3])
              : (a ?? ops.visit(n[3]));
        }
        case "conditional":
          return ops.visit(n[1]) ? ops.visit(n[2]) : ops.visit(n[3]);
        case "array":
          return n.slice(1).map((item: unknown[]) => ops.visit(item));
        case "binary": {
          let a = ops.visit(n[2]);
          let b = ops.visit(n[3]);
          if (a !== null && b !== null && typeof a === "object" && typeof b === "object")
            throw new Error(
              "オブジェクト同士の同一性は比較できません。フィールドの値を比較してください",
            );
          if (n[1] === "===") return a === b;
          if (n[1] === "!==") return a !== b;
          a = ops.primitive(a);
          b = ops.primitive(b);
          switch (n[1]) {
            case "+":
              return a + b;
            case "-":
              return a - b;
            case "*":
              return a * b;
            case "/":
              return a / b;
            case "%":
              return a % b;
            case "**":
              return a ** b;
            case "==":
              // biome-ignore lint/suspicious/noDoubleEquals: 利用者が指定した演算子。両辺はプリミティブに限定済み。
              return a == b;
            case "!=":
              // biome-ignore lint/suspicious/noDoubleEquals: 利用者が指定した演算子。両辺はプリミティブに限定済み。
              return a != b;
            case "<":
              return a < b;
            case "<=":
              return a <= b;
            case ">":
              return a > b;
            case ">=":
              return a >= b;
            case "&":
              return a & b;
            case "|":
              return a | b;
            case "^":
              return a ^ b;
            case "<<":
              return a << b;
            case ">>":
              return a >> b;
            case ">>>":
              return a >>> b;
          }
          break;
        }
      }
      throw new Error("式を読み取れません");
    },
  };
  return ops.visit(tree);
}
