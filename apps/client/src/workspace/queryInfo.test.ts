import { describe, expect, it } from "vitest";
import { parseQuery } from "./queryInfo";

describe("parseQuery", () => {
  it("With / Without の名前を読み取る", () => {
    expect(
      parseQuery(
        `export default system({ query: { with: ["Gun", 'Transform'], without: [\`Disabled\`] } })`,
      ),
    ).toEqual({ with: ["Gun", "Transform"], without: ["Disabled"] });
  });
  it("書かれていなければ空", () => {
    expect(parseQuery("export default system({})")).toEqual({ with: [], without: [] });
  });
});
