import { describe, expect, it } from "vitest";
import { useMainMenu } from "./store";

describe("本人のメニュー表示", () => {
  it("閉じても選択画面・検索・選択対象を保ち、再表示の合図だけを更新する", () => {
    const menu = useMainMenu.getState();
    menu.show("market");
    menu.setQuery("market", "スイッチ");
    menu.select("market", "work-1");
    const recall = useMainMenu.getState().recall;
    menu.close();
    expect(useMainMenu.getState().open).toBe(false);
    menu.toggle();
    expect(useMainMenu.getState()).toMatchObject({
      open: true,
      page: "market",
      recall: recall + 1,
      queries: { market: "スイッチ" },
      selected: { market: "work-1" },
    });
  });
});
