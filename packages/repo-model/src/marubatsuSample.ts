import { FIELD_TYPE } from "@tukurium/eks";
import { BUILTIN } from "./builtins";
import type { EntityDef, ProjectSnapshot } from "./schema";

const OUT = "out_maru";
const STEP = 0.5;
const CELL_Z = 3.05;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** マスの中心。0 が左上、2 が右上、8 が右下。テストもこの位置を撃つ */
export function marubatsuCellPosition(index: number): [number, number, number] {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return [r2((col - 1) * STEP), r2(1.4 + (1 - row) * STEP), CELL_Z];
}

/** リセットのボタンの中心 */
export const MARUBATSU_RESET: [number, number, number] = [0, 0.38, 3.08];

/**
 * 型の定義。Board と Cell のフィールドの型から使う（ADR 0065）。
 * System からも `import type` で使える。
 */
const TYPES = `// マルバツの型。Board と Cell の「使う型の定義」に入っています。

/** 印。先行が ○、後攻が × */
export type Mark = "O" | "X";

/** 席についた人 */
export type Seat = {
  /** 参加者の ID */
  player: string;
  /** 表示する名前 */
  name: string;
};
`;

const CLEAR_BOARD = `function clearBoard(board: BoardValues) {
  for (let i = 0; i < 9; i++) {
    const id = world.find("マス" + i);
    if (!id) continue;
    const cell = world.get(id, Cell);
    if (!cell) continue;
    if (cell.piece) world.destroy(cell.piece);
    if (cell.piece2) world.destroy(cell.piece2);
    world.set(id, Cell, { mark: "", piece: undefined, piece2: undefined });
  }
  board.marks = ["", "", "", "", "", "", "", "", ""];
  board.seats = {};
  board.turn = "";
  board.result = "";
  board.line = [];
}
`;

