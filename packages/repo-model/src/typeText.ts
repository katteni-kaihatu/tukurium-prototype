/**
 * フィールドの型の文（TypeScript の型の書き方。ADR 0065）の中の、型の名前を書き換える。
 * KokoState の名前を変えたときに、その KokoState を型の文で指している所
 * （`KokoStateRef<Health>` の `Health`）を、新しい名前に合わせるのに使う。
 *
 * TypeScript の本体を使わずに、文字をたどって書き換える（制作データの書き換えは、TypeScript を
 * 読み込んでいない所でも起きるため）。次のものは書き換えない。
 * - 文字のリテラル（`"Health"`）とコメントの中
 * - プロパティの名前（`{ Health: number }` の `Health`、`a.Health` の `Health`）
 */
export function renameTypeName(text: string, from: string, to: string): string {
  if (from === to || from === "" || !text.includes(from)) return text;
  const isWord = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    // 文字のリテラル：閉じる引用符まで、そのまま写す
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // コメント
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      const j = end < 0 ? text.length : end;
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const j = end < 0 ? text.length : end + 2;
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (isWord(c) && !/\d/.test(c)) {
      let j = i + 1;
      while (isWord(text[j])) j++;
      const word = text.slice(i, j);
      const head = out.trimEnd();
      const before = head.at(-1);
      // プロパティの名前：前が「{」「;」「,」「[」か readonly で、後ろが「:」か「?:」
      // （条件の型 `A ? Health : B` の `Health` は、前が「?」なので当たらない）
      const key =
        (before === undefined || "{;,[".includes(before) || /\breadonly$/.test(head)) &&
        /^\s*\??\s*:/.test(text.slice(j));
      out += word === from && before !== "." && !key ? to : word;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
