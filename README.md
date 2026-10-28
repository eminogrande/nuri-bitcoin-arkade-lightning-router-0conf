# Arkade VHTLC → Core Lightning fronter POC

Minimal **regtest-only** outgoing VHTLC fronter using the pinned official SDK and Node builtins (`package.json:6-16`, `src/cln.js:7-23`). It reconstructs the VHTLC, pays a real CLN invoice only through the real entrypoint, reconciles through `listpays`, and claims with the receiver preimage through the SDK call sequence (`src/arkade.js:56-183`, `src/cln.js:25-77`).

## Honest status

- **Unit evidence:** the cloud suite has exercised hash/address binding, invoice rejection, restart conflicts, settlement recovery, failed-payment handling, dry-run gating, and the real SDK build/sign/submit/sign/finalize sequence with explicit fake providers (`test/vhtlc.test.js:12-48`, `test/swap.test.js:16-304`, `test/proof.test.js:17-63`). Latest result: **18 tests, 18 passed, 0 failed** on `ubuntu-8gb-agentbox`, Node `v22.23.2`.
- **Live regtest proof:** **NOT RUN**. No real arkd, indexer, CLN payment, VTXO claim, or refund is claimed by this repository change. The execute path wires real CLN and SDK REST providers rather than test fakes (`scripts/regtest-proof.js:4-13`, `scripts/regtest-proof.js:62-89`).
- **Refund boundary:** a definitive CLN failure becomes `refund_pending`; this POC does not sign or broadcast the sender's refund and never labels that state `refunded` (`src/swap.js:253-260`, `src/arkade.js:134-183`). The sender refund remains outside this minimal receiver-claim slice.

## Flow

The diagram is a summary of the quote checks, durable reservation, CLN reconciliation, and SDK claim implemented at `src/swap.js:81-321`, `src/arkade.js:56-183`, and `src/journal.js:36-180`.

```mermaid
sequenceDiagram
    participant Q as Caller
    participant E as Swap engine
    participant J as SQLite journal
    participant A as Ark indexer + arkd
    participant C as Core Lightning
    Q->>E: Exact quote + VHTLC terms + outpoint
    E->>C: getinfo + decode(invoice)
    E->>A: getVtxos + getInfo
    E->>E: Reconstruct VHTLC; build unsigned claim
    E->>J: funded + unique outpoint/payment_hash + tx digest
    E->>J: settling before payment
    E->>C: xpay(invoice) once
    E->>C: listpays(payment_hash)
    alt Complete with valid preimage
        E->>J: claiming + preimage
        E->>A: submitTx; sign checkpoints; finalizeTx
        E->>J: completed
    else Definitive failed
        E->>J: refund_pending (not refunded)
    else Pending, empty, or unavailable
        E->>J: settlement_unknown (no repay/refund)
    end
```

## Binding and recovery invariants

1. The 20-byte VHTLC value is `RIPEMD160(payment_hash)`, which equals `HASH160(preimage)` because `payment_hash = SHA256(preimage)`. It is **not** `HASH160(payment_hash)`. The claim path checks both the BOLT11 preimage hash and this VHTLC relation before signing (`src/vhtlc.js:10-22`, `src/vhtlc.js:107-120`; tested at `test/vhtlc.test.js:12-25`).
2. Invoice digest, valid BOLT11 type, payment hash, whole-satoshi amount, `bcrt` currency, and absolute expiry must match before payment; expired invoices are rejected (`src/swap.js:16-67`, `src/swap.js:81-120`). The VHTLC address is recomputed with `VHTLC.Script`, and the indexer VTXO must have the same script and exact amount (`src/vhtlc.js:66-105`, `src/arkade.js:56-94`).
3. `buildOffchainTx` and the canonical PSBT digest are completed before the journal's `funded` reservation and before `xpay`; signing later rechecks that digest (`src/arkade.js:98-124`, `src/arkade.js:142-150`, `src/swap.js:115-139`). SQLite enforces payment-hash primary-key and outpoint uniqueness with WAL and `synchronous=FULL` (`src/journal.js:41-72`).
4. Only `funded` can enter the one payment dispatch, and `settling` is committed before `xpay` (`src/swap.js:176-188`). A retry in `settling` or `settlement_unknown` calls `listpays`, not `xpay`; a matching completed amount and valid preimage are required before claiming (`src/swap.js:142-158`, `src/swap.js:190-252`).
5. `settlement_unknown` has no automatic refund or repayment path. Only an all-failed `listpays` result enters `refund_pending`; pending, empty, unavailable, or otherwise non-definitive results remain unknown (`src/swap.js:190-205`, `src/swap.js:253-273`, `test/swap.test.js:209-232`).
6. The receiver claim uses `ConditionWitness([preimage])`, `submitTx`, checkpoint signatures, and `finalizeTx`; `completed` is written only after `finalizeTx` returns (`src/arkade.js:134-183`, `src/swap.js:275-318`). The unit provider is explicit and fake, while the SDK construction/signing calls and condition-witness assertions are real (`test/swap.test.js:33-76`, `test/swap.test.js:267-304`).

## Install and unit-test

Requires Node `>=22.12.0 <25` (`package.json:7-9`).

```bash
npm ci
npm test
```

The proof entrypoint is dry by default and performs no RPC, database write, signing, payment, or Ark submission without `--execute` (`scripts/regtest-proof.js:19-60`; tested at `test/proof.test.js:17-39`).

## Real regtest proof — still required

**UNVERIFIED:** no live environment or live result was supplied. A live proof still needs all of the following:

1. An isolated regtest arkd/indexer and a real regtest CLN with `lightning-cli` access and a route to the invoice payee. The engine verifies CLN `getinfo.network`, Ark `getInfo().network`, and invoice currency before paying (`src/swap.js:93-113`, `src/arkade.js:84-97`).
2. A spendable VTXO at the reconstructed VHTLC address, with the exact invoice value and the requested outpoint; no multi-VTXO or fee subsidy is implemented (`src/arkade.js:56-131`).
3. A persistent SQLite path and the receiver private key matching `vhtlc.receiver`; the key is supplied at execution time and checked before payment (`scripts/regtest-proof.js:62-82`, `src/arkade.js:49-54`).
4. A JSON config with `dbPath`, `arkUrl`, optional `indexerUrl`, optional `cln.cliPath`/`cln.lightningDir`, and a `request` containing `quote`, `vhtlc`, and `outpoint` (`scripts/regtest-proof.js:26-32`, `scripts/regtest-proof.js:62-82`, `src/swap.js:16-53`). The quote must contain the exact `invoice`, its SHA-256 `invoiceDigest`, `paymentHash`, `amountMsat`, `expiresAt`, and `network: "regtest"` (`src/swap.js:16-53`).

Dry-run first:

```bash
npm run proof:regtest -- /path/to/regtest-config.json
```

Then arm the real path explicitly:

```bash
RECEIVER_PRIVATE_KEY_HEX=<64-hex-regtest-key> \
  npm run proof:regtest -- /path/to/regtest-config.json --execute
```

A non-`completed` execute result exits nonzero rather than presenting a successful proof (`scripts/regtest-proof.js:80-89`). Independently inspect `listpays`, the returned Ark transaction id, and indexer ownership before calling any run successful. Crash recovery around real Ark `submitTx`/`finalizeTx`, real sender refund execution, and a real end-to-end preimage claim remain **UNVERIFIED** until such outputs exist.
