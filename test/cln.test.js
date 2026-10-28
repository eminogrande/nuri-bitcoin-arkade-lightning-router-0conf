import assert from "node:assert/strict";
import { test } from "node:test";
import { ClnAdapter } from "../src/cln.js";

test("real CLN adapter issues decode/xpay/listpays CLI commands with exact bindings", async () => {
    const calls = [];
    const responses = [
        { network: "regtest" },
        { payment_hash: "ab".repeat(32) },
        { payment_hash: "ab".repeat(32), status: "complete" },
        { pays: [] },
    ];
    const adapter = new ClnAdapter({
        lightningDir: "/tmp/cln-regtest",
        exec: async (file, args) => {
            calls.push({ file, args });
            return { stdout: JSON.stringify(responses[calls.length - 1]) };
        },
    });
    await adapter.getInfo();
    await adapter.decode("lnbcrt1invoice");
    await adapter.xpay("lnbcrt1invoice", "1000");
    await adapter.listPays("ab".repeat(32));
    assert.equal(calls.length, 4);
    for (const call of calls) {
        assert.equal(call.file, "lightning-cli");
        assert.deepEqual(call.args.slice(0, 2), [
            "--network=regtest",
            "--lightning-dir=/tmp/cln-regtest",
        ]);
    }
    assert.deepEqual(calls[1].args.slice(2), ["decode", "lnbcrt1invoice"]);
    assert.deepEqual(calls[2].args.slice(2), ["xpay", "lnbcrt1invoice"]);
    assert.deepEqual(calls[3].args.slice(2), ["listpays", `payment_hash=${"ab".repeat(32)}`]);
    assert.throws(() => new ClnAdapter({ network: "bitcoin" }), /only permits the regtest/);
});
