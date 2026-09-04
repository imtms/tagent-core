#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout } from "node:timers";
import { pathToFileURL, URL } from "node:url";

const OFFICIAL_REGISTRY = "https://registry.npmjs.org";
const GITHUB_ADVISORY_API = "https://api.github.com/advisories";
const MAX_ATTEMPTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];
const FALLBACK_ATTEMPTS = 3;
const FALLBACK_RETRY_DELAYS_MS = [2_000, 5_000];
const FALLBACK_BATCH_SIZE = 40;
const RETRYABLE_AUDIT_FAILURES = [
  /npm warn audit network/i,
  /npm error audit endpoint returned an error/i,
  /\b(?:AbortError|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|FETCH_ERROR|TimeoutError)\b/i,
  /\bHTTP (?:429|5\d\d)\b/i,
  /\b(?:429|5\d\d)\b.*\b(?:Bad Gateway|Service Unavailable|Gateway Time-?out|Too Many Requests)\b/i,
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
  fallback,
  retryLabel = "npm audit",
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await run();
    if (result.stdout) write("stdout", result.stdout);
    if (result.stderr) write("stderr", result.stderr);
    if (result.code === 0) return 0;

    const output = `${result.stdout}\n${result.stderr}`;
    const retryable = isRetryableAuditFailure(output);
    if (!retryable) {
      return Number.isInteger(result.code) && result.code > 0 ? result.code : 1;
    }
    if (attempt === maxAttempts) {
      if (fallback) {
        write("stderr", "npm audit transport retries exhausted; checking the exact lockfile versions against the GitHub Advisory Database.\n");
        return fallback();
      }
      return Number.isInteger(result.code) && result.code > 0 ? result.code : 1;
    }

    const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0;
    write("stderr", `Transient ${retryLabel} transport failure (${attempt}/${maxAttempts}); retrying in ${delayMs}ms.\n`);
    await wait(delayMs);
  }
  return 1;
}

function packageNameFromInstallPath(installPath) {
  const marker = "node_modules/";
  const markerIndex = installPath.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const segments = installPath.slice(markerIndex + marker.length).split("/");
  if (segments[0]?.startsWith("@")) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
  }
  return segments[0] || undefined;
}

export function auditCoordinatesFromLockfile(lockfile, { omitDev = false } = {}) {
  if (!lockfile || typeof lockfile !== "object" || !lockfile.packages || typeof lockfile.packages !== "object") {
    throw new Error("package-lock.json must contain a packages object");
  }
  const coordinates = new Set();
  for (const [installPath, metadata] of Object.entries(lockfile.packages)) {
    if (!metadata || typeof metadata !== "object" || metadata.link === true || typeof metadata.version !== "string") continue;
    if (omitDev && metadata.dev === true) continue;
    const name = packageNameFromInstallPath(installPath);
    if (name) coordinates.add(`${name}@${metadata.version}`);
  }
  return [...coordinates].sort();
}

function splitBatches(values, batchSize) {
  const batches = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    batches.push(values.slice(offset, offset + batchSize));
  }
  return batches;
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return undefined;
  for (const link of linkHeader.split(",")) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

async function queryGitHubAdvisories({ coordinates, severity, token, fetchImpl = globalThis.fetch }) {
  const requestUrl = new URL(GITHUB_ADVISORY_API);
  requestUrl.searchParams.set("ecosystem", "npm");
  requestUrl.searchParams.set("affects", coordinates.join(","));
  requestUrl.searchParams.set("severity", severity);
  requestUrl.searchParams.set("per_page", "100");
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "tagent-core-release-audit",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const advisories = [];
  let pageUrl = requestUrl.href;
  try {
    while (pageUrl) {
      if (new URL(pageUrl).origin !== requestUrl.origin) {
        return { code: 1, stdout: "", stderr: "GitHub Advisory Database returned an unsafe pagination URL.\n" };
      }
      const response = await fetchImpl(pageUrl, {
        headers,
        signal: globalThis.AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { code: 1, stdout: "", stderr: `GitHub Advisory Database HTTP ${response.status}: ${await response.text()}\n` };
      }
      const page = await response.json();
      if (!Array.isArray(page)) {
        return { code: 1, stdout: "", stderr: "GitHub Advisory Database returned a non-array response.\n" };
      }
      advisories.push(...page);
      pageUrl = nextPageUrl(response.headers.get("link"));
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "FETCH_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, stdout: "", stderr: `GitHub Advisory Database ${name}: ${message}\n` };
  }

  const active = advisories.filter((advisory) => advisory && typeof advisory === "object" && !advisory.withdrawn_at);
  if (active.length === 0) return { code: 0, stdout: "", stderr: "" };
  const report = active.map((advisory) => {
    const identifier = advisory.ghsa_id ?? advisory.cve_id ?? "unknown-advisory";
    return `${severity}: ${identifier} ${advisory.html_url ?? advisory.summary ?? ""}`.trim();
  }).join("\n");
  return { code: 1, stdout: "", stderr: `${report}\n` };
}

export async function auditGitHubFallback({
  lockfile,
  omitDev = false,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  query = queryGitHubAdvisories,
  wait,
  write = (stream, value) => process[stream].write(value),
}) {
  const coordinates = auditCoordinatesFromLockfile(lockfile, { omitDev });
  if (coordinates.length === 0) {
    write("stderr", "GitHub Advisory Database fallback found no auditable package versions.\n");
    return 1;
  }
  const batches = splitBatches(coordinates, FALLBACK_BATCH_SIZE);
  for (const severity of ["high", "critical"]) {
    for (const coordinatesBatch of batches) {
      const code = await auditWithRetry({
        run: () => query({ coordinates: coordinatesBatch, severity, token }),
        ...(wait ? { wait } : {}),
        write,
        maxAttempts: FALLBACK_ATTEMPTS,
        retryDelaysMs: FALLBACK_RETRY_DELAYS_MS,
        retryLabel: "GitHub Advisory Database",
      });
      if (code !== 0) return code;
    }
  }
  write("stdout", `GitHub Advisory Database found no high or critical vulnerabilities in ${coordinates.length} exact lockfile package versions.\n`);
  return 0;
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
  const lockfile = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  return auditWithRetry({
    run: () => runNpmAudit(auditArgs),
    fallback: () => auditGitHubFallback({ lockfile, omitDev: args.includes("--omit=dev") }),
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
