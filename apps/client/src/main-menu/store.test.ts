import { beforeEach, describe, expect, it } from "vitest";
import { useMainMenu } from "./store";

beforeEach(() => useMainMenu.setState(useMainMenu.getInitialState(), true));
describe("本人のウィンドウ", () => {
  it("ステータスも独立して開き、フレンドを閉じても入力用の窓を残す", () => {
    const menu = useMainMenu.getState();
    menu.show("friends");
    menu.showWindow("status");
    expect(useMainMenu.getState()).toMatchObject({
      page: "friends",
      activeWindow: "status",
      windows: { friends: { open: true }, status: { open: true } },
    });
    menu.close("friends");
    expect(useMainMenu.getState().windows.status.open).toBe(true);
    menu.close("status");
    expect(useMainMenu.getState().open).toBe(false);
  });
  it("複数を同時に開き、一つ閉じても他の検索・選択・表示を保つ", () => {
    const menu = useMainMenu.getState();
    menu.show("market");
    menu.setQuery("market", "スイッチ");
    menu.select("market", "work-1");
    menu.show("friends");
    expect(useMainMenu.getState().windows.market.open).toBe(true);
    menu.close("friends");
    expect(useMainMenu.getState()).toMatchObject({
      open: true,
      activeWindow: "market",
      queries: { market: "スイッチ" },
      selected: { market: "work-1" },
    });
    expect(useMainMenu.getState().windows.friends.open).toBe(false);
  });
  it("プロジェクト内の移動では置き方を変えず、閉じてから開くときだけ呼び戻す", () => {
    const menu = useMainMenu.getState();
    menu.showProject("/u/me");
    const recall = useMainMenu.getState().windows.projects.recall;
    menu.showProject("/p/project");
    expect(useMainMenu.getState().windows.projects.recall).toBe(recall);
    menu.close("projects");
    menu.showProject("/p/project");
    expect(useMainMenu.getState().windows.projects.recall).toBe(recall + 1);
  });
  it("最後に触ったウィンドウだけを閉じ、最後の一つを閉じたら空間に戻る", () => {
    const menu = useMainMenu.getState();
    menu.show("items");
    menu.show("sessions");
    menu.activate("items");
    menu.close();
    expect(useMainMenu.getState().activeWindow).toBe("sessions");
    expect(useMainMenu.getState().windows.sessions.open).toBe(true);
    menu.close();
    expect(useMainMenu.getState().open).toBe(false);
  });
});