const PLAY = `// マルバツ。クリックで○か×がつき、先に三つまっすぐ並べた方が勝ち。
// 最初にマスを押した人が先行、次に押した人が後攻。登録が済んだら、その二人以外は押せない。
// リセットはクリックでも、近くで E（Interact）でも最初からに戻る。E は Reset の System が受ける。
//
// 盤の様子は Board が持つ。フィールドの型は TypeScript の型の文で書いてある。
// - marks：マスごとの印のリスト（(Mark | "")[]）
// - seats：印から、席についた人へのマップ（Record<string, Seat>）。Seat はレコード
// - line：そろったマスの番号のリスト（number[]）
import Board from "../States/Board.koko";
import Cell from "../States/Cell.koko";
import Label from "@builtin/Label.koko";
import Mesh from "@builtin/Mesh.koko";
import Transform from "@builtin/Transform.koko";
import type { Mark, Seat } from "../Types/Marubatsu.types";

type BoardValues = FieldsOf<typeof Board>;
type CellValues = FieldsOf<typeof Cell>;

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function judge(marks: (Mark | "")[]): { winner: Mark | "draw"; line: number[] } | null {
  for (let i = 0; i < LINES.length; i++) {
    const line = LINES[i];
    const a = marks[line[0]];
    if (a !== "" && a === marks[line[1]] && a === marks[line[2]]) {
      return { winner: a, line: line.slice() };
    }
  }
  if (marks.indexOf("") < 0) return { winner: "draw", line: [] };
  return null;
}

/** その印の席についた人。まだ空いていれば undefined */
function seatOf(board: BoardValues, mark: Mark): Seat | undefined {
  return board.seats[mark];
}

${CLEAR_BOARD}
function putMark(board: BoardValues, cellId: EntityRef, cell: CellValues, mark: Mark) {
  if (board.marks.length !== 9 || board.marks[cell.index] !== "") return;
  board.marks[cell.index] = mark;
  board.turn = mark === "O" ? "X" : "O";
  const color = mark === "O" ? "#314e86" : "#8d3d3d";
  const piece = world.spawn({
    name: mark === "O" ? "まる" : "ばつ",
    parent: cellId,
    states: {
      [Transform.id]: {
        position: [0, 0, 0.05],
        rotation: mark === "O" ? [90, 0, 0] : [0, 0, 42],
        scale: [1, 1, 1],
      },
      [Mesh.id]: {
        shape: mark === "O" ? "cylinder" : "box",
        size: mark === "O" ? [0.3, 0.03, 0.3] : [0.34, 0.06, 0.03],
        color: color,
      },
    },
  });
  const piece2 =
    mark === "X"
      ? world.spawn({
          name: "ばつ",
          parent: cellId,
          states: {
            [Transform.id]: {
              position: [0, 0, 0.055],
              rotation: [0, 0, -42],
              scale: [1, 1, 1],
            },
            [Mesh.id]: { shape: "box", size: [0.34, 0.06, 0.03], color: color },
          },
        })
      : undefined;
  world.set(cellId, Cell, { mark: mark, piece: piece ?? undefined, piece2: piece2 ?? undefined });
  const judged = judge(board.marks);
  if (judged) {
    board.result = judged.winner;
    board.line = judged.line;
    board.turn = "";
  }
}

function statusText(board: BoardValues): string {
  if (board.result === "draw") return "引き分け";
  if (board.result === "O") return "先行の勝ち";
  if (board.result === "X") return "後攻の勝ち";
  if (!seatOf(board, "O")) return "マスをクリックして参加";
  if (!seatOf(board, "X")) return "後攻を待っています";
  return board.turn === "X" ? "後攻の番" : "先行の番";
}

function seatText(role: string, seat: Seat | undefined): string {
  if (!seat) return role + "　空き";
  return role + "　" + (seat.name || "参加中");
}

function lampColor(mark: Mark, board: BoardValues): Color {
  if (!seatOf(board, mark)) return "#d5cfc3";
  if (board.result === "draw") return "#9aa7b5";
  if (board.result === mark) return "#2f6d4f";
  if (board.result) return "#9aa7b5";
  if (board.turn === mark) return "#f3d27a";
  return mark === "O" ? "#314e86" : "#8d3d3d";
}

function paint(board: BoardValues) {
  const status = world.find("様子");
  if (status) world.set(status, Label, { text: statusText(board) });
  const first = world.find("先行の表示");
  if (first) world.set(first, Label, { text: seatText("先行", seatOf(board, "O")) });
  const second = world.find("後攻の表示");
  if (second) world.set(second, Label, { text: seatText("後攻", seatOf(board, "X")) });
  const lampO = world.find("先行の印");
  if (lampO) world.set(lampO, Mesh, { color: lampColor("O", board) });
  const lampX = world.find("後攻の印");
  if (lampX) world.set(lampX, Mesh, { color: lampColor("X", board) });
  for (let i = 0; i < 9; i++) {
    const id = world.find("マス" + i);
    if (!id) continue;
    const win = board.line.indexOf(i) >= 0;
    world.set(id, Mesh, { color: win ? "#f3d27a" : "#f7f3ea" });
  }
}

export default system({
  query: { with: [Board] },

  onInput(e, ev) {
    if (ev.action !== "fire" || ev.phase !== "down") return;
    const board = e.get(Board);
    const hit = world.raycast(ev.origin, ev.direction, 40);
    if (!hit || !hit.entity) return;
    if (hit.entity === world.find("リセット")) {
      clearBoard(board);
      log("最初から");
      return;
    }
    if (board.result) return;
    const cell = world.get(hit.entity, Cell);
    if (!cell || cell.mark) return;
    const who = ev.player || "";
    const name = ev.playerName || "";
    const first = seatOf(board, "O");
    const second = seatOf(board, "X");
    let mark: Mark | "" = "";
    if (!first) {
      board.seats["O"] = { player: who, name: name };
      mark = "O";
    } else if (!second) {
      if (who === first.player) return;
      board.seats["X"] = { player: who, name: name };
      mark = "X";
    } else if (who !== first.player && who !== second.player) {
      return;
    } else if (board.turn === "O" && who !== first.player) {
      return;
    } else if (board.turn === "X" && who !== second.player) {
      return;
    } else {
      mark = board.turn;
    }
    if (mark === "") return;
    putMark(board, hit.entity, cell, mark);
    log(mark === "O" ? "先行" : "後攻", name || "参加中");
  },

  onUpdate(e) {
    paint(e.get(Board));
  },
});
`;

