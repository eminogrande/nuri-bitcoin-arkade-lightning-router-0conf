import assert from "node:assert/strict";
import { test } from "node:test";
import { VHTLC } from "@arkade-os/sdk";
import { hash160 } from "../src/util.js";
import {
    preimageHashForPaymentHash,
    reconstructVhtlc,
    verifyPreimage,
} from "../src/vhtlc.js";
import { makeFixture } from "./fixtures.js";

test("BOLT11 SHA256 and VHTLC HASH160 bind to the exact SDK address", async () => {
    const fixture = await makeFixture();
    const paymentHashDigest = preimageHashForPaymentHash(fixture.paymentHash);
    assert.equal(paymentHashDigest.length, 20);
    assert.equal(paymentHashDigest.toString("hex"), hash160(fixture.preimage).toString("hex"));
    assert.equal(fixture.binding.preimageHash, paymentHashDigest.toString("hex"));
    assert.equal(fixture.binding.address, fixture.terms.address);
    assert.equal(fixture.binding.pkScript, Buffer.from(fixture.binding.script.pkScript).toString("hex"));
    assert.equal(verifyPreimage(fixture.preimageHex, fixture.paymentHash), fixture.preimageHex);
    assert.throws(
        () => verifyPreimage(Buffer.alloc(32, 0x43).toString("hex"), fixture.paymentHash),
        /does not match the BOLT11 payment hash/,
    );
});

test("wrong VHTLC address and 32-byte preimageHash are rejected", async () => {
    const fixture = await makeFixture();
    const wrongAddress = `${fixture.terms.address.slice(0, -1)}${fixture.terms.address.endsWith("a") ? "b" : "a"}`;
    assert.throws(
        () => reconstructVhtlc({ ...fixture.terms, address: wrongAddress }, fixture.paymentHash),
        /VHTLC address mismatch/,
    );
    assert.throws(
        () =>
            new VHTLC.Script({
                sender: Buffer.from(fixture.terms.sender, "hex"),
                receiver: Buffer.from(fixture.terms.receiver, "hex"),
                server: Buffer.from(fixture.terms.server, "hex"),
                preimageHash: Buffer.from(fixture.paymentHash, "hex"),
                refundLocktime: 1000n,
                unilateralClaimDelay: { type: "blocks", value: 100n },
                unilateralRefundDelay: { type: "blocks", value: 102n },
                unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 103n },
            }),
        /preimage hash must be 20 bytes/,
    );
});
