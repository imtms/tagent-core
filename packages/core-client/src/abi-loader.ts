export type CoreAbi = typeof import("@tagent/abi");

let coreAbiPromise: Promise<CoreAbi> | undefined;

export function loadCoreAbi(): Promise<CoreAbi> {
  coreAbiPromise ??= import("@tagent/abi");
  return coreAbiPromise;
}
