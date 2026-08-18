import { readFileSync, readdirSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const sourceRoot = new URL("../src/", import.meta.url);
const violations = [];

for (const file of readdirSync(sourceRoot).filter((name) => name.endsWith(".tsx")).sort()) {
  const source = readFileSync(new URL(file, sourceRoot), "utf8");
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = match[1];
    if (/^[A-Z]/.test(name)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${file}:${line} exports non-component value ${name}`);
  }
}

if (violations.length) {
  throw new Error(`React component modules must export components only; move utilities to .ts modules:\n${violations.join("\n")}`);
}

process.stdout.write("React component modules export component values only; utility functions remain in Fast Refresh-compatible .ts boundaries.\n");
