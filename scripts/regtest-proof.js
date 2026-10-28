#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    RestArkProvider,
    RestIndexerProvider,
    SingleKey,
} from "@arkade-os/sdk";
import { ArkadeVhtlc } from "../src/arkade.js";
import { ClnAdapter } from "../src/cln.js";
import { Journal } from "../src/journal.js";
import { SwapEngine, normalizeRequest } from "../src/swap.js";
import { reconstructVhtlc } from "../src/vhtlc.js";

function usage() {
    return "usage: npm run proof:regtest -- <config.json> [--execute]";
}

async function main() {
    const args = process.argv.slice(2);
    const execute = args.includes("--execute");
    const configArgs = args.filter((arg) => arg !== "--execute");
    if (configArgs.length !== 1 || configArgs[0].startsWith("--")) {
        throw new Error(usage());
    }
    const configPath = resolve(configArgs[0]);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const normalized = normalizeRequest(config.request);
    const binding = reconstructVhtlc(
        config.request.vhtlc,
        normalized.quote.paymentHash,
    );
    if (!execute) {
        console.log(
            JSON.stringify(
                {
                    mode: "dry",
                    liveProof: false,
                    network: "regtest",
                    paymentHash: normalized.quote.paymentHash,
                    amountMsat: normalized.quote.amountMsat,
                    invoiceExpiresAt: normalized.quote.expiresAt,
                    outpoint: normalized.outpoint,
                    vhtlcAddress: binding.address,
                    vhtlcPkScript: binding.pkScript,
                    wouldDo: [
                        "call real CLN getinfo and decode",
                        "fetch the real indexer VTXO and Ark server info",
                        "persist the unsigned SDK transaction digest before xpay",
                        "call real CLN xpay once and reconcile with listpays",
                        "claim through real Ark submitTx/sign/finalizeTx after a valid preimage",
                    ],
                    note: "No RPC, database write, signing, payment, or Ark submission was performed. Re-run with --execute for the real regtest proof.",
                },
                null,
                2,
            ),
        );
        return;
    }

    if (!config.dbPath || !config.arkUrl) {
        throw new Error("execute mode requires config.dbPath and config.arkUrl");
    }
    const receiverPrivateKey = process.env.RECEIVER_PRIVATE_KEY_HEX;
    if (!receiverPrivateKey) {
        throw new Error("execute mode requires RECEIVER_PRIVATE_KEY_HEX");
    }
    const receiverIdentity = SingleKey.fromHex(receiverPrivateKey);
    const clnConfig = config.cln || {};
    const cln = new ClnAdapter({
        cliPath: clnConfig.cliPath || "lightning-cli",
        lightningDir: clnConfig.lightningDir,
        network: "regtest",
    });
    const arkProvider = new RestArkProvider(config.arkUrl);
    const indexerProvider = new RestIndexerProvider(config.indexerUrl || config.arkUrl);
    const arkade = new ArkadeVhtlc({ arkProvider, indexerProvider, receiverIdentity });
    const journal = new Journal(resolve(config.dbPath));
    try {
        const engine = new SwapEngine({ journal, cln, arkade });
        const result = await engine.execute(config.request);
        console.log(JSON.stringify({ mode: "execute", network: "regtest", result }, null, 2));
        if (result.state !== "completed") {
            process.exitCode = 2;
        }
    } finally {
        journal.close();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ mode: "error", liveProof: false, error: error.message }));
    process.exitCode = 1;
});
