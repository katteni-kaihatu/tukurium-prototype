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

const CLEAR_BOARD = `function clearBoard(board: BoardValues) {
  for (let i = 0; i < 9; i++) {
    const id = world.find("マス" + i);
    if (!id) continue;
    const cell = world.get(id, Cell);
    if (!cell) continue;
    if (cell.piece) world.destroy(cell.piece);
    if (cell.piece2) world.destroy(cell.piece2);
    world.set(id, Cell, { mark: "", piece: null, piece2: null });
  }
  board.marks = "         ";
  board.first = "";
  board.second = "";
  board.firstName = "";
  board.secondName = "";
  board.turn = "";
  board.result = "";
  board.line = "";
}
`;

const PLAY = `// マルバツ。クリックで○か×がつき、先に三つまっすぐ並べた方が勝ち。
// 最初にマスを押した人が先行、次に押した人が後攻。登録が済んだら、その二人以外は押せない。
// リセットはクリックでも、近くで E（Interact）でも最初からに戻る。E は Reset の System が受ける。
import Board from "../States/Board.koko";
import Cell from "../States/Cell.koko";
import Label from "@builtin/Label.koko";
import Mesh from "@builtin/Mesh.koko";
import Transform from "@builtin/Transform.koko";

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

function judge(marks: string): { winner: string; line: string } | null {
  for (let i = 0; i < LINES.length; i++) {
    const line = LINES[i];
    const a = marks[line[0]];
    if (a !== " " && a === marks[line[1]] && a === marks[line[2]]) {
      return { winner: a, line: line.join(",") };
    }
  }
  if (marks.indexOf(" ") < 0) return { winner: "draw", line: "" };
  return null;
}

${CLEAR_BOARD}
function putMark(board: BoardValues, cellId: string, cell: CellValues, mark: string) {
  const chars = board.marks.split("");
  if (chars.length !== 9 || chars[cell.index] !== " ") return;
  chars[cell.index] = mark;
  board.marks = chars.join("");
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
      : null;
  world.set(cellId, Cell, { mark: mark, piece: piece, piece2: piece2 });
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
  if (!board.first) return "マスをクリックして参加";
  if (!board.second) return "後攻を待っています";
  return board.turn === "X" ? "後攻の番" : "先行の番";
}

function seatText(role: string, name: string, filled: string): string {
  if (!filled) return role + "　空き";
  return role + "　" + (name || "参加中");
}

function lampColor(mark: string, board: BoardValues): string {
  const filled = mark === "O" ? board.first : board.second;
  if (!filled) return "#d5cfc3";
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
  if (first) world.set(first, Label, { text: seatText("先行", board.firstName, board.first) });
  const second = world.find("後攻の表示");
  if (second) world.set(second, Label, { text: seatText("後攻", board.secondName, board.second) });
  const lampO = world.find("先行の印");
  if (lampO) world.set(lampO, Mesh, { color: lampColor("O", board) });
  const lampX = world.find("後攻の印");
  if (lampX) world.set(lampX, Mesh, { color: lampColor("X", board) });
  for (let i = 0; i < 9; i++) {
    const id = world.find("マス" + i);
    if (!id) continue;
    const win = board.line.length > 0 && board.line.split(",").indexOf(String(i)) >= 0;
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
    let mark = "";
    if (!board.first) {
      board.first = who;
      board.firstName = name;
      mark = "O";
    } else if (!board.second) {
      if (who === board.first) return;
      board.second = who;
      board.secondName = name;
      mark = "X";
    } else if (who !== board.first && who !== board.second) {
      return;
    } else if (board.turn === "O" && who !== board.first) {
      return;
    } else if (board.turn === "X" && who !== board.second) {
      return;
    } else {
      mark = board.turn;
    }
    if (mark !== "O" && mark !== "X") return;
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

/** 同梱サンプル：二人で遊ぶマルバツ */
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
          material: null,
          color: "#f7f3ea",
          model: null,
        },
        [BUILTIN.Collider]: { sensor: false },
        ks_cell: { f_index: i, f_mark: "", f_piece: null, f_piece2: null },
      },
    });
  }

  return {
    version: 1,
    name: "マルバツ",
    folders: [
      { id: "f_states", name: "States", parent: null },
      { id: "f_sys", name: "Systems", parent: null },
    ],
    placement: {
      ks_board: "f_states",
      ks_cell: "f_states",
      ks_reset: "f_states",
      sys_maru: "f_sys",
      sys_reset: "f_sys",
    },
    kokostates: [
      {
        id: "ks_board",
        name: "Board",
        fields: [
          { id: "f_marks", name: "marks", type: "string", default: "         " },
          { id: "f_first", name: "first", type: "string", default: "" },
          { id: "f_second", name: "second", type: "string", default: "" },
          { id: "f_firstName", name: "firstName", type: "string", default: "" },
          { id: "f_secondName", name: "secondName", type: "string", default: "" },
          { id: "f_turn", name: "turn", type: "string", default: "" },
          { id: "f_result", name: "result", type: "string", default: "" },
          { id: "f_line", name: "line", type: "string", default: "" },
        ],
      },
      {
        id: "ks_cell",
        name: "Cell",
        fields: [
          { id: "f_index", name: "index", type: "number", default: 0 },
          { id: "f_mark", name: "mark", type: "string", default: "" },
          { id: "f_piece", name: "piece", type: "entity", default: null },
          { id: "f_piece2", name: "piece2", type: "entity", default: null },
        ],
      },
      { id: "ks_reset", name: "Reset", fields: [] },
    ],
    systems: [
      { id: "sys_maru", name: "Marubatsu", code: PLAY },
      { id: "sys_reset", name: "MarubatsuReset", code: RESET },
    ],
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
            material: null,
            color: "#a67c52",
            model: null,
          },
          [BUILTIN.Collider]: { sensor: false },
          ks_board: {
            f_marks: "         ",
            f_first: "",
            f_second: "",
            f_firstName: "",
            f_secondName: "",
            f_turn: "",
            f_result: "",
            f_line: "",
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
            material: null,
            color: "#6d543c",
            model: null,
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
            material: null,
            color: "#3f5348",
            model: null,
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
            material: null,
            color: "#d5cfc3",
            model: null,
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
            material: null,
            color: "#d5cfc3",
            model: null,
          },
        },
      },
    ],
  };
}
