import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PaymentFlow, type Step } from "@/app/components/PaymentFlow";

export const metadata = { title: "VaultRadar — how a request flows" };

const NODES = ["buyer", "service", "facilitator", "chain", "HCS"];

/**
 * The Hedera rail's round trip, step for step. The Arc rail differs in two places, noted in
 * the last card and in the README — Circle's Gateway verifies *and settles* before the
 * handler runs, so on that rail the checks that can reject a request all happen pre-payment.
 */
const STEPS: Step[] = [
  {
    label: "Discover",
    detail: "The buyer fetches the agent card, verifies its ML-DSA-65 signature, and compares the published key hash against the ERC-8004 registry on chain.",
    edge: [0, 1],
    tone: "neutral",
  },
  {
    label: "Quote",
    detail: "A POST carries the request sealed to the service's KEM key. The middleware reads the vault count from the clear header and answers 402 with the price for exactly that many vaults.",
    edge: [1, 0],
    tone: "warn",
  },
  {
    label: "Pay",
    detail: "The buyer checks the demanded amount against its own quote, signs a transfer naming the facilitator as fee payer, and retries with PAYMENT-SIGNATURE.",
    edge: [0, 1],
    tone: "warn",
  },
  {
    label: "Verify",
    detail: "The service asks the facilitator to verify the signed transfer. On this rail nothing runs until verification succeeds, and settlement follows the handler's 2xx.",
    edge: [1, 2],
    tone: "neutral",
  },
  {
    label: "Answer",
    detail: "The handler opens the envelope, runs the Graph queries, scores every vault, signs one attestation per vault, seals the body to the buyer's ephemeral key and signs the receipt.",
    edge: [1, 3],
    tone: "ok",
  },
  {
    label: "Settle",
    detail: "The facilitator submits the transfer; the response carries the transaction id. On Arc the order differs: Circle's Gateway settles before the handler, which is why every rejectable check there runs pre-payment.",
    edge: [2, 3],
    tone: "ok",
  },
  {
    label: "Commit",
    detail: "The receipt hash and its signature are enqueued to a Hedera Consensus Service topic. Only the hash goes on the public log, so the audit trail cannot leak what anyone asked about.",
    edge: [1, 4],
    tone: "neutral",
  },
  {
    label: "Open",
    detail: "The buyer opens the sealed reply, verifies the receipt and every attestation against the key it pinned, applies its own age check to the signed timestamps, and decides.",
    edge: [0, 1],
    tone: "ok",
  },
];

export default function FlowPage() {
  return (
    <>
      <section className="hero">
        <h1>How one request flows</h1>
        <p className="lede">
          Eight steps from a buyer deciding to look at a vault to a decision it can act on. Drag to orbit; click a step
          to stop the animation there.
        </p>
        <div className="row">
          <Button asChild variant="outline" size="sm">
            <Link href="/docs">All documentation</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/runs/demo-run-1">See a real run</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/verify">Verify a receipt</Link>
          </Button>
        </div>
      </section>

      <PaymentFlow nodes={NODES} steps={STEPS} />

      <section className="stack">
        <h3>What is private, and from whom</h3>
        <p className="muted">
          The buyer&rsquo;s vault list is sealed to the service&rsquo;s hybrid KEM key before it leaves, so no
          intermediary on the path learns which vaults were asked about. The service decrypts it — unless the policy
          chose the <code>table</code> tier, which buys every vault of one protocol and filters locally, so the vendor
          never learns which one mattered either.
        </p>
        <p className="muted">
          What goes on chain is a hash and a signature. The receipt itself stays with the buyer, and anyone holding it
          can check the service&rsquo;s key against the registry and the receipt&rsquo;s hash against{" "}
          <code>/v1/receipts/&lt;hash&gt;</code>.
        </p>
      </section>
    </>
  );
}
