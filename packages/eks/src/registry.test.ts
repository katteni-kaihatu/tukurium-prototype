import { describe, expect, it } from "vitest";
import { KokoStateRegistry } from "./registry";

describe("KokoStateRegistry：同じ名前（ADR 0010）", () => {
  it("同じスコープに同じ名前の KokoState を登録でき、名前で引くと曖昧なので見つからない", () => {
    const r = new KokoStateRegistry();
    r.register({ id: "a", name: "Gun", fields: [] }, "repo");
    r.register({ id: "b", name: "Gun", fields: [] }, "repo");
    expect(r.get("a")?.name).toBe("Gun");
    expect(r.get("b")?.name).toBe("Gun");
    expect(r.idOf("Gun", "repo")).toBeUndefined();
    expect(r.isAmbiguous("Gun", "repo")).toBe(true);
    r.unregister("b");
    expect(r.idOf("Gun", "repo")).toBe("a");
    expect(r.isAmbiguous("Gun", "repo")).toBe(false);
  });

  it("名前を変えて登録し直すと、前の名前では引けない", () => {
    const r = new KokoStateRegistry();
    r.register({ id: "a", name: "Gun", fields: [] });
    r.register({ id: "a", name: "Rifle", fields: [] });
    expect(r.idOf("Gun")).toBeUndefined();
    expect(r.idOf("Rifle")).toBe("a");
  });
});
