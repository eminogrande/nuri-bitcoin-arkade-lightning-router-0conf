# Decisions

## D1 — Use the existing production corridor

- Date: 2026-10-28
- Status: ACTIVE
- Decision: one outgoing card-wallet BOLT11 payment through SwapKit v2 and the existing Nuri approval/card signer; remove the earlier CLN/regtest slice.
- Why: the requested product is a minimal driver for an existing mainnet wallet, not another node or swap protocol.
- Consequence: no CLN, Bitcoin Core, regtest, Boltz, new arkd, or new infrastructure.

## D2 — Durable JSON instead of SQLite

- Date: 2026-10-28
- Status: ACTIVE
- Decision: use mode-0600 JSON with fsync + atomic rename + a fail-closed lock (`src/journal.js:23-67`).
- Why: it satisfies the durable JSON recovery requirement and lets the synthetic suite run in the available Node-20 cloud orb; live SDK execution still requires Node 22.
- Consequence: a crash during a journal write can leave a stale lock that requires inspected manual removal.

## D3 — Track, but do not execute, refunds

- Date: 2026-10-28
- Status: ACTIVE
- Decision: map solver failure to `REFUND_READY` or `REFUND_PENDING`; never label it paid and never sign a refund in this scoped driver (`src/driver.js:207-216`).
- Why: the requested scope is one outgoing payment, with explicit solver failure/refund evidence rather than a generic swap framework.
- Consequence: refund signing remains a separate live operation and is UNVERIFIED here.
