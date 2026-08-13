import { describe, expect, it } from "vitest";
import { createAttemptRequestEnvelope, requestHash } from "@tagent/execution/domain";
import {
  createEnvironmentCredentialResolver,
  credentialReference,
  scrubbedParentEnvironment,
} from "@tagent/execution/ports";
import { childEnvironment, createLocalSubprocessPort } from "@tagent/workspace-local/local-subprocess";

function runProcess(command: string, options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; graceMs?: number } = {}) {
  const subprocess = createLocalSubprocessPort();
  const stdout: Buffer[] = [];
  const handle = subprocess.spawn({
    argv: ["bash", "-lc", command],
    cwd: process.cwd(),
    env: options.env,
    signal: options.signal,
    terminationGraceMs: options.graceMs ?? 50,
    onStdout: (chunk) => stdout.push(Buffer.from(chunk)),
  });
  return { subprocess, handle, output: () => Buffer.concat(stdout).toString("utf8") };
}

describe("security execution primitives", () => {
  it("scrubs ambient credentials and TAgent state while preserving safe process variables", () => {
    const inherited = {
      PATH: "/safe/bin",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "openai-secret",
      GITHUB_TOKEN: "github-secret",
      DB_PASSWORD: "database-secret",
      SERVICE_CREDENTIAL: "service-secret",
      TAGENT_SERVICE_CREDENTIALS: "control-secret",
      TAGENT_EVALUATION_RECEIPT_SECRET: "receipt-secret",
    };
    expect(scrubbedParentEnvironment(inherited)).toEqual({ PATH: "/safe/bin", LANG: "en_US.UTF-8" });
    expect(childEnvironment({ OPENAI_API_KEY: "explicit-trusted", CUSTOM: "visible" }, inherited)).toEqual({
      PATH: "/safe/bin",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "explicit-trusted",
      CUSTOM: "visible",
    });
    expect(childEnvironment({ PATH: undefined }, inherited)).toEqual({ LANG: "en_US.UTF-8" });
    expect(() => childEnvironment({ "BAD=NAME": "value" }, inherited)).toThrow("NUL-free names without =");
    expect(() => childEnvironment({ BAD: "nul\0value" }, inherited)).toThrow("NUL-free values");
  });

  it("passes only scrubbed ambient env plus explicit trusted overrides to a child", async () => {
    const previous = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      TAGENT_SERVICE_CREDENTIALS: process.env.TAGENT_SERVICE_CREDENTIALS,
      DEMO_PASSWORD: process.env.DEMO_PASSWORD,
    };
    process.env.OPENAI_API_KEY = "ambient-openai";
    process.env.TAGENT_SERVICE_CREDENTIALS = "ambient-service";
    process.env.DEMO_PASSWORD = "ambient-password";
    const processRun = runProcess("node -e 'process.stdout.write(JSON.stringify({path:Boolean(process.env.PATH),openai:process.env.OPENAI_API_KEY,tagent:process.env.TAGENT_SERVICE_CREDENTIALS,password:process.env.DEMO_PASSWORD,explicit:process.env.EXPLICIT_TOKEN}))'", {
      env: { EXPLICIT_TOKEN: "trusted-override" },
    });
    try {
      expect(await processRun.handle.done).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(processRun.output())).toEqual({ path: true, explicit: "trusted-override" });
    } finally {
      await processRun.subprocess.dispose?.();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  it("resolves credential references per operation so rotation is immediately visible", async () => {
    const environment: NodeJS.ProcessEnv = { ROTATING_API_KEY: "first" };
    const resolver = createEnvironmentCredentialResolver(environment);
    const reference = credentialReference("ROTATING_API_KEY");
    expect(await resolver.configured(reference)).toBe(true);
    expect(await resolver.resolve(reference)).toBe("first");
    environment.ROTATING_API_KEY = "second";
    expect(await resolver.resolve(reference)).toBe("second");
    delete environment.ROTATING_API_KEY;
    expect(await resolver.configured(reference)).toBe(false);
    expect(await resolver.resolve(reference)).toBeUndefined();
    expect(() => credentialReference("not a valid reference")).toThrow("must match");
  });

  it("terminates a process group on abort and escalates when SIGTERM is ignored", async () => {
    const controller = new AbortController();
    const processRun = runProcess("trap '' TERM; sleep 30", { signal: controller.signal, graceMs: 25 });
    const startedAt = Date.now();
    controller.abort(new Error("test abort"));
    const outcome = await processRun.handle.done;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(outcome.signal).toMatch(/SIGKILL|SIGTERM/);
    await processRun.subprocess.dispose?.();
  });

  it.runIf(process.platform !== "win32")("does not settle until detached descendants leave the process group", async () => {
    const processRun = runProcess("(trap '' TERM; sleep 30) >/dev/null 2>&1 & printf ready", { graceMs: 25 });
    while (!processRun.output().includes("ready")) await new Promise((resolve) => setTimeout(resolve, 5));
    let settled = false;
    void processRun.handle.done.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    const startedAt = Date.now();
    await processRun.subprocess.dispose?.();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(settled).toBe(true);
  });

  it("changes request digests when any replay-relevant field changes", () => {
    const base = {
      runId: "run-1", attemptId: "attempt-1", attempt: 1, requestOrdinal: 1,
      model: { id: "model-a", provider: "provider", api: "openai-completions", baseUrl: "https://example.test/v1", reasoning: false, contextWindow: 1000, maxTokens: 100 },
      providerPayload: { model: "model-a", messages: [{ role: "system", content: "system-a" }, { role: "user", content: "hello" }], tools: [{ name: "read" }], reasoning_effort: "low" }, createdAt: 1,
    };
    const digest = createAttemptRequestEnvelope(base).envelopeHash;
    expect(createAttemptRequestEnvelope({ ...base, providerPayload: { ...base.providerPayload, messages: [{ role: "system", content: "system-b" }] } }).envelopeHash).not.toBe(digest);
    expect(createAttemptRequestEnvelope({ ...base, providerPayload: { ...base.providerPayload, messages: [{ role: "user", content: "changed" }] } }).envelopeHash).not.toBe(digest);
    expect(createAttemptRequestEnvelope({ ...base, providerPayload: { ...base.providerPayload, tools: [{ name: "write" }] } }).envelopeHash).not.toBe(digest);
    expect(createAttemptRequestEnvelope({ ...base, model: { ...base.model, id: "model-b" } }).envelopeHash).not.toBe(digest);
    expect(requestHash({ b: 2, a: 1 })).toBe(requestHash({ a: 1, b: 2 }));
    expect(() => requestHash({ value: Number.NaN })).toThrow("finite JSON number");
    expect(() => requestHash({ value: 1n })).toThrow("not JSON-serializable");
  });
});
