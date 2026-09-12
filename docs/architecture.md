# VaultRadar architecture

Two diagrams: the system view and the flow of one paid request on the Hedera rail. Rendered PNGs live next to this file ([`architecture.png`](architecture.png), [`payment-flow.png`](payment-flow.png)).

Both diagrams show the designed system. Pieces still in flight at the time of writing are called out in the README's scope notes; the Hedera Harness PR was cut from scope and is not drawn here.

## System view

![VaultRadar system view](architecture.png)

## One paid request, Hedera rail

![One paid request on the Hedera rail](payment-flow.png)

The five phases read as horizontal bands; the numbered steps within each run left to right, the same seventeen messages as before. The dashed boxes are the checks each side performs between messages — on this rail they are the product, not garnish.
