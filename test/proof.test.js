import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { makeFixture } from "./fixtures.js";

const proofScript = resolve("scripts/regtest-proof.js");

function proofConfig(t) {
    const dir = mkdtempSync(join(tmpdir(), "arkade-cln-proof-entry-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return { dir, dbPath: join(dir, "proof.sqlite"), configPath: join(dir, "config.json") };
}

test("regtest proof is dry by default and performs no RPC or database write", async (t) => {
    const fixture = await makeFixture();
    const { dbPath, configPath } = proofConfig(t);
    writeFileSync(
        configPath,
        JSON.stringify({
            dbPath,
            arkUrl: "http://127.0.0.1:9",
            request: fixture.request,
        }),
    );
    const stdout = execFileSync(
        process.execPath,
        ["--experimental-sqlite", proofScript, configPath],
        { encoding: "utf8", env: { ...process.env, RECEIVER_PRIVATE_KEY_HEX: "" } },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.mode, "dry");
    assert.equal(result.liveProof, false);
    assert.equal(result.paymentHash, fixture.paymentHash);
    assert.equal(result.vhtlcAddress, fixture.terms.address);
    assert.equal(existsSync(dbPath), false);
});

test("--execute reaches the real-entry credential gate rather than simulating success", async (t) => {
    const fixture = await makeFixture();
    const { dbPath, configPath } = proofConfig(t);
    writeFileSync(
        configPath,
        JSON.stringify({
            dbPath,
            arkUrl: "http://127.0.0.1:9",
            request: fixture.request,
        }),
    );
    const env = { ...process.env };
    delete env.RECEIVER_PRIVATE_KEY_HEX;
    const run = spawnSync(
        process.execPath,
        ["--experimental-sqlite", proofScript, configPath, "--execute"],
        { encoding: "utf8", env },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /RECEIVER_PRIVATE_KEY_HEX/);
    assert.equal(existsSync(dbPath), false);
    assert.doesNotMatch(run.stdout, /completed/);
});
