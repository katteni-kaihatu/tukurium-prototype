import type { Vec3 } from "@tukurium/eks";
import { checkFieldValues, marubatsuCellPosition, marubatsuSample } from "@tukurium/repo-model";
import { Simulation } from "@tukurium/runtime";
import { describe, expect, it } from "vitest";
import { fieldSchemasOf } from "./typecheck";

describe("同梱サンプルを、型から作ったスキーマで動かす（ADR 0065）", () => {
  it("マルバツ：リスト・マップ・レコードのフィールドに、System の書き込みが型のとおりに入る", async () => {
    const snapshot = marubatsuSample();
    // セッションに出すときと同じく、TypeScript でフィールドのスキーマを作る
    const schemas = fieldSchemasOf(snapshot, new Map());
    expect(schemas.ks_board).toMatchObject({
      f_marks: { kind: "list", item: { kind: "union" } },
      f_seats: { kind: "map", value: { kind: "record" } },
      f_line: { kind: "list", item: { kind: "number" } },
    });
    // 同梱の値と初期値は、型に合っている
    expect(checkFieldValues(snapshot, schemas)).toEqual([]);

    // スキーマがあると、型に合わない書き込みは入らない。遊び終わりまで進めば、書き込みは型のとおり
    const sim = await Simulation.create(snapshot, "out_maru", { realm: "r", schemas });
    try {
      const click = (cell: number, player: string, playerName: string) => {
        const at: Vec3 = marubatsuCellPosition(cell);
        sim.input({
          action: "fire",
          phase: "down",
          origin: [at[0], at[1], at[2] + 2],
          direction: [0, 0, -1],
          player,
          playerName,
        });
        sim.step(1 / 60);
      };
      click(0, "p1", "あおい");
      click(3, "p2", "ひかり");
      click(1, "p1", "あおい");
      click(4, "p2", "ひかり");
      click(2, "p1", "あおい");
      expect(sim.systemStatus().every((s) => s.error === null)).toBe(true);
      expect(sim.world.get("ent_board", "ks_board")).toEqual({
        f_marks: ["O", "O", "O", "X", "X", "", "", "", ""],
        f_seats: {
          O: { player: "p1", name: "あおい" },
          X: { player: "p2", name: "ひかり" },
        },
        f_turn: "",
        f_result: "O",
        f_line: [0, 1, 2],
      });
    } finally {
      sim.dispose();
    }
  });
});
