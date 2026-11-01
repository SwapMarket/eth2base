# eth2base

A static page that moves native USDC from Ethereum to Base using Circle's CCTP V2.
There's no build step and no backend. It uses viem and WalletConnect from esm.sh. The WalletConnect project ID is in `app.js`.

## Run

Serve the directory with any static server (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

It can be deployed as-is to GitHub Pages, Netlify, Cloudflare Pages, etc.

## Flow

1. **Connect**: an injected wallet (browser extension, or a wallet app's in-app browser) if one is present, otherwise WalletConnect (QR code on desktop, deep link on mobile, e.g. Rabby on Android).
2. **Approve**: `USDC.approve(TokenMessengerV2, amount)` on Ethereum, skipped if the allowance is already enough.
3. **Burn**: `TokenMessengerV2.depositForBurnWithHook(amount, 6, recipient, USDC, 0x0, maxFee, minFinalityThreshold, hookData)`.
   - `hookData` is Circle's Forwarding Service marker (`"cctp-forward"`, version 0), so **Circle mints on Base**. The user needs no ETH on Base.
   - `maxFee` = CCTP protocol fee + forwarding fee (`high` tier from `GET /v2/burn/USDC/fees/0/6?forward=true`) + 10% buffer.
     It is **deducted from the amount**. The recipient gets `amount - fee`.
   - Fast: `minFinalityThreshold = 1000`. Standard: `2000`.
4. **Track**: poll `GET https://iris-api.circle.com/v2/messages/0?transactionHash=…` until `forwardTxHash` (the Base mint) appears.
   If the message is attested but not forwarded within 10 minutes, the page offers a manual
   `MessageTransmitterV2.receiveMessage` on Base as a fallback. That fallback needs ETH on Base.

The burn tx hash is saved in `localStorage`. **Resume a transfer** picks tracking back up after a reload.

## Addresses (mainnet)

| | Ethereum (domain 0) | Base (domain 6) |
|---|---|---|
| TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | same |
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | same |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Notes

- If the sender is a smart-contract wallet (such as a Safe), you must enter an explicit Base recipient, because the same address may not exist on Base.
- The `destinationCaller` is zero, so anyone can submit the mint. Fast transfers are subject to Circle's fast-transfer allowance; if it's exhausted, the transfer settles at standard speed.
