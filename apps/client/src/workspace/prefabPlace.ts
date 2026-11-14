/**
 * プレハブを「その場」で編集するときの、中身を出す場所（ADR 0076 の 9）。
 * 画面から切り離した計算だけを置く。座標は、ワークスペースの編集空間のもの（区画の原点から見た位置）。
 */

export type Vec3 = [number, number, number];

/** 軸に沿った箱（物の広がり） */
export interface Box {
  min: Vec3;
  max: Vec3;
}

/** 出したプレハブの中身と、まわりの物の間にあけるすき間（m） */
export const PREFAB_EDIT_GAP = 0.5;

/** 中身がないとき（空のプレハブなど）に使う、点の箱 */
const POINT: Box = { min: [0, 0, 0], max: [0, 0, 0] };

/** 二つの箱が、重なっているか（面が触れているだけなら、重なっていない） */
export function boxesOverlap(a: Box, b: Box): boolean {
  return [0, 1, 2].every(
    (i) =>
      (a.min[i] as number) < (b.max[i] as number) && (b.min[i] as number) < (a.max[i] as number),
  );
}

/** 箱を、ずらす */
export function moveBox(box: Box, by: Vec3): Box {
  return {
    min: [box.min[0] + by[0], box.min[1] + by[1], box.min[2] + by[2]],
    max: [box.max[0] + by[0], box.max[1] + by[1], box.max[2] + by[2]],
  };
}

const center = (box: Box, i: 0 | 1 | 2) => (box.min[i] + box.max[i]) / 2;

export interface PrefabEditPlaceInput {
  /** プレハブの中身の広がり（プレハブの原点から見た箱）。形のあるものがなければ null */
  content: Box | null;
  /** 開いた元のインスタンスの広がり。Resources から開いたときは null */
  instance: Box | null;
  /** いまのアウトプットの中身の広がり（区画に出ているもの全体）。空なら null */
  output: Box | null;
  /** よけるもの（アウトプットの、ほかの物の広がり） */
  obstacles?: readonly Box[];
}

/**
 * 「その場」で編集するときに、プレハブの原点を置く場所を決める。
 *
 * - インスタンスから開いたとき：そのインスタンスの横（+X 側）に、すき間をあけて出す。
 *   高さと奥行きは、インスタンスに合わせる。ほかの物（obstacles）と重なるなら、重ならなくなるまで、さらに横へ送る。
 * - Resources から開いたとき：いまの区画に出ているもの全体の手前（+Z 側）に、床に載せて出す。
 *
 * どちらでも、出した中身は、インスタンスともアウトプットの中身とも重ならない。
 */
export function prefabEditOrigin(input: PrefabEditPlaceInput): Vec3 {
  const content = input.content ?? POINT;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  if (!input.instance) {
    const output = input.output ?? POINT;
    return [
      round(center(output, 0) - center(content, 0)),
      // 床より下に出ないように、底を床に合わせる
      round(Math.max(0, -content.min[1])),
      round(output.max[2] + PREFAB_EDIT_GAP - content.min[2]),
    ];
  }
  const instance = input.instance;
  const y = instance.min[1] - content.min[1];
  const z = center(instance, 2) - center(content, 2);
  let x = instance.max[0] + PREFAB_EDIT_GAP - content.min[0];
  // 横へ送るたびに、ぶつかった物の右端より先へ出る。物の数より多くは回らない
  const obstacles = input.obstacles ?? [];
  for (let i = 0; i <= obstacles.length; i++) {
    const placed = moveBox(content, [x, y, z]);
    const hit = obstacles.find((o) => boxesOverlap(placed, o));
    if (!hit) break;
    x = hit.max[0] + PREFAB_EDIT_GAP - content.min[0];
  }
  return [round(x), round(y), round(z)];
}
