import {
    CSVMultisigTapscript,
    ConditionWitness,
    Transaction,
    buildOffchainTx,
    getArkPsbtFields,
    setArkPsbtField,
} from "@arkade-os/sdk";
import {
    digestJson,
    expectHex,
    expectVariableHex,
    normalizeOutpoint,
    outpointKey,
    parseMsat,
} from "./util.js";
import { reconstructVhtlc, verifyPreimage } from "./vhtlc.js";

export function claimTxDigest(plan) {
    if (
        !plan ||
        typeof plan.arkTx !== "string" ||
        !Array.isArray(plan.checkpoints) ||
        plan.checkpoints.some((value) => typeof value !== "string")
    ) {
        throw new Error("invalid claim plan");
    }
    return digestJson({ arkTx: plan.arkTx, checkpoints: plan.checkpoints });
}

function fromPsbt(encoded) {
    return Transaction.fromPSBT(Buffer.from(encoded, "base64"), { allowUnknown: true });
}

function toPsbt(transaction) {
    return Buffer.from(transaction.toPSBT()).toString("base64");
}

export class ArkadeVhtlc {
    constructor({ arkProvider, indexerProvider, receiverIdentity }) {
        if (!arkProvider || !indexerProvider || !receiverIdentity) {
            throw new Error("arkProvider, indexerProvider, and receiverIdentity are required");
        }
        this.arkProvider = arkProvider;
        this.indexerProvider = indexerProvider;
        this.receiverIdentity = receiverIdentity;
    }

    async assertReceiver(terms) {
        const receiver = Buffer.from(await this.receiverIdentity.xOnlyPublicKey()).toString("hex");
        if (receiver !== terms.receiver) {
            throw new Error("receiver identity does not match the VHTLC receiver key");
        }
    }

    async prepare({ terms: rawTerms, paymentHash, amountMsat, outpoint: rawOutpoint }) {
        const binding = reconstructVhtlc(rawTerms, paymentHash);
        const outpoint = normalizeOutpoint(rawOutpoint);
        const normalizedAmount = parseMsat(amountMsat);
        const response = await this.indexerProvider.getVtxos({
            scripts: [binding.pkScript],
            spendableOnly: true,
        });
        if (!response || !Array.isArray(response.vtxos)) {
            throw new Error("indexer getVtxos response has no vtxos array");
        }
        const matches = response.vtxos.filter(
            (vtxo) => vtxo.txid === outpoint.txid && vtxo.vout === outpoint.vout,
        );
        if (matches.length !== 1) {
            throw new Error(`expected one spendable VTXO for ${outpointKey(outpoint)}`);
        }
        const vtxo = matches[0];
        if (vtxo.script?.toLowerCase() !== binding.pkScript) {
            throw new Error("indexer VTXO script does not match the reconstructed VHTLC");
        }
        if (vtxo.isSpent || vtxo.isSwept || vtxo.spentBy) {
            throw new Error("indexer VTXO is not spendable");
        }
        if (BigInt(vtxo.value) * 1000n !== BigInt(normalizedAmount)) {
            throw new Error("VTXO value does not exactly match the invoice amount");
        }

        const info = await this.arkProvider.getInfo();
        if (info.network !== "regtest") {
            throw new Error(`Ark provider network mismatch: ${info.network}`);
        }
        if (expectHex(info.signerPubkey, 32, "Ark signer pubkey") !== binding.terms.server) {
            throw new Error("Ark provider signer does not match the VHTLC server key");
        }
        const checkpointTapscript = expectVariableHex(
            info.checkpointTapscript,
            "Ark checkpoint tapscript",
        );
        const serverUnrollScript = CSVMultisigTapscript.decode(
            Buffer.from(checkpointTapscript, "hex"),
        );
        const { arkTx, checkpoints } = buildOffchainTx(
            [
                {
                    txid: vtxo.txid,
                    vout: vtxo.vout,
                    value: vtxo.value,
                    tapLeafScript: binding.script.claim(),
                    tapTree: binding.script.encode(),
                },
            ],
            [
                {
                    amount: BigInt(vtxo.value),
                    script: binding.script.pkScript,
                },
            ],
            serverUnrollScript,
        );
        const plan = {
            arkTx: toPsbt(arkTx),
            checkpoints: checkpoints.map(toPsbt),
        };
        return {
            binding,
            plan,
            txDigest: claimTxDigest(plan),
            checkpointTapscript,
            vtxo: {
                txid: vtxo.txid,
                vout: vtxo.vout,
                value: String(vtxo.value),
                script: binding.pkScript,
            },
        };
    }

    async claim({
        plan,
        txDigest,
        paymentHash,
        preimage: rawPreimage,
        submission,
        onSubmitted = async () => {},
    }) {
        const preimage = verifyPreimage(rawPreimage, paymentHash);
        if (claimTxDigest(plan) !== txDigest) {
            throw new Error("claim transaction digest mismatch; refusing to sign");
        }
        const preimageBytes = Buffer.from(preimage, "hex");
        const sign = async (transaction, inputIndexes) => {
            const copy = transaction.clone();
            setArkPsbtField(copy, 0, ConditionWitness, [preimageBytes]);
            return this.receiverIdentity.sign(copy, inputIndexes);
        };

        let currentSubmission = submission;
        if (!currentSubmission?.arkTxid) {
            const signedArkTx = await sign(fromPsbt(plan.arkTx));
            const submitted = await this.arkProvider.submitTx(
                toPsbt(signedArkTx),
                plan.checkpoints.map((checkpoint) => fromPsbt(checkpoint)).map(toPsbt),
            );
            if (
                !submitted ||
                typeof submitted.arkTxid !== "string" ||
                !Array.isArray(submitted.signedCheckpointTxs)
            ) {
                throw new Error("Ark submitTx returned an invalid response");
            }
            currentSubmission = {
                arkTxid: submitted.arkTxid,
                signedCheckpointTxs: submitted.signedCheckpointTxs,
            };
            await onSubmitted(currentSubmission);
        }

        const finalCheckpoints = await Promise.all(
            currentSubmission.signedCheckpointTxs.map(async (encoded) => {
                const checkpoint = fromPsbt(encoded);
                const signed = await sign(checkpoint, [0]);
                return toPsbt(signed);
            }),
        );
        await this.arkProvider.finalizeTx(currentSubmission.arkTxid, finalCheckpoints);
        return { arkTxid: currentSubmission.arkTxid };
    }
}

export function readConditionWitness(encoded, inputIndex = 0) {
    return getArkPsbtFields(fromPsbt(encoded), inputIndex, ConditionWitness);
}
