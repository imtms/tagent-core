#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";

const OFFICIAL_REGISTRY = "https://registry.npmjs.org";
const MAX_ATTEMPTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];
const RETRYABLE_AUDIT_FAILURES = [
  /npm warn audit network/i,
  /npm error audit endpoint returned an error/i,
  /\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|FETCH_ERROR)\b/i,
  /\b(?:502|503|504)\b.*\b(?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
];

export function isRetryableAuditFailure(output) {
  return RETRYABLE_AUDIT_FAILURES.some((pattern) => pattern.test(output));
}

export async function auditWithRetry({
  run,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  write = (stream, value) => process[stream].write(value),
  maxAttempts = MAX_ATTEMPTS,
  retryDelaysMs = RETRY_DELAYS_MS,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await run();
    if (result.stdout) write("stdout", result.stdout);
    if (result.stderr) write("stderr", result.stderr);
    if (result.code === 0) return 0;

    const output = `${result.stdout}\n${result.stderr}`;
    if (!isRetryableAuditFailure(output) || attempt === maxAttempts) {
      return Number.isInteger(result.code) && result.code > 0 ? result.code : 1;
    }

    const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0;
    write("stderr", `Transient npm audit transport failure (${attempt}/${maxAttempts}); retrying in ${delayMs}ms.\n`);
    await wait(delayMs);
  }
  return 1;
}

function runNpmAudit(auditArgs) {
  return new Promise((resolve) => {
    const npmExecPath = process.env.npm_execpath;
    const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
    const args = npmExecPath ? [npmExecPath, "audit", ...auditArgs] : ["audit", ...auditArgs];
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, shell: false });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      stderr.push(Buffer.from(`${error instanceof Error ? error.message : String(error)}\n`));
    });
    child.once("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function main(args) {
  if (args.some((arg) => arg !== "--omit=dev")) {
    process.stderr.write("Usage: node scripts/audit-dependencies.mjs [--omit=dev]\n");
    return 2;
  }
  const auditArgs = [
    ...(args.includes("--omit=dev") ? ["--omit=dev"] : []),
    "--audit-level=high",
    `--registry=${OFFICIAL_REGISTRY}`,
    `--fetch-timeout=${FETCH_TIMEOUT_MS}`,
    "--fetch-retries=0",
  ];
  return auditWithRetry({ run: () => runNpmAudit(auditArgs) });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
