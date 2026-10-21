# Replay Guard Server Example

Express.js server that runs a paid handler at most once per payment authorization.

The middleware verifies a payment, runs the handler, then settles. Verification does not consume the authorization; settlement does. So one signed payment sent several times at once passes verification every time, and the handler runs for each copy. The facilitator settles only one, and the other copies get a 402, so no one receives a free response. But every side effect in the handler (a model call, a queued job, an onchain transaction) happens once per copy. See [#1169](https://github.com/x402-foundation/x402/issues/1169) for the wider verify-to-settle race.

This example closes the duplicate-copy case with an `onAfterVerify` hook (abridged from [`index.ts`](./index.ts)):

```typescript
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .onAfterVerify(async ({ paymentPayload, requirements, result }) => {
    if (!result.isValid) return;
    const key = claimKey(paymentPayload, requirements);
    if (!key) return;
    if (claims.has(key)) {
      return { abort: true, reason: "payment_replayed", message: "..." };
    }
    claims.set(key, Date.now());
  });
```

The claim key identifies the authorization rather than the header bytes, so a re-encoded copy still matches:

| Payload | Key |
| --- | --- |
| EIP-3009 (`authorization`) | network, asset, `from`, `nonce` (the token contract accepts each nonce from a signer once) |
| Permit2 (`permit2Authorization`) | network, `from`, `nonce` (Permit2 nonces are per owner, across tokens) |

Claims are made only after the facilitator reports the payment valid, so an invalid payment never takes a claim.

This complements the [`payment-identifier`](../payment-identifier/) example rather than replacing it. That example caches a response after settlement under an ID the client chooses, which serves retries. Copies that arrive before the first one settles are not cached yet, and a client can omit the ID.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- Valid EVM address for receiving payments (Base Sepolia)

## Setup

1. Copy `.env-local` to `.env` and fill in:

- `EVM_ADDRESS` - Ethereum address to receive payments
- `FACILITATOR_URL` - Facilitator endpoint URL

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd servers/replay-guard
```

3. Run the server:

```bash
pnpm dev
```

Pay `GET http://localhost:4021/report` with any client example, then send the same `PAYMENT-SIGNATURE` header again. The second request returns 402 with `payment_replayed`, and the handler log shows one run.

## Production Considerations

- **Shared store.** The in-memory `Map` is atomic within one process. With several instances, claim with an atomic insert in a shared store: Redis `SET key 1 NX EX <ttl>`, or a unique index.
- **TTL.** Keep claims longer than the route's `maxTimeoutSeconds` plus your slowest handler run; after that the authorization has expired.
- **Store outages.** If the store is unreachable, let the request through. The facilitator still refuses a second settlement, so this degrades to the unguarded behaviour instead of blocking paying clients. A hook that throws is logged and skipped by the resource server, which has the same effect.
- **Retries.** A client that retries with the same signature after a failed handler run is refused; it has to sign a new authorization. The x402 clients do that for each 402.
- **Other schemes.** Key on whatever the scheme makes single-use. For `exact` on Solana, hash the transaction message rather than the whole transaction: the fee payer's signature slot is outside the payer's signature.
