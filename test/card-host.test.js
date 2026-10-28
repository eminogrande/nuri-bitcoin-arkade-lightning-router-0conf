import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AID3, CardHostBridge } from "../src/card-host.js";

const fakeSigner = `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const record = { args, aid: process.env.NURI_MUSIG2_AID || null };
const contextIndex = args.indexOf("--context-file");
if (contextIndex >= 0) record.context = JSON.parse(readFileSync(args[contextIndex + 1], "utf8"));
appendFileSync(process.env.SYNTHETIC_CARD_CAPTURE, JSON.stringify(record) + "\\n");
if (args[0] === "webauthn-assert") {
  console.log(JSON.stringify({ client_data_b64u: "client", auth_data_b64u: "auth", sig_b64u: "sig" }));
} else {
  console.log(JSON.stringify({ final_signature_verified: true, final_signature64: "ab".repeat(64) }));
}
`;

test("AID3 host bridge reuses sign-input-send without PIN argv and cleans context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nuri-card-host-test-"));
  try {
    const script = join(directory, "fake-card.mjs");
    const capture = join(directory, "capture.jsonl");
    await writeFile(script, fakeSigner);
    await writeFile(capture, "");
    process.env.SYNTHETIC_CARD_CAPTURE = capture;
    const bridge = new CardHostBridge({
      python: process.execPath, prfScript: script, claimSigner: script,
      cosignUrl: "https://synthetic.invalid/cosign", serverPk33: "02server", cardPk33: "02card",
      credProfile: "synthetic-profile", rpId: "synthetic.invalid", origin: "https://synthetic.invalid", credId: "cred",
    }, directory);
    const signature = await bridge.signInputSend({
      msg32: "00".repeat(32), inputIndex: 2,
      context: { aggregate33: "02aggregate", send_package: { synthetic: true }, assertion: null },
    });
    assert.equal(signature, "ab".repeat(64));
    await bridge.webAuthnAssert("synthetic-challenge");
    const calls = (await readFile(capture, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].aid, AID3);
    assert.equal(calls[0].args[0], "sign-input-send");
    assert.equal(calls[0].args[calls[0].args.indexOf("--input-index") + 1], "2");
    assert.equal(calls[0].context.aggregate33, "02aggregate");
    const contextFile = calls[0].args[calls[0].args.indexOf("--context-file") + 1];
    await assert.rejects(access(contextFile));
    assert.equal(calls[1].args[0], "webauthn-assert");
    assert.ok(calls.every((call) => !call.args.includes("--pin") && !call.args.some((arg) => arg.startsWith("--pin="))));
  } finally {
    delete process.env.SYNTHETIC_CARD_CAPTURE;
    await rm(directory, { recursive: true, force: true });
  }
});
