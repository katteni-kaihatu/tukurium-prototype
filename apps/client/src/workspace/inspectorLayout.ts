/** 詳細の既定の固定幅。パネルを広げた分は階層へ回す */
export const DETAILS_DEFAULT = 380;
/** ドラッグで狭くできる下限。3つの数値が読めるところまで */
export const DETAILS_MIN = 340;
export const DETAILS_MAX = 840;
/** 詳細を広げても、階層の名前が読める幅は残す */
export const HIERARCHY_MIN = 148;

/** 380px のときの名前の幅。数値 3 つが読める分は残す */
const LABEL_AT_DEFAULT = 104;
const LABEL_FLOOR = 64;
const LABEL_MAX = 200;
/** 詳細が既定より広い分のうち、名前へ回す割合 */
const LABEL_GROWTH = 0.45;
/** 名前以外（枠・印・維持・3つの入力）が要る幅。これ以上は名前に回さない */
const BESIDES_LABEL = 274;

const WIDTH_KEY = "tukurium.inspector.detailsWidth";

export function detailsWidthBounds(containerWidth: number): { min: number; max: number } {
  if (!(containerWidth > 0)) return { min: DETAILS_MIN, max: DETAILS_MAX };
  const max = Math.min(DETAILS_MAX, Math.max(180, containerWidth - HIERARCHY_MIN));
  const min = Math.min(DETAILS_MIN, max);
  return { min: Math.round(min), max: Math.round(max) };
}

/** 覚えた幅を、いまのパネルの中に収める */
export function clampDetailsWidth(preferred: number, containerWidth: number): number {
  const { min, max } = detailsWidthBounds(containerWidth);
  const n = Number.isFinite(preferred) ? preferred : DETAILS_DEFAULT;
  return Math.round(Math.min(max, Math.max(min, n)));
}

/**
 * 欄の名前が取る固定幅。詳細の中ではすべての欄で同じになり、詳細を広げると増える。
 * 狭いときは名前を縮め、3つの数値が読める幅を残す。
 */
export function fieldLabelWidth(detailsWidth: number): number {
  const grown = LABEL_AT_DEFAULT + (detailsWidth - DETAILS_DEFAULT) * LABEL_GROWTH;
  const cap = Math.max(LABEL_FLOOR, detailsWidth - BESIDES_LABEL);
  return Math.round(Math.min(LABEL_MAX, Math.max(LABEL_FLOOR, Math.min(grown, cap))));
}

export function readDetailsWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (!raw) return DETAILS_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? n : DETAILS_DEFAULT;
  } catch {
    return DETAILS_DEFAULT;
  }
}

export function storeDetailsWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // 保存できなくても、いま開いているあいだの幅はそのまま使う
  }
}
