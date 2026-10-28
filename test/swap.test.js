import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArkadeVhtlc, claimTxDigest, readConditionWitness } from "../src/arkade.js";
import { Journal } from "../src/journal.js";
import { SwapEngine } from "../src/swap.js";
import {
    FakeCln,
    NOW,
    completePay,
    makeFixture,
} from "./fixtures.js";

class FakeIndexer {
    constructor(fixture, sequence) {
        this.fixture = fixture;
        this.sequence = sequence;
        this.vtxos = [fixture.vtxo];
    }

    async getVtxos(filter) {
        this.sequence.push("getVtxos");
        assert.deepEqual(filter.scripts, [this.fixture.binding.pkScript]);
        assert.equal(filter.spendableOnly, true);
        return {
            vtxos: this.vtxos.filter((vtxo) => filter.scripts.includes(vtxo.script)),
        };
    }
}

class FakeArkProvider {
    constructor(fixture, sequence) {
        this.fixture = fixture;
        this.sequence = sequence;
        this.arkTxid = "ab".repeat(32);
        this.submitted = [];
        this.finalized = [];
    }

    async getInfo() {
        this.sequence.push("getInfo");
        return this.fixture.info;
    }

    async submitTx(signedArkTx, checkpoints) {
        this.sequence.push("submitTx");
        const conditions = readConditionWitness(signedArkTx);
        this.submitted.push({ signedArkTx, checkpoints, conditions });
        return {
            arkTxid: this.arkTxid,
            finalArkTx: signedArkTx,
            signedCheckpointTxs: checkpoints,
        };
    }

    async finalizeTx(arkTxid, checkpoints) {
        this.sequence.push("finalizeTx");
        this.finalized.push({ arkTxid, checkpoints });
    }
}

function openHarness(fixture, { dbPath, cln = new FakeCln(fixture), sequence = [] } = {}) {
    cln.calls = sequence;
    const journal = new Journal(dbPath);
    const indexer = new FakeIndexer(fixture, sequence);
    const arkProvider = new FakeArkProvider(fixture, sequence);
    const arkade = new ArkadeVhtlc({
        arkProvider,
        indexerProvider: indexer,
        receiverIdentity: fixture.receiverIdentity,
    });
    const engine = new SwapEngine({ journal, cln, arkade, now: () => NOW });
    return { journal, cln, indexer, arkProvider, arkade, engine, sequence };
}

