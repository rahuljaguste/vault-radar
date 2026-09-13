# The direction, in order

The prompts that drove this project came from a person at a terminal. This file records them in
sequence, because the rules ask for the prompts and because they are the clearest evidence of
what the human contribution actually was: choosing, approving, constraining, correcting and
verifying, repeatedly, over two days, at every point where the work could have gone a different
way.

Quoted where the wording is short enough to quote; summarised, with the decisions it carried,
where a message was long. Nothing here was rewritten after the fact, and the artifacts each
message produced are named so the sequence can be checked against them.

| # | Direction | What it produced |
|---|---|---|
| 1 | The kickoff: an ETHOnline idea under the Start-Fresh rule, with the sponsor prize list pasted in full. | The shortlist that became VaultRadar. |
| 2 | "What about ARC?" | Arc added to the shortlist, and later the second payment rail. |
| 3 | Ask to plan for multiple prize categories at once. | The three-track mapping that shapes the scope notes. |
| 4 | "1 + also think from privacy and pq POV if it can be added", pick the first option, add post-quantum. | The ML-DSA-65 receipts, ML-KEM sealed requests and on-chain key anchor; eventually the largest engineering strand in the project. |
| 5 | "Yes, write the spec", after a review pass with a second model. | `docs/superpowers/specs/2026-09-05-vaultradar-design.md`, amended by that review. |
| 6 | "Show me the architecture" / "explain me the purpose". | `docs/architecture.md`, the rendered diagrams, and a plain-language explanation the README still follows. |
| 7 | "Proceed with implementation". | The 29-task plan, and four days of implementation under it. |
| 8 | "Have you done the complete UI/UX for user and admin dashboard?" | Caught a real gap; spec §13 added, with the user (portfolio) and admin views planned, built and tested. |
| 9 | "Can you add tasks for [a user view and an admin view] as well. always underpromise and over deliver." | Tasks 27-28, and the promised-versus-stretch scoping rule used in the README's scope notes. |
| 10 | "Ensure all worktrees are merged to main and then cleaned." | The six workstreams merged; worktrees removed. |
| 11 | "Verify the issues - 1. The dashboard's paid scan endpoint can drain the operator's wallet... ", an external review, pasted in full, with its own severity ordering. | Every item verified against the code, four confirmed criticals fixed, and Task 29 written from the verified remainder. |
| 12 | "How to do manual testing?" | The local-run walkthrough, and the browser session that followed it. |
| 13 | "Do I not need to deploy the graph?" | Confirmed the distinction between the fifteen live Messari deployments and the Substreams module, which had never been built, the work that produced the published package. |
| 14 | "Should we use railway instead of fly.io and neon? I already have an account" | The deployment target decision, and everything that followed from it. |
| 15 | "Verify what is pending." | The audit that found a second, uncommitted hardening lineage in the main checkout, preserved on a branch before it could be lost. |
| 16 | "Commit the hardening branch and merge to main. Then continue to pending tasks." | The merge, then the deployment, identity registration, and the first live payments. |
| 17 | "How to get substreams api token?" / "Token is in .env, redeploy the sink." | A streaming sink; the schema was already applied and it indexed on the first attempt. |
| 18 | "I funded 0x80e2... . Create a new arc seller address rather than reusing." | A separate seller keypair, which exposed `ARC_SELLER_ADDRESS` sitting at a placeholder and led to the first settled Arc payment. |
| 19 | "Hedera settled request is done." | The Hedera payment, verified on chain, and both rails settled. |
| 20 | "Verify this", the AI-usage rules, pasted in full. | This directory. |

## What this table is evidence of, and what it is not

It is evidence of a person directing the work: twenty interventions across the project, several
of them catching something the tool had missed or was about to get wrong (the dashboard gap, the
unbuilt module, the uncommitted lineage, the placeholder key). The rulings in `ledger.md` are
where that direction meets a decision the plan did not anticipate.

It is not evidence that a person wrote the code. Nobody did. The source, the tests, the docs and
the diagrams were generated, and the previous file says so without hedging, a judge should
weigh the human contribution on the record as it is, not on how it could be described.
