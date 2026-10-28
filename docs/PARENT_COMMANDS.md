# Parent commands

No command below was run against production by the builder. Replace every placeholder with the intended fresh mainnet invoice and existing account's public configuration. Keep the same journal for every retry and use a separate journal per card/account.

```bash
ROOT=/Users/eminmahrt/Developer/nuri-bitcoin-arkade-lightning-router-0conf/.worktrees/subagent-sa-0-358e95af/.worktrees/subagent-sa-0-ef53af29
cd "$ROOT"
npm ci
mkdir -p .run
cp config/card-mainnet.example.json .run/card.json
# Edit .run/card.json: existing SwapKit owner EOA, card/server pubkeys,
# existing credential/profile/rpId/origin. No PIN or private key in this file.

CONFIG="$ROOT/.run/card.json"
JOURNAL="$ROOT/.run/card-lightning.journal.json"
INVOICE='lnbc_REPLACE_WITH_FRESH_MAINNET_BOLT11_INVOICE'
AMOUNT_SATS='REPLACE_WITH_EXACT_INVOICE_SATS'

# Read-only production quote; dry by definition.
node cli.js quote --config "$CONFIG" --db "$JOURNAL" \
  --invoice "$INVOICE" --amount-sats "$AMOUNT_SATS"

# Dry-run create: prints the exact commit request; creates no order.
node cli.js create --config "$CONFIG" --db "$JOURNAL" \
  --invoice "$INVOICE" --amount-sats "$AMOUNT_SATS"

# LIVE order creation (no Ark funding yet).
node cli.js create --config "$CONFIG" --db "$JOURNAL" \
  --invoice "$INVOICE" --amount-sats "$AMOUNT_SATS" --execute

# Copy the full orderId from that receipt.
ORDER_ID='ord_REPLACE_WITH_FULL_RETURNED_ORDER_ID'

# Dry-run funding: no intent, card access, signature, or wallet.send.
node cli.js finalize --config "$CONFIG" --db "$JOURNAL" \
  --invoice "$INVOICE" --amount-sats "$AMOUNT_SATS" --order-id "$ORDER_ID"

# Parent supplies both PINs through its secret prompt/environment, never argv/logs.
export FIDO2_BACKUP_PIN NURI_CARD_PIN

# LIVE card approval and one Ark funding send; replay reconciles instead of re-sending.
node cli.js finalize --config "$CONFIG" --db "$JOURNAL" \
  --invoice "$INVOICE" --amount-sats "$AMOUNT_SATS" --order-id "$ORDER_ID" --execute

# Read-only status/evidence refresh; repeat in the parent's serial loop.
node cli.js track --config "$CONFIG" --db "$JOURNAL" \
  --invoice "$INVOICE" --amount-sats "$AMOUNT_SATS" --order-id "$ORDER_ID"
```

Cloud/unit verification command (not a live proof):

```bash
npm test
```

If a retry returns `FUNDING_ALREADY_STARTED`, do not create another order or journal. Run `finalize --execute` with the same invoice, amount, order id, and journal: the started path resolves the existing VTXO without another send (`src/driver.js:167-178`). `FUNDING_UNKNOWN` means no unique matching VTXO was found, not that funding failed or succeeded (`src/driver.js:170-174`).