const RESET = `// リセットのボタン。近いところで E を押すと、Built-in の Interact が届く。
// 盤はこの Entity に付いていないので、world.get の写しを書いて world.set で戻す。
import Board from "../States/Board.koko";
import Cell from "../States/Cell.koko";
import Reset from "../States/Reset.koko";

type BoardValues = FieldsOf<typeof Board>;

${CLEAR_BOARD}
export default system({
  query: { with: [Reset] },

  contracts: {
    Interact() {
      const id = world.find("盤");
      if (!id) return;
      const board = world.get(id, Board);
      if (!board) return;
      clearBoard(board);
      world.set(id, Board, board);
      log("最初から");
    },
  },
});
`;

function label(
  id: string,
  name: string,
  order: number,
  position: [number, number, number],
  text: string,
  size: number,
  color = "#3a3228",
): EntityDef {
  return {
    id,
    name,
    parent: null,
    output: OUT,
    order,
    states: {
      [BUILTIN.Transform]: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
      [BUILTIN.Label]: { text, color, size },
    },
  };
}

/** 何も置いていない盤（マス 9 つ分の空の印） */
const emptyMarks = (): string[] => Array.from({ length: 9 }, () => "");

/**
 * 同梱サンプル：二人で遊ぶマルバツ。
 * フィールドの型に、型の定義（`Mark`・`Seat`）と、リスト・マップ・レコードを使う見本でもある（ADR 0065）。
 */
