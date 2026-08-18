import path from "node:path";

export function isPathInside(root, target, pathApi = path) {
  const fromRoot = pathApi.relative(root, target);
  return fromRoot !== ""
    && fromRoot !== ".."
    && !fromRoot.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(fromRoot);
}
