# Changelog

## 2026-10-28

- Replaced the regtest/CLN proof with a standalone mainnet card-to-Lightning driver for the existing SwapKit v2 corridor, Nuri approval flow, and AID3 signer (`src/driver.js`, `src/card-wallet.js`, `src/card-host.js`).
- Added exact invoice/order/amount binding, dry-run/execute gates, durable pre-funding recovery JSON, idempotent funding reconciliation, and receipt/explorer evidence (`src/invoice.js`, `src/journal.js`, `src/driver.js`).
- Added synthetic replay, crash, solver-refund, wrong-network, mismatch, preimage, and AID3 bridge tests; cloud orb `orb-bf5ff782c6e8` passed all 10 tests (`test/driver.test.js`, `test/card-host.test.js`).
- Added parent dry-run/live commands and named all unverified live boundaries (`docs/PARENT_COMMANDS.md`, `README.md`).
