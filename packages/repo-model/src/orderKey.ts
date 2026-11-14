/**
 * 並べ替え用のキー（間に入れられる文字。ADR 0065）。
 * 並びを「キーの小さい順」で持つと、2 つのキーの間に、ほかを書き換えずに新しいキーを作れる。
 * 共同編集で 2 人が同時に足したり動かしたりしても、それぞれが自分のフィールドのキーだけを書くので、
 * 並びが壊れない。同じキーになったときは、ID の順で並べる。
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0] as string;

/** a と b の間のキー（a < b。a は ""（いちばん前）、b は null（いちばん後ろ）でもよい） */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // 頭の同じ部分は、そのまま使う
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0] as string) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0] as string) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))] as string;
  // 隣り合う文字のあいだ：b が 2 文字以上なら、その頭の 1 文字が間に入る
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[digitA] as string) + midpoint(a.slice(1), null);
}

const valid = (key: string | null | undefined): key is string =>
  typeof key === "string" && key !== "" && !key.endsWith(ZERO) && /^[0-9A-Za-z]+$/.test(key);

/** before と after の間のキー（null は、その側の端） */
export function orderKeyBetween(before: string | null, after: string | null): string {
  const a = valid(before) ? before : "";
  const b = valid(after) && after > a ? after : null;
  return midpoint(a, b);
}

/**
 * 並べたい順のキー（まだないものは undefined）から、その順になるキーの並びを作る。
 * いまのキーのうち、すでに小さい順になっているもの（いちばん長い並び）はそのまま使い、
 * 残り（足したもの・動かしたもの）にだけ、間のキーを作る。
 */
export function assignOrderKeys(current: readonly (string | undefined)[]): string[] {
  const n = current.length;
  // いちばん長い、小さい順の並び（そのまま使うキー）
  const length = new Array<number>(n).fill(0);
  const prev = new Array<number>(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    const key = current[i];
    if (!valid(key)) continue;
    length[i] = 1;
    for (let j = 0; j < i; j++) {
      const other = current[j];
      if (valid(other) && other < key && (length[j] as number) + 1 > (length[i] as number)) {
        length[i] = (length[j] as number) + 1;
        prev[i] = j;
      }
    }
    if (best < 0 || (length[i] as number) > (length[best] as number)) best = i;
  }
  const keep = new Set<number>();
  for (let i = best; i >= 0; i = prev[i] as number) keep.add(i);

  const out: string[] = [];
  let last: string | null = null;
  for (let i = 0; i < n; i++) {
    if (keep.has(i)) {
      last = current[i] as string;
      out.push(last);
      continue;
    }
    let next: string | null = null;
    for (let j = i + 1; j < n; j++) {
      if (keep.has(j)) {
        next = current[j] as string;
        break;
      }
    }
    last = orderKeyBetween(last, next);
    out.push(last);
  }
  return out;
}
