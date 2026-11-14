// プレハブの展開（ADR 0076）の重さを測る。
//   pnpm bench:prefab
// 3 段の入れ子（盤 → 列 → 駒）のプレハブを作り、盤のインスタンスを N 個置く。
// 駒は、いちばん上の Entity と子が 3 つ（子の一つは、いちばん上を指す参照を持つ）。
// 列は駒を 4 つ、盤は列を 4 つ持つので、インスタンス 1 個が 69 個の Entity になる。
import { FIELD_TYPE } from "@tukurium/eks";
import {
  BUILTIN,
  emptyProject,
  expandPrefabs,
  PrefabExpansionCache,
  ProjectDoc,
} from "@tukurium/repo-model";
import { buildWorld } from "@tukurium/runtime";

const OUT = "out_main";

function project(n: number) {
  const doc = new ProjectDoc();
  doc.load(emptyProject("bench"));
  const link = doc.addKokoState("Link");
  doc.updateKokoState({
    id: link,
    name: "Link",
    fields: [{ id: "to", name: "to", type: FIELD_TYPE.entity, default: undefined }],
  });
  const piece = doc.addPrefab("駒");
  const pieceRoot = doc.prefab(piece)?.root ?? "";
  doc.addState(pieceRoot, BUILTIN.Mesh, { shape: "cylinder" });
  let leaf = "";
  for (let i = 0; i < 3; i++)
    leaf = doc.addPrefabEntity({
      prefab: piece,
      name: `部品${i}`,
      states: {
        [BUILTIN.Transform]: { position: [0, i * 0.2, 0] },
        [BUILTIN.Mesh]: { shape: "box" },
        ...(i === 0 ? { [link]: { to: pieceRoot } } : {}),
      },
    });
  const row = doc.addPrefab("列");
  for (let i = 0; i < 4; i++)
    doc.addPrefabEntity({
      prefab: row,
      name: `駒${i}`,
      instanceOf: { prefab: piece },
      states: { [BUILTIN.Transform]: { position: [i, 0, 0] } },
    });
  const board = doc.addPrefab("盤");
  for (let i = 0; i < 4; i++)
    doc.addPrefabEntity({
      prefab: board,
      name: `列${i}`,
      instanceOf: { prefab: row },
      states: { [BUILTIN.Transform]: { position: [0, 0, i] } },
    });
  for (let i = 0; i < n; i++)
    doc.addInstance({
      output: OUT,
      prefab: board,
      position: [(i % 10) * 5, 0, Math.floor(i / 10) * 5],
    });
  return { doc, leaf };
}

const time = (fn: () => void, times = 20): string => {
  fn(); // 準備運動
  const t0 = performance.now();
  for (let i = 0; i < times; i++) fn();
  return ((performance.now() - t0) / times).toFixed(2);
};

for (const n of [1, 10, 100, 300]) {
  const { doc, leaf } = project(n);
  const snap = doc.snapshot();
  const entities = expandPrefabs(snap).entities.length;
  const cache = new PrefabExpansionCache();
  expandPrefabs(snap, { cache });
  // 駒の中を変えた制作データ（駒・列・盤を作り直すことになる）
  doc.setField(leaf, BUILTIN.Transform, "position", [0, 9, 0]);
  const changed = doc.snapshot();
  // インスタンスを一つ動かした制作データ（そのインスタンスだけを展開し直すことになる）
  const moved = structuredClone(snap);
  const first = moved.entities[0]?.states[BUILTIN.Transform];
  if (first) first.position = [1, 2, 3];
  let flip = false;
  console.log({
    instances: n,
    entities,
    // 制作データを取り出す（展開の前に、いつも要る）
    snapshotMs: time(() => void doc.snapshot()),
    // 何も取っておかずに展開する
    expandColdMs: time(() => void expandPrefabs(snap)),
    // 取っておいたものを使って展開する（プレハブもインスタンスも変わっていない）
    expandCachedMs: time(() => void expandPrefabs(snap, { cache })),
    // インスタンスを一つ動かすたびに展開する
    expandAfterMoveMs: time(() => {
      flip = !flip;
      expandPrefabs(flip ? moved : snap, { cache });
    }),
    // いちばん内側のプレハブを変えるたびに展開する
    expandAfterEditMs: time(() => {
      flip = !flip;
      expandPrefabs(flip ? changed : snap, { cache });
    }),
    // 展開して、表示用の World を組み立てる
    buildWorldMs: time(() => void buildWorld(snap, OUT, undefined, { cache }), 5),
  });
}
