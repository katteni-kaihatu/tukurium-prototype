import { BUILTIN } from "@tukurium/repo-model";
import type { InputEvent, Simulation } from "./simulation";

/**
 * テスト用：入力を送る人が、置いてある道具（EquipmentTool）をみな装備していることにしてから送る。
 * 装備の仕組み（ADR 0053）より前の、「銃はみんなの手にある」前提のテストのため。装備そのものは別に確かめる。
 */
export function inputWithTools(sim: Simulation, ev: InputEvent): void {
  for (const id of sim.world.query({ with: [BUILTIN.EquipmentTool] })) {
    const tool = sim.world.get(id, BUILTIN.EquipmentTool);
    if (tool) tool.player = ev.player;
  }
  sim.input(ev);
}