function tempDb(t) {
    const dir = mkdtempSync(join(tmpdir(), "arkade-cln-unit-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "journal.sqlite");
}

test("wrong invoice, hash, amount, network, and expiry are rejected before xpay", async (t) => {
    const cases = [
        {
            name: "invoice digest",
            mutate: (fixture, request) => {
                request.quote.invoiceDigest = "00".repeat(32);
            },
            expected: /invoice does not match quote.invoiceDigest/,
        },
        {
            name: "invoice type",
            mutate: (fixture, _request, cln) => {
                cln.decoded.type = "bolt12 invoice";
            },
            expected: /valid BOLT11 invoice/,
        },
        {
            name: "payment hash",
            mutate: (fixture, _request, cln) => {
                cln.decoded.payment_hash = "ff".repeat(32);
            },
            expected: /payment hash does not match/,
        },
        {
            name: "amount",
            mutate: (fixture, _request, cln) => {
                cln.decoded.amount_msat = "1001000msat";
            },
            expected: /amount does not match/,
        },
        {
            name: "network",
            mutate: (fixture, _request, cln) => {
                cln.decoded.currency = "tb";
            },
            expected: /network does not match regtest/,
        },
        {
            name: "expiry",
            mutate: (fixture, _request, cln) => {
                cln.decoded.expiry += 1;
            },
            expected: /expiry does not match/,
        },
    ];
    for (const item of cases) {
        await t.test(item.name, async (t) => {
            const fixture = await makeFixture();
            const cln = new FakeCln(fixture);
            const request = structuredClone(fixture.request);
            item.mutate(fixture, request, cln);
            const harness = openHarness(fixture, { dbPath: tempDb(t), cln });
            t.after(() => harness.journal.close());
            await assert.rejects(harness.engine.execute(request), item.expected);
            assert.equal(cln.xpayCalls, 0);
            assert.equal(harness.arkProvider.submitted.length, 0);
        });
    }
});

test("conflicting outpoint reservation remains rejected after restart", async (t) => {
    const dbPath = tempDb(t);
    const first = await makeFixture();
    const firstHarness = openHarness(first, {
        dbPath,
        cln: new FakeCln(first, { behavior: "failed" }),
    });
    assert.equal((await firstHarness.engine.execute(first.request)).state, "refund_pending");
    firstHarness.journal.close();

    const second = await makeFixture({ preimageByte: 0x43 });
    const secondCln = new FakeCln(second);
    const secondHarness = openHarness(second, { dbPath, cln: secondCln });
    t.after(() => secondHarness.journal.close());
    await assert.rejects(
        secondHarness.engine.execute(second.request),
        /retry conflicts with the durable outpoint\/payment-hash binding/,
    );
    assert.equal(secondCln.xpayCalls, 0);
    assert.equal(secondHarness.arkProvider.submitted.length, 0);
});

test("crash after LN settlement resumes through listpays without a second xpay", async (t) => {
    const dbPath = tempDb(t);
    const fixture = await makeFixture();
    const firstCln = new FakeCln(fixture, {
        behavior: "crash-after-settlement",
        listPaysFailures: 1,
    });
    const first = openHarness(fixture, { dbPath, cln: firstCln });
    assert.equal((await first.engine.execute(fixture.request)).state, "settlement_unknown");
    assert.equal(firstCln.xpayCalls, 1);
    assert.equal(first.arkProvider.submitted.length, 0);
    first.journal.close();

    const recoveredCln = new FakeCln(fixture, { pays: [completePay(fixture)] });
    const recovered = openHarness(fixture, { dbPath, cln: recoveredCln });
    t.after(() => recovered.journal.close());
    const result = await recovered.engine.execute(fixture.request);
    assert.equal(result.state, "completed");
    assert.equal(result.arkTxid, recovered.arkProvider.arkTxid);
    assert.equal(recoveredCln.xpayCalls, 0);
    assert.deepEqual(recovered.sequence, ["listpays", "submitTx", "finalizeTx"]);
});

test("failed LN payment enters refund_pending and never claims or repays", async (t) => {
    const dbPath = tempDb(t);
    const fixture = await makeFixture();
    const cln = new FakeCln(fixture, { behavior: "failed" });
    const first = openHarness(fixture, { dbPath, cln });
    const failed = await first.engine.execute(fixture.request);
    assert.equal(failed.state, "refund_pending");
    assert.equal(cln.xpayCalls, 1);
    assert.equal(first.arkProvider.submitted.length, 0);
    assert.equal(first.journal.get(fixture.paymentHash).preimage, null);
    first.journal.close();

    const retryCln = new FakeCln(fixture);
    const retry = openHarness(fixture, { dbPath, cln: retryCln });
    t.after(() => retry.journal.close());
    assert.equal((await retry.engine.execute(fixture.request)).state, "refund_pending");
    assert.equal(retryCln.xpayCalls, 0);
    assert.equal(retry.arkProvider.submitted.length, 0);
});

test("settlement_unknown neither auto-refunds nor repays", async (t) => {
    const dbPath = tempDb(t);
    const fixture = await makeFixture();
    const firstCln = new FakeCln(fixture, { behavior: "pending" });
    const first = openHarness(fixture, { dbPath, cln: firstCln });
    assert.equal((await first.engine.execute(fixture.request)).state, "settlement_unknown");
    assert.equal(firstCln.xpayCalls, 1);
    first.journal.close();

    const retryCln = new FakeCln(fixture, {
        pays: [
            {
                payment_hash: fixture.paymentHash,
                status: "pending",
                amount_msat: "1000000msat",
            },
        ],
    });
    const retry = openHarness(fixture, { dbPath, cln: retryCln });
    t.after(() => retry.journal.close());
    assert.equal((await retry.engine.execute(fixture.request)).state, "settlement_unknown");
    assert.equal(retryCln.xpayCalls, 0);
    assert.equal(retry.arkProvider.submitted.length, 0);
});

test("claim plan digest mismatch rejects before receiver signing", async (t) => {
    const fixture = await makeFixture();
    const sequence = [];
    const indexer = new FakeIndexer(fixture, sequence);
    const arkProvider = new FakeArkProvider(fixture, sequence);
    let signCalls = 0;
    const receiverIdentity = {
        xOnlyPublicKey: fixture.receiverIdentity.xOnlyPublicKey.bind(fixture.receiverIdentity),
        sign: async (...args) => {
            signCalls += 1;
            return fixture.receiverIdentity.sign(...args);
        },
    };
    const arkade = new ArkadeVhtlc({ arkProvider, indexerProvider: indexer, receiverIdentity });
    const prepared = await arkade.prepare({
        terms: fixture.terms,
        paymentHash: fixture.paymentHash,
        amountMsat: fixture.request.quote.amountMsat,
        outpoint: fixture.request.outpoint,
    });
    await assert.rejects(
        arkade.claim({
            plan: { ...prepared.plan, arkTx: "AA==" },
            txDigest: prepared.txDigest,
            paymentHash: fixture.paymentHash,
            preimage: fixture.preimageHex,
        }),
        /claim transaction digest mismatch/,
    );
    assert.equal(signCalls, 0);
    assert.equal(arkProvider.submitted.length, 0);
});

test("successful preimage claim follows the real SDK build/sign/submit/sign/finalize sequence", async (t) => {
    const fixture = await makeFixture();
    const cln = new FakeCln(fixture);
    const harness = openHarness(fixture, { dbPath: tempDb(t), cln });
    t.after(() => harness.journal.close());
    cln.xpayHook = () => {
        const row = harness.journal.get(fixture.paymentHash);
        assert.equal(row.state, "settling");
        assert.equal(row.outpoint, `${fixture.request.outpoint.txid}:${fixture.request.outpoint.vout}`);
        assert.equal(row.payment_hash, fixture.paymentHash);
        assert.equal(row.tx_digest, claimTxDigest(row.claimPlan));
    };
    const result = await harness.engine.execute(fixture.request);
    assert.equal(result.state, "completed");
    assert.equal(result.arkTxid, harness.arkProvider.arkTxid);
    assert.deepEqual(harness.sequence, [
        "getinfo",
        "decode",
        "getVtxos",
        "getInfo",
        "xpay",
        "listpays",
        "submitTx",
        "finalizeTx",
    ]);
    assert.equal(harness.arkProvider.submitted.length, 1);
    const conditions = harness.arkProvider.submitted[0].conditions;
    assert.equal(conditions.length, 1);
    assert.equal(conditions[0].length, 1);
    assert.equal(Buffer.from(conditions[0][0]).toString("hex"), fixture.preimageHex);
    assert.equal(harness.arkProvider.finalized.length, 1);
    const finalCheckpoint = harness.arkProvider.finalized[0].checkpoints[0];
    const finalConditions = readConditionWitness(finalCheckpoint);
    assert.equal(Buffer.from(finalConditions[0][0]).toString("hex"), fixture.preimageHex);
    const row = harness.journal.get(fixture.paymentHash);
    assert.equal(row.preimage, fixture.preimageHex);
    assert.equal(row.state, "completed");
});
