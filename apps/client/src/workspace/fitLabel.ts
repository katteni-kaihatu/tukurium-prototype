/** 欄の名前の、縮める前の文字の大きさ */
export const LABEL_FONT_MAX = 12;
/** これより小さくすると読めないので、ここまで */
const LABEL_FONT_MIN = 4;

/**
 * 最大の文字サイズではみ出すときの、枠に収まる大きさ。
 * 収まるときは null（CSS の大きさのまま）。
 */
export function labelFontSize(scrollWidth: number, clientWidth: number): number | null {
  if (!(clientWidth > 0) || !(scrollWidth > 0)) return null;
  if (scrollWidth <= clientWidth + 0.5) return null;
  return Math.max(LABEL_FONT_MIN, (LABEL_FONT_MAX * clientWidth) / scrollWidth);
}

function px(size: number): string {
  return `${Math.round(size * 10) / 10}px`;
}

/** 名前を、枠の幅に全部入るまで小さくする。入りきるときは CSS の大きさに戻す */
export function fitLabelElement(el: HTMLElement): void {
  el.dataset.fit = "1";
  const client = el.clientWidth;
  if (!(client > 0)) return;
  // いまの大きさから、最大サイズのときの文字幅を戻して測る（一度 12px に戻すと高さが揺れる）
  const current = Number.parseFloat(el.style.fontSize) || LABEL_FONT_MAX;
  const scrollAtMax = (el.scrollWidth * LABEL_FONT_MAX) / current;
  const size = labelFontSize(scrollAtMax, client);
  const next = size == null ? "" : px(size);
  if (el.style.fontSize !== next) el.style.fontSize = next;
  // 端数でまだはみ出すときだけ、いまの幅からもう一段下げる
  if (size != null && el.scrollWidth > client + 0.5) {
    const fixed = Math.max(LABEL_FONT_MIN, (size * client) / el.scrollWidth);
    const again = px(fixed);
    if (el.style.fontSize !== again) el.style.fontSize = again;
  }
}