export function marubatsuSample(): ProjectSnapshot {
  const cells: EntityDef[] = [];
  for (let i = 0; i < 9; i++) {
    cells.push({
      id: `ent_cell${i}`,
      name: `マス${i}`,
      parent: null,
      output: OUT,
      order: 10 + i,
      states: {
        [BUILTIN.Transform]: {
          position: marubatsuCellPosition(i),
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        [BUILTIN.Mesh]: {
          shape: "box",
          size: [0.44, 0.44, 0.05],
          material: undefined,
          color: "#f7f3ea",
          model: undefined,
        },
        [BUILTIN.Collider]: { sensor: false },
        ks_cell: { f_index: i, f_mark: "", f_piece: undefined, f_piece2: undefined },
      },
    });
  }

  return {
    version: 1,
    name: "マルバツ",
    folders: [
      { id: "f_states", name: "States", parent: null },
      { id: "f_sys", name: "Systems", parent: null },
      { id: "f_types", name: "Types", parent: null },
    ],
    placement: {
      ks_board: "f_states",
      ks_cell: "f_states",
      ks_reset: "f_states",
      td_maru: "f_types",
      sys_maru: "f_sys",
      sys_reset: "f_sys",
    },
    kokostates: [
      {
        id: "ks_board",
        name: "Board",
        description: "マルバツの盤面、参加者、手番と勝敗を持つ。",
        typeDefs: ["td_maru"],
        fields: [
          // マスごとの印（リスト）。0 が左上、8 が右下
          {
            id: "f_marks",
            name: "marks",
            description: "各マスの印。0 が左上、8 が右下。空のマスは空文字。",
            type: '(Mark | "")[]',
            default: emptyMarks(),
          },
          // 印から、席についた人へ（マップ。値はレコード）。先行は "O"、後攻は "X"
          {
            id: "f_seats",
            name: "seats",
            description: "O と X の席に参加している人。",
            type: "Record<string, Seat>",
            default: {},
          },
          {
            id: "f_turn",
            name: "turn",
            description: "次に置く印。対局していないときは空文字。",
            type: 'Mark | ""',
            default: "",
          },
          {
            id: "f_result",
            name: "result",
            description: "勝った印。引き分けは draw、未決着は空文字。",
            type: 'Mark | "draw" | ""',
            default: "",
          },
          // そろったマスの番号（リスト）
          {
            id: "f_line",
            name: "line",
            description: "勝敗が決まった、そろったマスの番号。",
            type: "number[]",
            default: [],
          },
        ],
      },
      {
        id: "ks_cell",
        name: "Cell",
        description: "盤面の一つのマスと、そこに置いた印。",
        typeDefs: ["td_maru"],
        fields: [
          {
            id: "f_index",
            name: "index",
            description: "盤面のマス番号。0 から 8。",
            type: FIELD_TYPE.number,
            default: 0,
          },
          {
            id: "f_mark",
            name: "mark",
            description: "置かれた印。何も置いていなければ空文字。",
            type: 'Mark | ""',
            default: "",
          },
          {
            id: "f_piece",
            name: "piece",
            description: "表示している印の Entity。",
            type: FIELD_TYPE.entity,
            default: undefined,
          },
          {
            id: "f_piece2",
            name: "piece2",
            description: "ばつの二本目の線の Entity。",
            type: FIELD_TYPE.entity,
            default: undefined,
          },
        ],
      },
      {
        id: "ks_reset",
        name: "Reset",
        description: "マルバツを最初からやり直すボタンの印。",
        fields: [],
      },
    ],
    systems: [
      { id: "sys_maru", name: "Marubatsu", code: PLAY },
      { id: "sys_reset", name: "MarubatsuReset", code: RESET },
    ],
    types: [{ id: "td_maru", name: "Marubatsu", code: TYPES }],
    materials: [],
    outputs: [
      {
        id: OUT,
        name: "マルバツ",
        kind: "item",
        systems: [
          { id: "sys_maru", enabled: true },
          { id: "sys_reset", enabled: true },
        ],
        keep: [],
      },
    ],
    entities: [
      {
        id: "ent_board",
        name: "盤",
        parent: null,
        output: OUT,
        order: 0,
        states: {
          [BUILTIN.Transform]: { position: [0, 1.35, 2.96], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: {
            shape: "box",
            size: [1.8, 1.9, 0.08],
            material: undefined,
            color: "#a67c52",
            model: undefined,
          },
          [BUILTIN.Collider]: { sensor: false },
          ks_board: {
            f_marks: emptyMarks(),
            f_seats: {},
            f_turn: "",
            f_result: "",
            f_line: [],
          },
        },
      },
      {
        id: "ent_post",
        name: "支柱",
        parent: null,
        output: OUT,
        order: 1,
        states: {
          [BUILTIN.Transform]: { position: [0, 0.55, 2.7], rotation: [0, 0, 0], scale: [1, 1, 1] },
          [BUILTIN.Mesh]: {
            shape: "box",
            size: [0.14, 1.1, 0.14],
            material: undefined,
            color: "#6d543c",
            model: undefined,
          },
        },
      },
      ...cells,
      {
        id: "ent_reset",
        name: "リセット",
        parent: null,
        output: OUT,
        order: 30,
        states: {
          [BUILTIN.Transform]: {
            position: MARUBATSU_RESET,
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          [BUILTIN.Mesh]: {
            shape: "box",
            size: [0.78, 0.24, 0.05],
            material: undefined,
            color: "#3f5348",
            model: undefined,
          },
          [BUILTIN.Collider]: { sensor: false },
          ks_reset: {},
        },
      },
      label("ent_title", "題", 31, [0, 2.48, 3.12], "マルバツ", 0.18),
      label("ent_label_first", "先行の表示", 32, [-0.46, 2.18, 3.12], "先行　空き", 0.12),
      label("ent_label_second", "後攻の表示", 33, [0.46, 2.18, 3.12], "後攻　空き", 0.12),
      label(
        "ent_label_status",
        "様子",
        34,
        [0, 0.7, 3.12],
        "マスをクリックして参加",
        0.11,
        "#3f5348",
      ),
      label("ent_label_reset", "リセットの文字", 35, [0, 0.38, 3.14], "リセット", 0.09, "#f7f3ea"),
      {
        id: "ent_lamp_o",
        name: "先行の印",
        parent: null,
        output: OUT,
        order: 36,
        states: {
          [BUILTIN.Transform]: {
            position: [-1.02, 2.18, 3.1],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          [BUILTIN.Mesh]: {
            shape: "sphere",
            size: [0.12, 0.12, 0.12],
            material: undefined,
            color: "#d5cfc3",
            model: undefined,
          },
        },
      },
      {
        id: "ent_lamp_x",
        name: "後攻の印",
        parent: null,
        output: OUT,
        order: 37,
        states: {
          [BUILTIN.Transform]: {
            position: [1.02, 2.18, 3.1],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          [BUILTIN.Mesh]: {
            shape: "sphere",
            size: [0.12, 0.12, 0.12],
            material: undefined,
            color: "#d5cfc3",
            model: undefined,
          },
        },
      },
    ],
  };
}
