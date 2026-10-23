import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  ensureStateDir,
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  withStateLock
} from "../plugins/grok-build/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, /grok-cc-runs/);
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: {},
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: {},
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("loadState quarantines corrupt state and throws instead of wiping", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{not-json", "utf8");

  assert.throws(() => loadState(workspace), /corrupt|quarantined/i);

  const dirEntries = fs.readdirSync(path.dirname(stateFile));
  assert.ok(dirEntries.some((name) => name.startsWith("state.json.corrupt-")));
  assert.equal(fs.existsSync(stateFile), false);
});

test("loadState returns default state when the file is missing", () => {
  const workspace = makeTempDir();
  const state = loadState(workspace);
  assert.equal(state.version, 1);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(state.config, {});
});

test("withStateLock removes a lock whose owner process is gone", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");
  fs.writeFileSync(lockPath, "999999\n", "utf8");

  const startedAt = Date.now();
  const result = withStateLock(workspace, () => "ran", { processExistsImpl: () => false });

  assert.equal(result, "ran");
  assert.ok(Date.now() - startedAt < 1000, "a dead lock must not consume the retry budget");
  assert.equal(fs.existsSync(lockPath), false);
});

test("withStateLock removes a lock with no owner pid once it is older than the stale window", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");
  fs.writeFileSync(lockPath, "", "utf8");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);

  const result = withStateLock(workspace, () => "ran");

  assert.equal(result, "ran");
  assert.equal(fs.existsSync(lockPath), false);
});

test("withStateLock keeps waiting on a fresh lock held by a live process", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");
  fs.writeFileSync(lockPath, `${process.pid}\n`, "utf8");

  assert.throws(() => withStateLock(workspace, () => "ran"), /Timed out acquiring state lock/);
  assert.equal(fs.existsSync(lockPath), true);
});

test("withStateLock records the owner pid while the lock is held", () => {
  const workspace = makeTempDir();
  const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");

  const seen = withStateLock(workspace, () => fs.readFileSync(lockPath, "utf8").trim());

  assert.equal(seen, String(process.pid));
  assert.equal(fs.existsSync(lockPath), false);
});
