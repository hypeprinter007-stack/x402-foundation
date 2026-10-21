import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { isEIP3009Payload, isPermit2Payload, type ExactEvmPayloadV2 } from "@x402/evm";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const facilitatorUrl = process.env.FACILITATOR_URL;
if (!evmAddress || !facilitatorUrl) {
  console.error("❌ EVM_ADDRESS and FACILITATOR_URL environment variables are required");
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Must outlive the route's maxTimeoutSeconds plus the slowest handler run.
// In-memory claims are atomic within one process; with several instances use a
// shared store with an atomic insert (Redis SET NX EX, a unique index).
const CLAIM_TTL_MS = 15 * 60 * 1000;
const claims = new Map<string, number>();

/**
 * Identifies the authorization a payment carries, so a copy of the same signed
 * payment maps to the same key however its JSON is encoded.
 *
 * @param payload - the verified payment payload
 * @param requirements - the requirements it was verified against
 * @returns claim key, or undefined if the payload carries no nonce
 */
function claimKey(payload: PaymentPayload, requirements: PaymentRequirements): string | undefined {
  const evm = payload.payload as ExactEvmPayloadV2;
  if (isPermit2Payload(evm)) {
    // Permit2 nonces are scoped to the owner, across tokens.
    const { from, nonce } = evm.permit2Authorization;
    return `${requirements.network}:permit2:${from.toLowerCase()}:${nonce}`;
  }
  if (isEIP3009Payload(evm)) {
    // EIP-3009 nonces are scoped to the token contract and the signer.
    const { from, nonce } = evm.authorization;
    return `${requirements.network}:${requirements.asset.toLowerCase()}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
  }
  return undefined;
}

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  // Verify does not consume the authorization; settlement does. Until then one
  // signed payment verifies as often as it is sent, and each copy would run the
  // handler. Claiming here, after verification and before the handler, lets
  // exactly one copy through. Only valid payments are claimed.
  .onAfterVerify(async ({ paymentPayload, requirements, result }) => {
    if (!result.isValid) return;
    const key = claimKey(paymentPayload as PaymentPayload, requirements as PaymentRequirements);
    if (!key) return;
    const now = Date.now();
    const claimedAt = claims.get(key);
    if (claimedAt !== undefined && now - claimedAt < CLAIM_TTL_MS) {
      return {
        abort: true,
        reason: "payment_replayed",
        message: "This payment authorization was already presented. Sign a new one.",
      };
    }
    claims.set(key, now);
  });

setInterval(() => {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  for (const [key, claimedAt] of claims) if (claimedAt < cutoff) claims.delete(key);
}, 60 * 1000).unref();

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /report": {
        accepts: [{ scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: evmAddress }],
        description: "A report that is expensive to produce",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

let runs = 0;
app.get("/report", (_req, res) => {
  runs++;
  console.log(`[handler] run #${runs}`);
  res.json({ report: "generated", run: runs });
});

app.listen(4021, () => {
  console.log("Replay-guard example server listening at http://localhost:4021");
});
