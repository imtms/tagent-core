import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";

const [command, ...operands] = process.argv.slice(2);
const root = process.cwd();

function localPath(value, label) {
  if (!value) throw new Error(`${label} path is required`);
  const resolved = resolve(root, value);
  const fromRoot = relative(root, resolved);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} path must stay below the current workspace: ${value}`);
  }
  return resolved;
}

if (command === "copy" || command === "copy-executable") {
  if (operands.length !== 2) throw new Error("Usage: build-files.mjs <copy|copy-executable> <source> <destination>");
  const source = localPath(operands[0], "Source");
  const destination = localPath(operands[1], "Destination");
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: true, recursive: true });
  if (command === "copy-executable") await chmod(destination, 0o755);
} else if (command === "reset") {
  if (operands.length !== 1) throw new Error("Usage: build-files.mjs reset <directory>");
  await rm(localPath(operands[0], "Reset"), { force: true, recursive: true });
} else {
  throw new Error("Usage: build-files.mjs <copy|copy-executable|reset> ...");
}
