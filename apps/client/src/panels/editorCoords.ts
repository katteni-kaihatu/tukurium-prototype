/**
 * 3D のパネルは CSS の立体変形で置いている。画面上の矩形（getBoundingClientRect）は
 * 回転でゆがんだ外接矩形になり、コードエディタはその矩形でカーソル位置と行の高さを
 * 計算する。斜めから見ると、カーソルが文字からずれ、行番号も行と揃わない。
 *
 * エディタの中は、変形を含まない配置（offset）の矩形を返す。マウスの位置も、
 * ブラウザが当たり判定した文字の位置へ置き換える。
 *
 * エディタの外にあるスクロール枠（パネルの中身など）まで画面上の矩形のままだと、
 * 配置の座標と交差しすぎて、見える範囲が欠けたり空になったりする。スクロールすると
 * 別の行が出たり消えたりする。エディタを含む枠には、配置の原点を覆う矩形を返す。
 * パネルの入れ物そのもの（data-mode）は、ピン留めや大きさの計算に使うのでそのまま。
 * 2D のパネルもそのまま。
 */

const rewritten = new WeakSet<Event>();
const widthCache = new Map<string, number>();
let probe: HTMLSpanElement | null = null;

/** 変形していない要素で、ブラウザと同じ文字幅を測る */
function widthOf(style: CSSStyleDeclaration, text: string): number {
  if (!text || typeof document === "undefined") return 0;
  const key = `${style.font}\0${style.letterSpacing}\0${style.tabSize}\0${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  if (!probe) {
    probe = document.createElement("span");
    probe.style.cssText =
      "position:absolute;left:0;top:0;visibility:hidden;white-space:pre;pointer-events:none;";
    document.body.appendChild(probe);
  }
  probe.style.font = style.font;
  probe.style.letterSpacing = style.letterSpacing;
  probe.style.tabSize = style.tabSize;
  probe.textContent = text;
  const w = probe.getBoundingClientRect().width;
  widthCache.set(key, w);
  return w;
}

function in3dEditor(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement;
  const editor = el?.closest<HTMLElement>(".cm-editor");
  if (!editor?.closest("[data-mode='3d']")) return null;
  return editor;
}

function scrollerOf(editor: HTMLElement): HTMLElement | null {
  return editor.querySelector(".cm-scroller");
}

/**
 * 3D パネルの中で、エディタを包んでいる要素。
 * 画面上の位置ではなく、エディタの表示範囲（スクロール枠）を配置の座標で返す。
 */
function editorCover(el: HTMLElement): DOMRect | null {
  if (in3dEditor(el)) return null;
  const host = el.closest<HTMLElement>("[data-mode='3d']");
  if (!host || el === host) return null;
  const editor = el.querySelector(".cm-editor");
  if (!(editor instanceof HTMLElement)) return null;
  const scroller = scrollerOf(editor);
  if (!scroller) return null;
  return new DOMRect(0, 0, Math.max(scroller.clientWidth, 1), Math.max(scroller.clientHeight, 1));
}

/** スクロール後の、エディタの左上を原点にした矩形 */
function layoutBox(el: HTMLElement): DOMRect {
  const editor = in3dEditor(el);
  const scroller = editor && scrollerOf(editor);
  if (!editor || !scroller) return el.getBoundingClientRect();
  // tooltip は scroller の兄弟。エディタ本体と兄弟も、scroller と同じ原点で測る。
  if (el === editor)
    return new DOMRect(-scroller.offsetLeft, -scroller.offsetTop, el.offsetWidth, el.offsetHeight);
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n && n !== scroller && n !== editor) {
    x += n.offsetLeft;
    y += n.offsetTop;
    const next: HTMLElement | null = n.offsetParent instanceof HTMLElement ? n.offsetParent : null;
    if (!next || next === n) break;
    if (next === editor) {
      x -= scroller.offsetLeft;
      y -= scroller.offsetTop;
      break;
    }
    if (next !== scroller && !editor.contains(next)) break;
    n = next;
  }
  let s: HTMLElement | null = el.parentElement;
  while (s && s !== editor && editor.contains(s)) {
    x -= s.scrollLeft;
    y -= s.scrollTop;
    s = s.parentElement;
  }
  // offsetHeight は小数を切り捨てるので、行ごとに足すと行番号が少しずつずれる。
  // 次の行までの距離を高さにすると、並びがそのまま残る。
  let height = el.offsetHeight;
  const next = el.nextElementSibling;
  if (
    el.classList.contains("cm-line") &&
    next instanceof HTMLElement &&
    next.classList.contains("cm-line") &&
    next.offsetTop >= el.offsetTop
  ) {
    height = next.offsetTop - el.offsetTop;
  }
  return new DOMRect(x, y, el.offsetWidth, height);
}

function textIndex(line: HTMLElement, node: Node, offset: number): number {
  if (node === line) return 0;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let count = 0;
  let cur = walker.nextNode();
  while (cur) {
    if (cur === node) return count + offset;
    count += cur.textContent?.length ?? 0;
    cur = walker.nextNode();
  }
  return count;
}

function styledWidth(line: HTMLElement, from: number, to: number): number {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let count = 0;
  let width = 0;
  let cur = walker.nextNode();
  while (cur && count < to) {
    const text = cur.textContent ?? "";
    const next = count + text.length;
    const a = Math.max(0, from - count);
    const b = Math.min(text.length, to - count);
    if (b > a) {
      const parent = cur.parentElement;
      if (parent) width += widthOf(getComputedStyle(parent), text.slice(a, b));
    }
    count = next;
    cur = walker.nextNode();
  }
  return width;
}

function rangeRect(range: Range): DOMRect | null {
  const node = range.startContainer;
  const raw = node instanceof Element ? node : node.parentElement;
  const el = raw instanceof HTMLElement ? raw : null;
  if (!el || !in3dEditor(el)) return null;
  const line = el.closest<HTMLElement>(".cm-line");
  if (!line) return layoutBox(el);
  const base = layoutBox(line);
  const cs = getComputedStyle(line);
  const padL = Number.parseFloat(cs.paddingLeft) || 0;
  const start = node instanceof Text ? textIndex(line, node, range.startOffset) : 0;
  const end =
    range.endContainer instanceof Text
      ? textIndex(line, range.endContainer, range.endOffset)
      : start + 1;
  const from = Math.min(start, end);
  const to = Math.max(from + 1, Math.max(start, end));
  const left = base.left + padL + styledWidth(line, 0, from);
  const width = Math.max(1, styledWidth(line, from, to) || 8);
  return new DOMRect(left, base.top, width, base.height || 18);
}

function caretAt(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const caret = doc.caretPositionFromPoint?.(x, y);
  if (!caret) return null;
  const range = document.createRange();
  range.setStart(caret.offsetNode, caret.offset);
  range.collapse(true);
  return range;
}

function layoutPoint(e: MouseEvent): { x: number; y: number } | null {
  const caret = caretAt(e.clientX, e.clientY);
  if (caret && in3dEditor(caret.startContainer)) {
    const rect = rangeRect(caret);
    if (rect) return { x: rect.left + Math.min(rect.width, 4) / 2, y: rect.top + rect.height / 2 };
  }
  const target = e.target;
  const raw =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const el = raw instanceof HTMLElement ? raw : null;
  if (!el || !in3dEditor(el)) return null;
  const box = layoutBox(el);
  return { x: box.left + e.offsetX, y: box.top + e.offsetY };
}

function rewrite(e: Event): void {
  if (!(e instanceof MouseEvent) || rewritten.has(e)) return;
  // 候補やホバー内のボタンは文字位置に置き換えない。
  if (e.target instanceof Element && e.target.closest(".cm-tooltip")) return;
  if (e.type !== "mousemove" && e.button !== 0) return;
  const point = layoutPoint(e);
  if (!point) return;
  const dest =
    e.target instanceof Element
      ? e.target
      : e.target instanceof Node
        ? e.target.parentElement
        : null;
  if (!dest) return;
  e.stopPropagation();
  e.preventDefault();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button: e.button,
    buttons: e.buttons,
    detail: e.detail,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  };
  const next =
    e instanceof PointerEvent
      ? new PointerEvent(e.type, {
          ...init,
          pointerId: e.pointerId,
          pointerType: e.pointerType || "mouse",
        })
      : new MouseEvent(e.type, init);
  rewritten.add(next);
  dest.dispatchEvent(next);
}

let installed = false;

/** 3D パネル内のコードエディタで、カーソルと行番号が文字に揃うようにする */
export function installFlatEditorCoords(): void {
  if (installed || typeof document === "undefined") return;
  const flag = "__tukuriumEditorCoords";
  const w = window as unknown as Record<string, boolean>;
  if (w[flag]) return;
  w[flag] = true;
  installed = true;

  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (this instanceof HTMLElement) {
      if (in3dEditor(this) && (this.offsetWidth > 0 || this.offsetHeight > 0)) {
        return layoutBox(this);
      }
      const cover = editorCover(this);
      if (cover) return cover;
    }
    return rect.call(this);
  };

  const rects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function () {
    if (this instanceof HTMLElement && (in3dEditor(this) || editorCover(this))) {
      return [this.getBoundingClientRect()] as unknown as DOMRectList;
    }
    return rects.call(this);
  };

  const rangeRects = Range.prototype.getClientRects;
  Range.prototype.getClientRects = function () {
    const mapped = rangeRect(this);
    if (!mapped) return rangeRects.call(this);
    return [mapped] as unknown as DOMRectList;
  };

  const rangeBox = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = function () {
    return rangeRect(this) ?? rangeBox.call(this);
  };

  // pointerdown を止めると、ブラウザが mousedown を出さなくなる。
  // コードエディタは mousedown でカーソルを置く。
  for (const type of ["mousedown", "mousemove", "mouseup"]) {
    document.addEventListener(type, rewrite, true);
  }
}
