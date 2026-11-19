# eth2base

A static page that moves native USDC between Ethereum and Base, in either direction, using Circle's CCTP V2.
There's no bundling and no backend. It uses viem and WalletConnect from esm.sh. The WalletConnect project ID is in `app.js`.

## Run

Serve the directory with any static server (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

It can be deployed as-is to GitHub Pages, Netlify, Cloudflare Pages, etc. The Pages deploy runs `./build.sh <commit>`, which only
stamps the commit into `index.html`.

## Check the live page

Anyone can check that the published page is exactly what its source builds:

```sh
./check-page.sh                     # https://swapmarket.github.io/eth2base/
./check-page.sh https://1cdzwdkc0uepk5ll8mhpcbyw3xh8gakldbfdq8fphhqnv503bceth2base.nwb.tf/   # the copy on Nostr
```

It reads the commit from the page's footer, rebuilds that commit with its own `build.sh`, and compares every file with what the
site serves, byte for byte. It needs git and curl, and this repository with that commit fetched (it fetches if needed).

## Flow

1. **Connect**: an injected wallet (browser extension, or a wallet app's in-app browser) if one is present, otherwise WalletConnect (QR code on desktop, deep link on mobile, e.g. Rabby on Android).
2. **Optional, pay with USDT**: the USDT is first swapped to USDC on Ethereum, via KyberSwap's aggregator API when it quotes at
   least as well as Uniswap v3's 0.01% USDT/USDC pool, otherwise via that pool (`SwapRouter02.exactInputSingle`). Before signing a
   Kyber swap, the page decodes it and checks: the official router (`0x6131…37b5`), USDT in, USDC out, the exact amount, output to
   the connected wallet, no fee receivers, and a guaranteed minimum no lower than the Uniswap quote less 0.5%. If any check fails
   or Kyber is unreachable, it uses Uniswap. A non-zero USDT allowance is reset to 0 first (USDT requires it). The rest of the flow
   bridges the USDC the swap delivered.
   **Approve**: `USDC.approve(TokenMessengerV2, amount)` on Ethereum, skipped if the allowance is already enough.
3. **Burn**: `TokenMessengerV2.depositForBurnWithHook(amount, 6, recipient, USDC, 0x0, maxFee, minFinalityThreshold, hookData)`.
   - `hookData` is Circle's Forwarding Service marker (`"cctp-forward"`, version 0), so **Circle mints on Base**. The user needs no ETH on Base.
   - `maxFee` = CCTP protocol fee + forwarding fee (`high` tier from `GET /v2/burn/USDC/fees/0/6?forward=true`).
     With forwarding, Circle charges the full `maxFee` (`feeExecuted == maxFee`), so there is no extra buffer.
     It is **deducted from the amount**. The recipient gets `amount - fee`.
   - Fast: `minFinalityThreshold = 1000`. Standard: `2000`.
4. **Track**: poll `GET https://iris-api.circle.com/v2/messages/0?transactionHash=…` until `forwardTxHash` (the Base mint) appears.
   If the message is attested but not forwarded within 10 minutes, the page offers a manual
   `MessageTransmitterV2.receiveMessage` on Base as a fallback. That fallback needs ETH on Base.
5. **Optional, swap to EURC**: if "Receive as EURC" is chosen, the USDC is minted to the connected wallet, which swaps it
   and sends the EURC to the recipient (the connected wallet by default, or the address entered). The swap uses the bridged USDC
   on Aerodrome Slipstream: `approve` + `SwapRouter.exactInputSingle` (router `0xBE6D…18a5`, quoter `0x254c…15b0`). The page uses
   the better of the tick-spacing 1 and 50 USDC/EURC pools, with 0.5% max slippage. It swaps only `amount - feeExecuted` of this
   transfer, never other USDC in the wallet. This step needs a little ETH on Base for gas, because Circle's forwarder can only deliver USDC.
   The page shows the end-to-end EUR/USD rate (USDC sent ÷ EURC received, all fees included), quoted before bridging and actual after the swap.
   **Gas top-up** (optional, pre-ticked when Base ETH is low): 0.20 USDC of the bridged amount is swapped to WETH (Aerodrome USDC/WETH
   pool) and unwrapped to the signer as ETH, in the same `multicall` transaction as the EURC swap, so it needs no extra signature.
   The rate shown leaves the top-up out.

The burn tx hash is saved in `localStorage`. **Resume a transfer** picks tracking back up after a reload.

## Base → Ethereum

The direction switch at the top selects the reverse flow. It reuses the same contracts (TokenMessengerV2 and
MessageTransmitterV2 have the same addresses on both chains):

1. **Optional, pay with EURC**: the EURC is swapped to USDC on Aerodrome Slipstream first (approve + `exactInputSingle`).
2. **Approve and burn on Base**: `depositForBurnWithHook(amount, 0, recipient, USDC_BASE, 0x0, maxFee, threshold, forwardHook)`,
   so **Circle mints on Ethereum** and takes its fee from the amount. `maxFee` = protocol fee + forwarding fee
   (`med` tier from `GET /v2/burn/USDC/fees/6/0?forward=true`: the minimum Circle's docs recommend; `high` costs about
   $0.2 more on this route, and a cap below what forwarding needs can make a Fast transfer settle as Standard). The forwarding fee pays Circle's Ethereum gas, so it's much
   higher than for Ethereum → Base (about 0.6–1.0 USDC at the time of writing), and it moves with Ethereum gas prices.
   Because it moves within seconds, this route accepts a rise of up to 0.02 USDC between showing the fee and burning;
   the "fee ≤" the page shows includes it.
3. **Track**: poll `GET /v2/messages/6?transactionHash=…` until `forwardTxHash` (the Ethereum mint). The manual-mint fallback
   calls `receiveMessage` on Ethereum.
4. **Optional, receive USDT**: the USDC is minted to the connected wallet, which swaps it to USDT on Ethereum, using the same
   KyberSwap/Uniswap code and safety checks as the USDT source above, run in reverse, and pays the recipient. This needs a
   little ETH on Ethereum for gas.

Standard transfers wait for Base to finalize (about 15–20 minutes). The page shows the effective EUR/USD when paying with
EURC. Resume works with a Base burn hash too.

## Addresses (mainnet)

| | Ethereum (domain 0) | Base (domain 6) |
|---|---|---|
| TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | same |
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | same |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Notes

- If the sender is a smart-contract wallet (such as a Safe), you must enter an explicit Base recipient, because the same address may not exist on Base.
- The `destinationCaller` is zero, so anyone can submit the mint. Fast transfers are subject to Circle's fast-transfer allowance; if it's exhausted, the transfer settles at standard speed.

## Licence

AGPL-3.0-only (`LICENSE`). The menu, its burger and much of the styling come from SwapMarket/swapmarket.github.io and liq2sol's client, which are AGPL-3.0.
