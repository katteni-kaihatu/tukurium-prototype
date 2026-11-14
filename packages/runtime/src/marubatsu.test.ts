import type { Vec3 } from "@tukurium/eks";
import {
  BUILTIN,
  MARUBATSU_RESET,
  marubatsuCellPosition,
  marubatsuSample,
} from "@tukurium/repo-model";
import { afterEach, describe, expect, it } from "vitest";
import { Simulation } from "./simulation";

let sim: Simulation | undefined;
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

const click = (at: Vec3, player: string, playerName = "") => {
  sim?.input({
    action: "fire",
    phase: "down",
    origin: [at[0], at[1], at[2] + 2],
    direction: [0, 0, -1],
    player,
    ...(playerName ? { playerName } : {}),
  });
  sim?.step(1 / 60);
};

/** リセットを見て E を押す。from はボタンからの距離（手前が正） */
const pressReset = (from: number, player = "p") => {
  sim?.input({
    action: "use",
    phase: "down",
    origin: [MARUBATSU_RESET[0], MARUBATSU_RESET[1], MARUBATSU_RESET[2] + from],
    direction: [0, 0, -1],
    player,
  });
  sim?.step(1 / 60);
};

const board = () => sim?.world.get("ent_board", "ks_board");
/** 盤の印を、見やすい文字から作る（空白が空きのマス） */
const marks = (text: string) => text.split("").map((c) => (c === " " ? "" : c));
const seat = (player: string, name = "") => ({ player, name });
const cell = (i: number) => sim?.world.get(`ent_cell${i}`, "ks_cell");
const text = (name: string) => {
  const id = sim?.world.entityIds().find((x) => sim?.nameOf(x) === name);
  return id ? sim?.world.get(id, BUILTIN.Label)?.text : undefined;
};

describe("Simulation：マルバツのサンプル", () => {
  it("最初の人が先行、次の人が後攻になり、ほかの人は置けない。勝ったらリセットで戻る", async () => {
    sim = await Simulation.create(marubatsuSample(), "out_maru", { realm: "r" });
    expect(sim.systemStatus().every((s) => s.error === null)).toBe(true);
    sim.step(1 / 60);
    expect(text("様子")).toBe("マスをクリックして参加");

    click(marubatsuCellPosition(0), "p1", "あおい");
    expect(board()?.f_seats).toEqual({ O: seat("p1", "あおい") });
    expect(cell(0)?.f_mark).toBe("O");
    expect(text("先行の表示")).toBe("先行　あおい");
    expect(text("様子")).toBe("後攻を待っています");

    // 先行がもう一度押しても、後攻が決まるまでは進まない
    click(marubatsuCellPosition(1), "p1", "あおい");
    expect(cell(1)?.f_mark).toBe("");
    expect(board()?.f_seats).toEqual({ O: seat("p1", "あおい") });

    click(marubatsuCellPosition(3), "p2", "ひかり");
    expect(board()).toMatchObject({
      f_seats: { O: seat("p1", "あおい"), X: seat("p2", "ひかり") },
      f_turn: "O",
    });
    expect(cell(3)?.f_mark).toBe("X");
    expect(text("後攻の表示")).toBe("後攻　ひかり");

    // 登録が済んだら、ほかの人は押せない
    click(marubatsuCellPosition(8), "p3", "みどり");
    expect(cell(8)?.f_mark).toBe("");
    expect(board()?.f_marks).toEqual(marks("O  X     "));

    click(marubatsuCellPosition(1), "p1", "あおい");
    click(marubatsuCellPosition(4), "p2", "ひかり");
    click(marubatsuCellPosition(2), "p1", "あおい");
    expect(board()?.f_result).toBe("O");
    expect(board()?.f_line).toEqual([0, 1, 2]);
    expect(text("様子")).toBe("先行の勝ち");
    expect(sim?.world.get("ent_cell0", BUILTIN.Mesh)?.color).toBe("#f3d27a");

    // 終わったあとは置けない。リセットで最初から
    click(marubatsuCellPosition(8), "p2", "ひかり");
    expect(cell(8)?.f_mark).toBe("");
    click(MARUBATSU_RESET, "p3");
    expect(board()?.f_marks).toEqual(marks("         "));
    expect(board()).toMatchObject({ f_seats: {}, f_line: [], f_result: "" });
    expect(cell(0)?.f_mark).toBe("");
    expect(text("先行の表示")).toBe("先行　空き");

    click(marubatsuCellPosition(4), "p3", "みどり");
    expect(board()?.f_seats).toEqual({ O: seat("p3", "みどり") });
    expect(cell(4)?.f_mark).toBe("O");
  });

  it("近くで E を押すと最初からに戻り、遠いときとマスには届かない", async () => {
    sim = await Simulation.create(marubatsuSample(), "out_maru", { realm: "r" });
    expect(sim.systemStatus().map((s) => [s.name, s.error])).toEqual([
      ["Marubatsu", null],
      ["MarubatsuReset", null],
    ]);
    click(marubatsuCellPosition(0), "p1", "あおい");
    expect(board()?.f_seats).toEqual({ O: seat("p1", "あおい") });

    // マスを見ての E は、リセットを受け付けない
    sim.input({
      action: "use",
      phase: "down",
      origin: [
        marubatsuCellPosition(0)[0],
        marubatsuCellPosition(0)[1],
        marubatsuCellPosition(0)[2] + 2,
      ],
      direction: [0, 0, -1],
      player: "p2",
    });
    sim.step(1 / 60);
    expect(board()?.f_marks).toEqual(marks("O        "));
    expect(cell(0)?.f_mark).toBe("O");

    // 3 m より遠い E は届かない
    pressReset(4, "p2");
    expect(board()?.f_seats).toEqual({ O: seat("p1", "あおい") });

    pressReset(2, "p3");
    expect(board()?.f_marks).toEqual(marks("         "));
    expect(board()).toMatchObject({ f_seats: {}, f_line: [], f_result: "" });
    expect(cell(0)?.f_mark).toBe("");
    // 文字は次の更新で書き直す（Interact は onUpdate のあと）
    sim.step(1 / 60);
    expect(text("先行の表示")).toBe("先行　空き");
    expect(text("様子")).toBe("マスをクリックして参加");
  });

  it("盤が埋まったら引き分けになる", async () => {
    sim = await Simulation.create(marubatsuSample(), "out_maru", { realm: "r" });
    // O X O / O X O / X O X は並ばない
    const order: [number, string][] = [
      [0, "p1"],
      [1, "p2"],
      [2, "p1"],
      [4, "p2"],
      [3, "p1"],
      [6, "p2"],
      [5, "p1"],
      [8, "p2"],
      [7, "p1"],
    ];
    for (const [i, player] of order) click(marubatsuCellPosition(i), player, player);
    expect(board()?.f_result).toBe("draw");
    expect(text("様子")).toBe("引き分け");
  });
});
