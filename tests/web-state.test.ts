import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Web workbench state model", () => {
  it("keeps active execution separate from selected Run history", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("const [activeRun, setActiveRun]");
    expect(source).toContain("const [selectedRun, setSelectedRun]");
    expect(source).toContain("subscribe(activeRun.id");
    expect(source).toContain("setSelectedRun(selected)");
    expect(source).not.toContain("const [run, setRun]");
  });
});
