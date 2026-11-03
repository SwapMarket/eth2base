import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  formatUnits,
  parseUnits,
  isAddress,
  getAddress,
  pad,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  encodeFunctionData,
  decodeFunctionData,
  zeroHash,
} from 'https://esm.sh/viem@2.21.55';
import { mainnet, base } from 'https://esm.sh/viem@2.21.55/chains';

// CCTP V2 (same addresses on every supported chain).
const TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const MESSAGE_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EURC_BASE = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
// USDT → USDC on Ethereum: KyberSwap's aggregator (best price), with Uniswap v3's 0.01% pool as the
// fallback and as an independent reference price for checking Kyber's routes.
const KYBER_API = 'https://aggregator-api.kyberswap.com/ethereum/api/v1';
const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const UNI_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'; // SwapRouter02
const UNI_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'; // QuoterV2
const UNI_FEE = 100; // 0.01% USDT/USDC pool
// Aerodrome Slipstream (concentrated liquidity) on Base; USDC/EURC liquidity sits in these tick spacings.
const AERO_ROUTER = '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5';
const AERO_QUOTER = '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0';
const AERO_TICK_SPACINGS = [1, 50];
// Optional gas top-up in the EURC swap transaction: swap this much USDC to ETH on Base
// (USDC/WETH pools, the deep one is tick spacing 100) and unwrap it to the signer.
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const AERO_WETH_TICK_SPACINGS = [100, 1, 2000];
const TOPUP_USDC = 200_000n; // 0.20 USDC
// Pre-tick the top-up when Base ETH covers fewer than this many EURC swaps at the current gas price.
const TOPUP_BELOW_SWAPS = 4n;
const SLIPPAGE_BPS = 50n; // 0.5%
// Paying with USDT, the USDT → USDC swap takes a minute, during which Circle's fee often moves a little.
// Accept a rise up to this much then instead of stopping after the swap (paying with USDC: none).
const USDT_FEE_TOLERANCE = 10_000n; // 0.01 USDC
// Gas limits with margin over observed usage: USDC approve ~36-56k, forwarded burn ~106-117k,
// Aerodrome approve + swap ~280k.
// USDT → USDC: Kyber estimates up to ~450k depending on the route (Uniswap direct ~130k).
// The gas top-up adds ~120k to the Base swap transaction.
const GAS_UNITS = { approve: 70_000n, burn: 140_000n, swap: 320_000n, usdtSwap: 450_000n, topUp: 150_000n };
// Wallets often price Ethereum gas well above a very low network price (Rabby signed at ~0.7 gwei
// while the network was at 0.04), so they need more ETH than the network cost. Used for the warning.
const WALLET_MIN_GAS_PRICE_ETH = 500_000_000n; // 0.5 gwei
// On Base Rabby priced ~1.5x the network (0.010 vs 0.006-0.008 gwei).
const WALLET_MIN_GAS_PRICE_BASE = 15_000_000n; // 0.015 gwei
const max = (a, b) => (a > b ? a : b);
const DOMAIN_ETH = 0;
const DOMAIN_BASE = 6;
const IRIS = 'https://iris-api.circle.com';
const FINALITY = { fast: 1000, standard: 2000 };
const PENDING_KEY = 'eth2base:pendingBurn';
// Circle Forwarding Service hook: "cctp-forward", version 0, no extra data.
// Circle mints on Base and takes its fee out of the burned amount.
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000';
// If the attestation is done but Circle hasn't forwarded after this long, offer a manual mint.
const FORWARD_GRACE_MS = 10 * 60 * 1000;
// Reown (WalletConnect) project ID, used when no injected wallet is present (e.g. mobile browsers).
const WALLETCONNECT_PROJECT_ID = 'c001d9e3d0c6308a5ce7e5932d40064a';
// Also catches Chrome's "Desktop site" mode on phones, which drops "Android" from the user agent.
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || navigator.userAgentData?.mobile === true
  || (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches);

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const tokenMessengerAbi = parseAbi([
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
]);
const transmitterAbi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
  'function usedNonces(bytes32) view returns (uint256)',
]);
const depositForBurnEvent = parseAbiItem('event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)');
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const uniQuoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const uniRouterAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);
// KyberSwap MetaAggregationRouterV2, used to check a built route before signing it.
const kyberRouterAbi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
]);
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]);
const wethWithdrawalEvent = parseAbiItem('event Withdrawal(address indexed src, uint256 wad)');

const ethClient = createPublicClient({
  chain: mainnet,
  transport: fallback([http('https://ethereum-rpc.publicnode.com'), http('https://eth.llamarpc.com'), http()]),
});
const baseClient = createPublicClient({
  chain: base,
  transport: fallback([http('https://mainnet.base.org'), http('https://base-rpc.publicnode.com')]),
});

const $ = (id) => document.getElementById(id);
let wallet = null;
let account = null;
let fees = null; // { fast: { bps, forward }, standard: { bps, forward } }, forward in USDC base units
let balanceEth = 0n;
let balanceUsdt = 0n;
let balanceBaseUsdc = 0n;
let gas = null; // { eth, base, allowance, ethPrice, basePrice }: ETH balances, USDC allowance, maxFeePerGas
let pendingMint = null; // { message, attestation, nonce } for the manual fallback
let manualMintTx = null;
let viaWalletConnect = false;
let wcProvider = null;
let busy = false; // a transfer started from the form is in progress
let pendingSwap = null; // { burned, fee, amountIn, signer, to, sent, sentAmount, before, topUp } for the EURC swap: signer holds the USDC, `to` gets the EURC

// ---------- UI helpers ----------

function setStatus(html, kind = '') {
  $('status').className = 'status ' + kind;
  $('status').innerHTML = html;
  notify($('status').textContent);
}

// ---------- notifications ----------

// While the user is in their wallet app the page is in the background, so mirror status changes
// into a single notification (same tag, replaced each time). Android Chrome only supports
// notifications through a service worker.
let swReg = null;
navigator.serviceWorker?.register('sw.js').then((r) => { swReg = r; }).catch((e) => console.warn('service worker', e));

async function askNotifications() {
  try {
    if (window.Notification?.permission === 'default') await Notification.requestPermission();
  } catch {}
}

function notify(text) {
  if (!document.hidden || !swReg || window.Notification?.permission !== 'granted') return;
  // First sentence only; the rest is guidance for when the page is in view.
  const body = text.split(/(?<=[.…])\s/)[0];
  swReg.showNotification('eth2base', { body, tag: 'eth2base', renotify: true, icon: 'icon.png' }).catch(() => {});
}

// Back on the page: the notification has served its purpose.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !swReg) return;
  for (const n of await swReg.getNotifications({ tag: 'eth2base' })) n.close();
});

function setStep(name, state) {
  const li = document.querySelector(`#steps li[data-step="${name}"]`);
  li.classList.remove('active', 'done', 'skipped');
  if (state) li.classList.add(state);
  if (state === 'active') {
    li.dataset.start = Date.now();
    tickSteps();
  }
}

// Running timer on the active step, so a long wait (mining, attestation) visibly progresses.
function tickSteps() {
  for (const li of document.querySelectorAll('#steps li.active')) {
    const secs = Math.floor((Date.now() - Number(li.dataset.start)) / 1000);
    let el = li.querySelector('.elapsed');
    if (!el) {
      el = document.createElement('span');
      el.className = 'elapsed';
      li.append(el);
    }
    el.textContent = ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }
}
setInterval(tickSteps, 1000);

function resetSteps() {
  for (const li of document.querySelectorAll('#steps li')) {
    li.className = '';
    li.hidden = false;
    li.querySelector('.elapsed')?.remove();
  }
  document.querySelector('#steps li[data-step="swap"]').hidden = currentOut() !== 'EURC';
  document.querySelector('#steps li[data-step="swapIn"]').hidden = currentSrc() !== 'USDT';
  $('manualMint').hidden = true;
  $('retrySwap').hidden = true;
  manualMintTx = null;
  pendingSwap = null;
  $('progress').hidden = false;
}

const fmt = (v) => Number(formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtEth = (v) => Number(formatUnits(v, 18)).toLocaleString(undefined, { maximumSignificantDigits: 4 });
// Where to look for the signing prompt. Over WalletConnect the request goes to the phone app,
// which often shows nothing until it is opened.
const inWallet = () => (viaWalletConnect
  ? `in your wallet app${walletAppLink()}. Open it on your phone, as the request may not pop up by itself. If it shows the same request twice, confirm only once`
  : 'in your wallet');
// On a phone connected to Rabby, link straight to the app so the user can jump there to confirm.
const walletAppLink = () => (isMobile && /rabby/i.test(wcProvider?.session?.peer?.metadata?.name ?? '')
  ? ' (<a href="rabby://">open Rabby</a>)'
  : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ethTx = (h) => `<a href="https://etherscan.io/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>`;
const baseTx = (h) => `<a href="https://basescan.org/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>`;

function errMsg(e) {
  return e?.shortMessage || e?.details || e?.message || String(e);
}

function parseAmount() {
  const v = $('amount').value.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(v)) return null;
  const amt = parseUnits(v, 6);
  return amt > 0n ? amt : null;
}

const currentMode = () => document.querySelector('input[name=mode]:checked').value;
const currentOut = () => document.querySelector('input[name=out]:checked').value;

// Best USDC→token quote across Aerodrome Slipstream pools: { amountOut, tickSpacing }.
async function quoteAero(tokenOut, amountIn, tickSpacings) {
  const quotes = await Promise.allSettled(tickSpacings.map((tickSpacing) =>
    baseClient.simulateContract({
      address: AERO_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: USDC_BASE, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
    }).then(({ result }) => ({ amountOut: result[0], tickSpacing }))));
  const ok = quotes.filter((q) => q.status === 'fulfilled').map((q) => q.value);
  if (!ok.length) throw new Error('No Aerodrome quote');
  return ok.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
}
const quoteEurc = (amountIn) => quoteAero(EURC_BASE, amountIn, AERO_TICK_SPACINGS);
const quoteTopUp = () => quoteAero(WETH_BASE, TOPUP_USDC, AERO_WETH_TICK_SPACINGS);
const topUpOn = () => currentOut() === 'EURC' && $('topUp').checked;
let topUpTouched = false; // the user ticked/unticked it; otherwise it follows the Base gas balance
let topUpEth = null; // ETH that TOPUP_USDC buys right now, for the label

// ---------- USDT → USDC on Ethereum ----------

const currentSrc = () => document.querySelector('input[name=src]:checked').value;
const minOut = (amount) => (amount * (10_000n - SLIPPAGE_BPS)) / 10_000n;
const isUserRejection = (e) => /rejected|denied/i.test(errMsg(e));

async function uniswapQuote(amountIn) {
  const { result } = await ethClient.simulateContract({
    address: UNI_QUOTER, abi: uniQuoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: USDT_ETH, tokenOut: USDC_ETH, amountIn, fee: UNI_FEE, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

async function kyberRoute(amountIn) {
  const res = await fetch(`${KYBER_API}/routes?tokenIn=${USDT_ETH}&tokenOut=${USDC_ETH}&amountIn=${amountIn}`,
    { headers: { 'x-client-id': 'eth2base' } });
  const { code, data } = await res.json();
  if (code !== 0 || getAddress(data.routerAddress) !== KYBER_ROUTER) throw new Error('KyberSwap route unavailable');
  return { routeSummary: data.routeSummary, amountOut: BigInt(data.routeSummary.amountOut) };
}

// Best quote: KyberSwap when it is at least as good as Uniswap's pool. uniOut is kept as the
// independent reference used to check Kyber's route.
async function quoteUsdt(amountIn) {
  const [k, u] = await Promise.allSettled([kyberRoute(amountIn), uniswapQuote(amountIn)]);
  const uniOut = u.status === 'fulfilled' ? u.value : null;
  if (k.status === 'fulfilled' && (uniOut === null || k.value.amountOut >= uniOut)) {
    return { via: 'KyberSwap', amountOut: k.value.amountOut, uniOut };
  }
  if (uniOut !== null) return { via: 'Uniswap', amountOut: uniOut, uniOut };
  throw new Error('No USDT → USDC quote right now');
}

// Build a Kyber swap and check it before signing: official router, USDT in, USDC out, the exact amount,
// output to this wallet, no fee takers, and a guaranteed minimum no lower than `floor`.
async function kyberSwapTx(amountIn, floor) {
  const { routeSummary, amountOut } = await kyberRoute(amountIn);
  const res = await fetch(`${KYBER_API}/route/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': 'eth2base' },
    body: JSON.stringify({ routeSummary, sender: account, recipient: account, slippageTolerance: Number(SLIPPAGE_BPS), source: 'eth2base' }),
  });
  const { code, data } = await res.json();
  if (code !== 0) throw new Error('KyberSwap could not build the swap');
  if (getAddress(data.routerAddress) !== KYBER_ROUTER || BigInt(data.transactionValue ?? 0) !== 0n) throw new Error('Unexpected KyberSwap transaction');
  const { functionName, args } = decodeFunctionData({ abi: kyberRouterAbi, data: data.data });
  const d = args[0].desc;
  const ok = functionName === 'swap'
    && getAddress(d.srcToken) === USDT_ETH && getAddress(d.dstToken) === USDC_ETH
    && d.amount === amountIn && getAddress(d.dstReceiver) === account
    && d.feeReceivers.length === 0 && d.minReturnAmount >= floor;
  if (!ok) throw new Error('KyberSwap route failed the safety checks');
  return { via: 'KyberSwap', to: KYBER_ROUTER, data: data.data, expected: amountOut, spender: KYBER_ROUTER };
}

function uniswapSwapTx(amountIn, expected) {
  return {
    via: 'Uniswap', to: UNI_ROUTER, expected, spender: UNI_ROUTER,
    data: encodeFunctionData({
      abi: uniRouterAbi, functionName: 'exactInputSingle',
      args: [{ tokenIn: USDT_ETH, tokenOut: USDC_ETH, fee: UNI_FEE, recipient: account, amountIn, amountOutMinimum: minOut(expected), sqrtPriceLimitX96: 0n }],
    }),
  };
}

// USDT's approve reverts when changing one non-zero allowance to another, so reset to 0 first.
async function approveUsdt(spender, amount) {
  const allowanceOf = () => ethClient.readContract({ address: USDT_ETH, abi: erc20Abi, functionName: 'allowance', args: [account, spender] });
  const current = await allowanceOf();
  if (current >= amount) return;
  if (current > 0n) {
    setStatus(`Confirm resetting the USDT approval to 0 (USDT requires this before a new approval) ${inWallet()}…`);
    await sendWatched({
      client: ethClient, label: 'Approval reset', link: ethTx,
      send: () => wallet.writeContract({ account, chain: mainnet, address: USDT_ETH, abi: erc20Abi, functionName: 'approve', args: [spender, 0n] }),
      check: async () => (await allowanceOf()) === 0n,
    });
  }
  setStatus(`Confirm the USDT approval ${inWallet()}…`);
  await sendWatched({
    client: ethClient, label: 'Approval', link: ethTx,
    send: () => wallet.writeContract({ account, chain: mainnet, address: USDT_ETH, abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    check: async () => (await allowanceOf()) >= amount,
  });
}

// Swap USDT to USDC in the connected wallet. Resolves to { received, via }.
async function swapUsdtToUsdc(amountIn) {
  setStep('swapIn', 'active');
  setStatus('Finding the best USDT → USDC route…');
  const q = await quoteUsdt(amountIn);
  // Kyber's guaranteed minimum must not be below Uniswap's quote less slippage (or 1:1 less slippage
  // if Uniswap couldn't quote), so a bad route from the API can't lower the floor.
  const floor = minOut(q.uniOut ?? amountIn);
  let tx = null;
  if (q.via === 'KyberSwap') {
    try {
      await approveUsdt(KYBER_ROUTER, amountIn);
      tx = await kyberSwapTx(amountIn, floor);
    } catch (e) {
      if (isUserRejection(e)) throw e;
      console.warn('KyberSwap failed, falling back to Uniswap', e);
    }
  }
  if (!tx) {
    tx = uniswapSwapTx(amountIn, q.uniOut ?? await uniswapQuote(amountIn));
    await approveUsdt(UNI_ROUTER, amountIn);
  }
  setStatus(`Confirm the swap of ${fmt(amountIn)} USDT for about ${fmt(tx.expected)} USDC (${tx.via}) ${inWallet()}…`);
  const fromBlock = await ethClient.getBlockNumber();
  const r = await sendWatched({
    client: ethClient, label: 'Swap', link: ethTx,
    send: () => wallet.sendTransaction({ account, chain: mainnet, to: tx.to, data: tx.data }),
    check: async () => (await ethClient.getLogs({
      address: USDC_ETH, event: transferEvent, args: { to: account }, fromBlock,
    })).at(-1)?.transactionHash,
  });
  const received = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs })
    .filter((l) => l.address.toLowerCase() === USDC_ETH.toLowerCase() && l.args.to === account)
    .reduce((sum, l) => sum + l.args.value, 0n);
  if (received === 0n) throw new Error('The swap delivered no USDC');
  setStep('swapIn', 'done');
  return { received, via: tx.via };
}

// Latest USDT quote for the form: { key, amountOut, via, at } or { key, error, at }.
let usdtQuote = null;
let usdtQuoteTimer = null;
let usdtQuoteFor = null; // amount being quoted right now
function requestUsdtQuote(amt) {
  if (usdtQuoteFor === amt) return;
  clearTimeout(usdtQuoteTimer);
  usdtQuoteTimer = setTimeout(async () => {
    usdtQuoteFor = amt;
    try {
      const { amountOut, via } = await quoteUsdt(amt);
      usdtQuote = { key: amt, amountOut, via, at: Date.now() };
    } catch (e) {
      // Keep a good quote for the same amount on a failed refresh.
      if (usdtQuote?.key !== amt || usdtQuote.error) usdtQuote = { key: amt, error: true, at: Date.now() };
    } finally {
      usdtQuoteFor = null;
    }
    if (parseAmount() === amt && currentSrc() === 'USDT') refreshForm();
  }, 400);
}

let quoteSeq = 0;
let quoteTimer = null;
// End-to-end EUR/USD: USDC (or USDT) sent from Ethereum per EURC received on Base, all fees included.
const eurUsd = (usdcSent, eurcOut) => (Number(usdcSent) / Number(eurcOut)).toFixed(4);

let shownQuoteKey = null; // source:amount:speed the displayed EURC quote was computed for

function showEurcQuote(sent, usdcIn, key, usdtNote = '', topUp = 0n) {
  const seq = ++quoteSeq;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    let text;
    let quoted = false;
    try {
      const [{ amountOut }, eth] = await Promise.all([quoteEurc(usdcIn - topUp), topUp ? quoteTopUp() : null]);
      quoted = true;
      const via = usdtNote ? `${usdtNote}, then about` : 'at least';
      const gasNote = eth ? `, plus about ${fmtEth(eth.amountOut)} ETH for gas from ${fmt(topUp)} USDC, not counted in the rate` : '';
      text = `You receive about ${fmt(amountOut)} EURC on Base. Effective EUR/USD ${eurUsd(sent - topUp, amountOut)}, all fees included (${via} ${fmt(usdcIn - topUp)} USDC swapped at the current Aerodrome rate, max ${Number(SLIPPAGE_BPS) / 100}% slippage${gasNote})`;
      if (eth) $('topUpEth').textContent = `about ${fmtEth(eth.amountOut)} ETH`;
    } catch (e) {
      if (key === shownQuoteKey) return; // keep the last good quote for this input
      text = 'Could not get an Aerodrome quote right now.';
    }
    if (seq !== quoteSeq) return;
    $('receive').textContent = text;
    shownQuoteKey = quoted ? key : null;
  }, 400);
}

// Max total fee (CCTP protocol fee + Circle forwarding fee, "high" tier) in USDC base units.
// With forwarding, Circle charges the full maxFee, so there is no extra buffer.
// It is deducted from the burned amount on Base, never charged on top.
function maxFeeFor(amount, mode, f = fees) {
  const { bps, forward } = f[mode];
  const ppm = BigInt(Math.ceil(bps * 100));
  const protocol = (amount * ppm + 999_999n) / 1_000_000n;
  return protocol + forward;
}

function refreshForm() {
  if (busy) return; // keep the form as submitted while a transfer runs
  quoteSeq++; // drop any in-flight EURC quote
  const src = currentSrc();
  const amt = parseAmount();
  $('amountLabel').textContent = `Amount (${src})`;

  // USDC that reaches the burn: the amount itself, or the USDT → USDC quote.
  let usdc = amt;
  let usdtNote = '';
  if (src === 'USDT' && amt) {
    const q = usdtQuote?.key === amt ? usdtQuote : null;
    if (!q || Date.now() - q.at > 30_000) requestUsdtQuote(amt); // keeps showing q meanwhile
    usdc = q && !q.error ? q.amountOut : null;
    if (usdc) usdtNote = `${fmt(amt)} USDT → about ${fmt(usdc)} USDC via ${q.via}`;
  }

  for (const mode of ['fast', 'standard']) {
    const el = $(mode === 'fast' ? 'feeFast' : 'feeStd');
    const fee = fees ? maxFeeFor(usdc ?? 0n, mode) : null;
    el.textContent = fee === null ? ''
      : src === 'USDT' ? `· fee ≤ ${fmt(fee + USDT_FEE_TOLERANCE)} USDC` : `· fee ≤ ${fmt(fee)} USDC`;
  }

  $('recipientLabel').textContent = currentOut() === 'EURC' ? 'EURC recipient on Base' : 'Recipient on Base';
  // EURC needs the connected wallet to pay gas on Base for the swap (and a bit more with the top-up):
  // disable the options it can't afford at the current network price.
  const eurcRadio = document.querySelector('input[name=out][value=EURC]');
  const swapGas = gas ? GAS_UNITS.swap * gas.basePrice : 0n;
  const eurcOk = !gas || gas.base >= swapGas;
  const topUpOk = !gas || gas.base >= (GAS_UNITS.swap + GAS_UNITS.topUp) * gas.basePrice;
  eurcRadio.disabled = !eurcOk;
  $('sweep').hidden = !account || !balanceBaseUsdc;
  $('sweep').disabled = !eurcOk;
  if (!eurcOk && eurcRadio.checked) document.querySelector('input[name=out][value=USDC]').checked = true;
  $('eurcHint').textContent = eurcOk ? '· needs a little ETH on Base for gas'
    : `· needs ETH on Base for gas: you have ${fmtEth(gas.base)}, the swap takes about ${fmtEth(swapGas)}`;
  $('topUp').disabled = !topUpOk;
  if (!topUpOk) $('topUp').checked = false;
  else if (!topUpTouched && gas) $('topUp').checked = gas.base < TOPUP_BELOW_SWAPS * swapGas;
  if (topUpEth) $('topUpEth').textContent = `about ${fmtEth(topUpEth)} ETH`;
  $('topUpRow').hidden = currentOut() !== 'EURC';
  const topUp = topUpOn() ? TOPUP_USDC : 0n;
  let label = 'Bridge to Base';
  let ok = !!account && !!amt && !!fees;
  let receive = '';
  if (!fees) {
    label = 'Loading fees…';
  } else if (amt && !usdc) {
    ok = false;
    label = usdtQuote?.key === amt && usdtQuote.error ? 'No USDT → USDC route right now' : 'Getting USDT → USDC quote…';
  } else if (amt) {
    const fee = maxFeeFor(usdc, currentMode());
    if (usdc <= fee + 2n * topUp) {
      ok = false;
      label = topUp ? 'Amount too small for the fee and the gas top-up' : 'Amount must be larger than the fee';
    } else if (currentOut() === 'EURC') {
      // Keep the shown quote while it refreshes for the same input, so the layout doesn't jump.
      const key = `${src}:${amt}:${currentMode()}:${topUp}`;
      receive = key === shownQuoteKey ? $('receive').textContent : 'Getting Aerodrome quote…';
      showEurcQuote(amt, usdc - fee, key, usdtNote, topUp);
    } else if (usdtNote) {
      receive = `You receive about ${fmt(usdc - fee)} USDC on Base (${usdtNote}, then Circle's fee)`;
    } else {
      receive = `You receive at least ${fmt(usdc - fee)} USDC on Base`;
    }
  }
  if (receive !== $('receive').textContent) $('receive').textContent = receive;
  if (!receive.startsWith('You receive about') || !receive.includes('EURC')) shownQuoteKey = null;

  let gasWarn = '';
  const balance = src === 'USDT' ? balanceUsdt : balanceEth;
  if (account && amt && amt > balance) {
    ok = false;
    label = `Insufficient ${src} on Ethereum`;
  } else if (account && amt && usdc && gas) {
    const ethUnits = (src === 'USDT' ? GAS_UNITS.approve + GAS_UNITS.usdtSwap : 0n)
      + (gas.allowance < usdc ? GAS_UNITS.approve : 0n) + GAS_UNITS.burn;
    if (gas.eth < ethUnits * gas.ethPrice) {
      ok = false;
      label = 'Not enough ETH for gas on Ethereum';
    } else {
      const ethWallet = ethUnits * max(gas.ethPrice, WALLET_MIN_GAS_PRICE_ETH);
      const baseWallet = (GAS_UNITS.swap + (topUp ? GAS_UNITS.topUp : 0n)) * max(gas.basePrice, WALLET_MIN_GAS_PRICE_BASE);
      if (gas.eth < ethWallet) {
        gasWarn = `Low ETH for gas on Ethereum: you have ${fmtEth(gas.eth)} ETH, and wallets may ask for about ${fmtEth(ethWallet)} ETH.`;
      } else if (currentOut() === 'EURC' && gas.base < baseWallet) {
        gasWarn = `Low ETH for the swap gas on Base: you have ${fmtEth(gas.base)} ETH, and wallets may ask for about ${fmtEth(baseWallet)} ETH.`;
      }
    }
  }
  if (gasWarn !== $('gasWarn').textContent) $('gasWarn').textContent = gasWarn;
  $('bridge').disabled = !ok;
  $('bridge').textContent = label;
}

// ---------- wallet ----------

// Injected wallet (browser extension or wallet in-app browser) if present, else WalletConnect
// so mobile wallet apps like Rabby can connect via QR code or deep link.
async function getProvider() {
  if (window.ethereum) {
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    viaWalletConnect = false;
    return window.ethereum;
  }
  const { EthereumProvider } = await import('https://esm.sh/@walletconnect/ethereum-provider@2.17.2');
  const provider = await EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: [mainnet.id],
    optionalChains: [base.id],
    rpcMap: { [mainnet.id]: 'https://ethereum-rpc.publicnode.com', [base.id]: 'https://mainnet.base.org' },
    // On phones the modal only offers the generic wc: link, which Rabby doesn't handle,
    // so show our own buttons there instead (see below).
    showQrModal: !isMobile,
    metadata: {
      name: 'eth2base',
      description: 'Bridge USDC from Ethereum to Base with CCTP',
      // The page's own URL (not just the origin, which is a different site with its own favicon), so
      // wallets that look up the site's icon find this one.
      url: new URL('.', location.href).href,
      icons: [new URL('icon.png', location.href).href],
    },
  });
  if (isMobile) {
    // After each request WalletConnect redirects to the wallet stored under this key (normally set by
    // its modal). Point it at Rabby, or clear it for other wallets so it doesn't fall back to the
    // generic wc: link, which opens Android's app chooser.
    const setDeepLink = (href) => {
      try {
        if (href) localStorage.setItem('WALLETCONNECT_DEEPLINK_CHOICE', JSON.stringify({ href, name: 'Rabby' }));
        else localStorage.removeItem('WALLETCONNECT_DEEPLINK_CHOICE');
      } catch {}
    };
    $('wcRabby').onclick = () => setDeepLink('rabby://');
    $('wcOther').onclick = () => setDeepLink(null);
    provider.on('display_uri', (uri) => {
      $('wcRabby').href = `rabby://wc?uri=${encodeURIComponent(uri)}`;
      $('wcOther').href = uri;
      $('wcMobile').hidden = false;
    });
  }
  try {
    await (isMobile
      ? Promise.race([provider.enable(), new Promise((_, reject) => { $('wcCancel').onclick = () => reject(new Error('cancelled')); })])
      : provider.enable());
  } finally {
    $('wcMobile').hidden = true;
  }
  provider.on('disconnect', () => { wcProvider = null; wallet = null; setAccount(null); });
  viaWalletConnect = true;
  wcProvider = provider;
  return provider;
}

async function connect() {
  const provider = await getProvider();
  wallet = createWalletClient({ transport: custom(provider) });
  const [addr] = await wallet.requestAddresses();
  setAccount(addr);
  provider.on?.('accountsChanged', (accs) => setAccount(accs[0] ?? null));
}

function setAccount(addr) {
  account = addr ? getAddress(addr) : null;
  $('account').textContent = account ? `Connected${viaWalletConnect ? ' via WalletConnect' : ''}: ${short(account)}` : 'Not connected';
  // A WalletConnect session can be ended (also clears requests the wallet may still replay);
  // an injected wallet is disconnected from the wallet itself.
  $('connect').textContent = !account ? 'Connect wallet' : wcProvider ? 'Disconnect' : 'Connected';
  $('connect').disabled = !!account && !wcProvider;
  $('balances').hidden = !account;
  refreshBalances();
}

async function refreshBalances() {
  if (!account) { balanceEth = 0n; balanceUsdt = 0n; gas = null; refreshForm(); return; }
  const [e, b, eu, ge, gb, al, fe, fb, ut] = await Promise.allSettled([
    ethClient.readContract({ address: USDC_ETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    baseClient.readContract({ address: EURC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    ethClient.getBalance({ address: account }),
    baseClient.getBalance({ address: account }),
    ethClient.readContract({ address: USDC_ETH, abi: erc20Abi, functionName: 'allowance', args: [account, TOKEN_MESSENGER] }),
    ethClient.estimateFeesPerGas(),
    baseClient.estimateFeesPerGas(),
    ethClient.readContract({ address: USDT_ETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
  ]);
  const ok = (r) => r.status === 'fulfilled';
  try { topUpEth = (await quoteTopUp()).amountOut; } catch {} // keep the last one on failure
  gas = [ge, gb, al, fe, fb].every(ok)
    ? { eth: ge.value, base: gb.value, allowance: al.value, ethPrice: fe.value.maxFeePerGas, basePrice: fb.value.maxFeePerGas }
    : null;
  balanceEth = e.status === 'fulfilled' ? e.value : 0n;
  $('balEth').textContent = e.status === 'fulfilled' ? fmt(e.value) : 'error';
  balanceUsdt = ut.status === 'fulfilled' ? ut.value : 0n;
  $('balUsdt').textContent = ut.status === 'fulfilled' ? fmt(ut.value) : 'error';
  $('balBase').textContent = b.status === 'fulfilled' ? fmt(b.value) : 'error';
  balanceBaseUsdc = b.status === 'fulfilled' ? b.value : 0n;
  $('sweep').textContent = `Swap all ${fmt(balanceBaseUsdc)} Base USDC to EURC`;
  $('balEurc').textContent = eu.status === 'fulfilled' ? fmt(eu.value) : 'error';
  $('gasEth').textContent = ge.status === 'fulfilled' ? fmtEth(ge.value) : 'error';
  $('gasBase').textContent = gb.status === 'fulfilled' ? fmtEth(gb.value) : 'error';
  refreshForm();
}

async function ensureChain(chain) {
  const current = await wallet.getChainId();
  if (current === chain.id) return;
  setStatus(`Approve switching the network to ${chain.name} ${inWallet()}…`);
  try {
    await wallet.switchChain({ id: chain.id });
  } catch (e) {
    if (e?.code === 4902 || e?.cause?.code === 4902) {
      await wallet.addChain({ chain });
    } else {
      throw e;
    }
  }
}

// Smart-contract wallets (e.g. Safe) may not control the same address on Base.
// EIP-7702 delegated EOAs (code prefix 0xef0100) are fine.
async function isContractAccount(addr) {
  const code = await ethClient.getCode({ address: addr });
  return !!code && code !== '0x' && !code.toLowerCase().startsWith('0xef0100');
}

// Send a transaction and wait for it to be mined. Over WalletConnect the wallet's reply (the tx hash)
// can get lost even though the transaction went out, so also watch the chain for its effect and carry
// on as soon as either shows up. check() returns the mined tx hash, true (effect seen, hash unknown),
// or nothing yet. Resolves to the receipt, or null when only the effect was seen.
async function sendWatched({ client, send, check, label, link, onHash }) {
  let watching = true;
  // A rise in the account's pending nonce means the signed tx reached the mempool,
  // so the status can move on from "confirm in your wallet" before it is mined.
  const baseNonce = client.getTransactionCount({ address: account, blockTag: 'pending' }).catch(() => null);
  let submitted = false;
  const sent = send();
  sent.catch(() => {}); // a rejection still reaches the race below
  const seen = (async () => {
    while (watching) {
      await sleep(4000);
      try {
        const r = await check();
        if (r) return r;
        const base = await baseNonce;
        if (!submitted && watching && base !== null
          && (await client.getTransactionCount({ address: account, blockTag: 'pending' })) > base) {
          submitted = true;
          if (watching) setStatus(`${label} submitted, waiting for it to be mined on ${client.chain.name}…`);
        }
      } catch (e) {
        console.warn('chain watch failed', e);
      }
    }
    return new Promise(() => {});
  })();
  let hash;
  try {
    hash = await Promise.race([sent, seen.then((r) => (r === true ? null : r))]);
  } finally {
    watching = false;
  }
  if (!hash) return null;
  onHash?.(hash);
  setStatus(`${label} sent ${link(hash)}, waiting for confirmation…`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} transaction reverted`);
  return receipt;
}

// ---------- CCTP flow ----------

async function loadFees() {
  try {
    const res = await fetch(`${IRIS}/v2/burn/USDC/fees/${DOMAIN_ETH}/${DOMAIN_BASE}?forward=true`);
    const list = await res.json();
    const pick = (threshold) => {
      const f = list.find((x) => x.finalityThreshold === threshold);
      if (!f?.forwardFee) throw new Error('missing forward fee');
      return { bps: f.minimumFee, forward: BigInt(f.forwardFee.high) };
    };
    fees = { fast: pick(FINALITY.fast), standard: pick(FINALITY.standard) };
  } catch (e) {
    console.warn('fee fetch failed', e);
    refreshForm();
    return false; // keep the last good fees on screen
  }
  refreshForm();
  return true;
}

async function bridge() {
  let amount = parseAmount();
  if (!amount || !fees) return;
  const src = currentSrc();
  // USDC the user saw quoted (for USDT, the swap quote); fees are checked against it.
  const shownUsdc = src === 'USDT' ? (usdtQuote?.key === amount && !usdtQuote.error ? usdtQuote.amountOut : null) : amount;
  if (!shownUsdc) return;
  await askNotifications();
  const mode = currentMode();

  let recipient = $('recipient').value.trim() || null;
  if (recipient) {
    if (!isAddress(recipient)) { alert('Recipient is not a valid address.'); return; }
    recipient = getAddress(recipient);
  }
  const out = currentOut();
  // For EURC the USDC is minted to the connected wallet, which signs the swap on Base;
  // the recipient only gets the EURC from the swap.
  const mintTo = out === 'EURC' ? account : recipient ?? account;
  const eurcTo = out === 'EURC' ? recipient ?? account : null;
  if (mintTo === account && await isContractAccount(account)) {
    alert(out === 'EURC'
      ? 'Your account is a smart-contract wallet, which may not exist at the same address on Base. Receiving EURC needs a regular wallet: it receives the USDC on Base and signs the swap there.'
      : 'Your account is a smart-contract wallet, which may not exist at the same address on Base. Enter a recipient address you control on Base.');
    return;
  }

  $('bridge').disabled = true;
  resetSteps();
  busy = true;
  const shownFees = fees;
  let source = null; // { amount, token, via } when the transfer started from USDT
  let unburned = null; // USDC from the USDT swap that hasn't been burned yet
  try {
    await ensureChain(mainnet);

    // 0. USDT → USDC. From here on it is a USDC transfer of what the swap delivered.
    if (src === 'USDT') {
      const { received, via } = await swapUsdtToUsdc(amount);
      source = { amount, token: 'USDT', via };
      amount = received;
      unburned = received;
      refreshBalances();
    }

    // Forwarding fee tracks Base gas, so require fresh fees right before burning, but never
    // charge more than the fee the user saw: if it went up, show the new one and stop.
    const shownFee = maxFeeFor(amount, mode, shownFees);
    if (!(await loadFees())) throw new Error('Could not load current fees from Circle. Try again.');
    const maxFee = maxFeeFor(amount, mode);
    const allowedFee = shownFee + (source ? USDT_FEE_TOLERANCE : 0n); // what the form showed as "fee ≤"
    if (maxFee > allowedFee) {
      throw new Error(`${source ? `Swapped to ${fmt(amount)} USDC. ` : ''}Circle's fee just went up from ${fmt(allowedFee)} to ${fmt(maxFee)} USDC. Click Bridge again to accept it.`);
    }
    if (amount <= maxFee) throw new Error('Amount must be larger than the fee.');

    // 1. Approve
    setStep('approve', 'active');
    const allowance = await ethClient.readContract({
      address: USDC_ETH, abi: erc20Abi, functionName: 'allowance', args: [account, TOKEN_MESSENGER],
    });
    if (allowance < amount) {
      setStatus(`Confirm the USDC approval ${inWallet()}…`);
      await sendWatched({
        client: ethClient, label: 'Approval', link: ethTx,
        send: () => wallet.writeContract({
          account, chain: mainnet, address: USDC_ETH, abi: erc20Abi,
          functionName: 'approve', args: [TOKEN_MESSENGER, amount],
        }),
        check: async () => (await ethClient.readContract({
          address: USDC_ETH, abi: erc20Abi, functionName: 'allowance', args: [account, TOKEN_MESSENGER],
        })) >= amount,
      });
      setStep('approve', 'done');
    } else {
      setStep('approve', 'skipped');
    }

    // 2. Burn, with the forwarding hook so Circle mints on Base
    setStep('burn', 'active');
    setStatus(`Confirm the burn ${inWallet()}…`);
    const fromBlock = await ethClient.getBlockNumber();
    let burnHash;
    try {
      ({ transactionHash: burnHash } = await sendWatched({
        client: ethClient, label: 'Burn', link: ethTx,
        send: () => wallet.writeContract({
          account, chain: mainnet, address: TOKEN_MESSENGER, abi: tokenMessengerAbi,
          functionName: 'depositForBurnWithHook',
          args: [amount, DOMAIN_BASE, pad(mintTo, { size: 32 }), USDC_ETH, zeroHash, maxFee, FINALITY[mode], FORWARD_HOOK],
        }),
        check: async () => {
          const logs = await ethClient.getLogs({
            address: TOKEN_MESSENGER, event: depositForBurnEvent, args: { depositor: account }, fromBlock,
          });
          return logs.find((l) => l.args.amount === amount)?.transactionHash;
        },
        onHash: (hash) => { unburned = null; savePending(hash, out, eurcTo); },
      }));
    } catch (e) {
      if (/rejected|denied|reverted/i.test(errMsg(e))) clearPending(); // keep it on transient RPC errors
      throw e;
    }
    setStep('burn', 'done');
    refreshBalances();

    await finish(await track(burnHash, mode), out, eurcTo, source, topUpOn());
  } catch (e) {
    console.error(e);
    setStatus(errMsg(e), 'err');
    // Stopped after the USDT swap but before the burn: set the form to bridge that USDC,
    // so Bridge continues instead of swapping again.
    if (unburned) {
      document.querySelector('input[name=src][value=USDC]').checked = true;
      $('amount').value = formatUnits(unburned, 6);
    }
  } finally {
    busy = false;
    refreshForm();
  }
}

async function resume() {
  const hash = $('resumeHash').value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) { alert('Enter a valid transaction hash.'); return; }
  await askNotifications();
  resetSteps();
  setStep('approve', 'done');
  setStep('burn', 'done');
  try {
    await finish(await track(hash), currentOut(), eurcRecipientFor(hash), null, topUpOn());
  } catch (e) {
    console.error(e);
    setStatus(errMsg(e), 'err');
  }
}

// After the USDC is on Base: done, or continue with the Aerodrome swap.
async function finish({ message: m, mintTx }, out, eurcTo, source = null, topUp = false) {
  clearPending();
  refreshBalances();
  const mintLink = mintTx ? ` ${baseTx(mintTx)}` : '';
  const body = m.decodedMessage?.decodedMessageBody;
  if (!body?.amount || !body?.mintRecipient) {
    setStatus(out === 'EURC'
      ? `USDC is on Base${mintLink}, but the transfer amount couldn't be read, so no swap was made.`
      : `Done! USDC minted on Base${mintLink}.`, out === 'EURC' ? 'err' : 'ok');
    return;
  }
  const burned = BigInt(body.amount);
  const fee = BigInt(body.feeExecuted ?? body.maxFee ?? 0);
  const minted = burned - fee;
  const signer = getAddress(`0x${body.mintRecipient.slice(-40)}`);
  // What the user sent and what happened before the burn, for the done messages.
  const sent = source ? `${fmt(source.amount)} USDT` : `${fmt(burned)} USDC`;
  const before = source ? `USDT → ${fmt(burned)} USDC via ${source.via}, ` : '';
  if (out !== 'EURC') {
    const dest = signer === account ? '' : ` for ${short(signer)}`;
    setStatus(`Done! ${sent} → ${fmt(minted)} USDC on Base${dest}${mintLink}. Fees: ${before}Circle's fee ${fmt(fee)} USDC.`, 'ok');
    return;
  }
  // Swap only what this transfer delivered, never other USDC in the wallet.
  pendingSwap = { burned, fee, amountIn: minted, signer, to: eurcTo ?? signer, sent, sentAmount: source?.amount ?? burned, before, topUp };
  setStatus(`${fmt(minted)} USDC minted on Base${mintLink}. Now swapping to EURC…`);
  await swapToEurc();
}

// Poll Circle until the USDC is minted on Base (by the forwarder, or manually as a fallback
// when the attestation is complete but nothing has been forwarded for a while).
// Resolves to { message, mintTx }.
async function track(burnHash, mode) {
  setStep('attest', 'active');
  const wait = mode === 'standard' ? 'usually 15–20 minutes' : mode === 'fast' ? 'usually under a minute' : 'this can take a while';
  setStatus(`Waiting for Circle to attest the burn (${wait}). You can close this page and resume later with ${ethTx(burnHash)}.`);

  const url = `${IRIS}/v2/messages/${DOMAIN_ETH}?transactionHash=${burnHash}`;
  let attestedAt = null;
  for (;;) {
    let m = null;
    try {
      const res = await fetch(url);
      if (res.ok) m = (await res.json()).messages?.[0] ?? null;
      else if (res.status !== 404) console.warn('attestation API', res.status, await res.text());
    } catch (e) {
      console.warn('attestation poll failed', e);
    }

    if (m && m.decodedMessage && Number(m.decodedMessage.destinationDomain) !== DOMAIN_BASE) {
      throw new Error('This burn is not destined for Base.');
    }

    if (m?.forwardTxHash) {
      for (const s of ['attest', 'mint']) setStep(s, 'done');
      $('manualMint').hidden = true;
      return { message: m, mintTx: m.forwardTxHash };
    }

    if (m?.status === 'complete' && m.attestation && m.attestation !== 'PENDING') {
      if (!attestedAt) {
        attestedAt = Date.now();
        setStep('attest', 'done');
        setStep('mint', 'active');
        setStatus('Attested. Waiting for Circle to mint on Base…');
      }
      pendingMint = { message: m.message, attestation: m.attestation, nonce: m.eventNonce };
      if (Date.now() - attestedAt > FORWARD_GRACE_MS) {
        // Covers both a manual mint from this page and one made elsewhere.
        if (await alreadyMinted(m.eventNonce)) {
          setStep('mint', 'done');
          $('manualMint').hidden = true;
          return { message: m, mintTx: manualMintTx };
        }
        if ($('manualMint').hidden && !manualMintTx) {
          setStatus('Circle hasn\'t forwarded this transfer yet. You can keep waiting, or mint it yourself on Base (needs a little ETH on Base for gas).');
          $('manualMint').hidden = false;
        }
      }
    }

    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function alreadyMinted(nonce) {
  if (!nonce) return false;
  try {
    const used = await baseClient.readContract({
      address: MESSAGE_TRANSMITTER, abi: transmitterAbi, functionName: 'usedNonces', args: [nonce],
    });
    return used !== 0n;
  } catch {
    return false;
  }
}

// Fallback only: mint on Base from the connected wallet.
async function manualMint() {
  if (!pendingMint) return;
  const { message, attestation, nonce } = pendingMint;
  try {
    if (!wallet) await connect();
    if (!account) return;
    $('manualMint').hidden = true;
    if (await alreadyMinted(nonce)) {
      setStatus('Already minted on Base, finishing up…');
      return; // track() notices on its next poll
    }
    await ensureChain(base);
    setStatus(`Confirm the mint on Base ${inWallet()}…`);
    const r = await sendWatched({
      client: baseClient, label: 'Mint', link: baseTx,
      send: () => wallet.writeContract({
        account, chain: base, address: MESSAGE_TRANSMITTER, abi: transmitterAbi,
        functionName: 'receiveMessage', args: [message, attestation],
      }),
      check: () => alreadyMinted(nonce),
    });
    manualMintTx = r?.transactionHash ?? null;
    setStatus(`Minted on Base${r ? ` ${baseTx(r.transactionHash)}` : ''}, finishing up…`);
  } catch (e) {
    console.error(e);
    $('manualMint').hidden = false;
    setStatus(`Mint failed: ${errMsg(e)}. Your funds are safe; the attested message can be minted any time.`, 'err');
  }
}

// Swap the bridged USDC to EURC on Aerodrome Slipstream, signed by the wallet the USDC was minted to,
// sending the EURC to the chosen recipient.
async function swapToEurc() {
  if (!pendingSwap) return;
  const { signer, to } = pendingSwap;
  $('retrySwap').hidden = true;
  setStep('swap', 'active');
  try {
    if (!wallet) await connect();
    if (!account) throw new Error('Connect your wallet to swap.');
    if (signer !== account) throw new Error(`The USDC went to ${short(signer)}. Connect that wallet to swap.`);

    const balance = await baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
    const amountIn = balance < pendingSwap.amountIn ? balance : pendingSwap.amountIn;
    if (amountIn === 0n) throw new Error('No USDC on Base to swap.');
    if ((await baseClient.getBalance({ address: account })) === 0n) {
      throw new Error('You need a little ETH on Base to pay gas for the swap. Your USDC is already on Base; add some ETH and retry.');
    }
    await ensureChain(base);

    const allowance = await baseClient.readContract({
      address: USDC_BASE, abi: erc20Abi, functionName: 'allowance', args: [account, AERO_ROUTER],
    });
    if (allowance < amountIn) {
      setStatus(`Confirm the USDC approval for Aerodrome ${inWallet()}…`);
      await sendWatched({
        client: baseClient, label: 'Approval', link: baseTx,
        send: () => wallet.writeContract({
          account, chain: base, address: USDC_BASE, abi: erc20Abi,
          functionName: 'approve', args: [AERO_ROUTER, amountIn],
        }),
        check: async () => (await baseClient.readContract({
          address: USDC_BASE, abi: erc20Abi, functionName: 'allowance', args: [account, AERO_ROUTER],
        })) >= amountIn,
      });
      // Give the wallet's own node time to see the approval: wallets simulate the swap before showing it,
      // and one that is a block behind reports it "will fail".
      const approvedAt = await baseClient.getBlockNumber();
      while ((await baseClient.getBlockNumber()) < approvedAt + 2n) await sleep(1000);
    }

    // With the gas top-up, part of the USDC is swapped to WETH (kept in the router) and unwrapped to
    // the signer as ETH, all in one multicall with the EURC swap.
    const topUp = pendingSwap.topUp && amountIn > 2n * TOPUP_USDC ? TOPUP_USDC : 0n;
    const eurcIn = amountIn - topUp;
    const [{ amountOut, tickSpacing }, eth] = await Promise.all([quoteEurc(eurcIn), topUp ? quoteTopUp() : null]);
    // Deadline from Base's own clock, not the computer's (which may be off).
    const deadline = (await baseClient.getBlock()).timestamp + 20n * 60n;
    const eurcSwap = {
      tokenIn: USDC_BASE, tokenOut: EURC_BASE, tickSpacing, recipient: to,
      deadline, amountIn: eurcIn, amountOutMinimum: minOut(amountOut), sqrtPriceLimitX96: 0n,
    };
    const gasNote = eth ? ` plus about ${fmtEth(eth.amountOut)} ETH for gas` : '';
    setStatus(`Confirm the swap of ${fmt(amountIn)} USDC for about ${fmt(amountOut)} EURC${gasNote} ${inWallet()}…`);
    const fromBlock = await baseClient.getBlockNumber();
    const r = await sendWatched({
      client: baseClient, label: 'Swap', link: baseTx,
      send: () => (eth
        ? wallet.writeContract({
          account, chain: base, address: AERO_ROUTER, abi: routerAbi, functionName: 'multicall',
          args: [[
            encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [eurcSwap] }),
            encodeFunctionData({
              abi: routerAbi, functionName: 'exactInputSingle',
              args: [{
                tokenIn: USDC_BASE, tokenOut: WETH_BASE, tickSpacing: eth.tickSpacing, recipient: AERO_ROUTER,
                deadline, amountIn: topUp, amountOutMinimum: minOut(eth.amountOut), sqrtPriceLimitX96: 0n,
              }],
            }),
            encodeFunctionData({ abi: routerAbi, functionName: 'unwrapWETH9', args: [minOut(eth.amountOut), account] }),
          ]],
        })
        : wallet.writeContract({
          account, chain: base, address: AERO_ROUTER, abi: routerAbi, functionName: 'exactInputSingle', args: [eurcSwap],
        })),
      check: async () => {
        const logs = await baseClient.getLogs({
          address: EURC_BASE, event: transferEvent, args: { to }, fromBlock,
        });
        return logs.at(-1)?.transactionHash;
      },
    });
    const hash = r.transactionHash;
    setStep('swap', 'done');
    const eurcOut = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs })
      .filter((l) => l.address.toLowerCase() === EURC_BASE.toLowerCase() && l.args.to === to)
      .reduce((sum, l) => sum + l.args.value, 0n);
    const ethOut = parseEventLogs({ abi: [wethWithdrawalEvent], logs: r.logs })
      .filter((l) => l.address.toLowerCase() === WETH_BASE.toLowerCase())
      .reduce((sum, l) => sum + l.args.wad, 0n);
    const { burned, fee, sent, sentAmount, before } = pendingSwap;
    pendingSwap = null;
    const dest = to === account ? '' : ` for ${short(to)}`;
    const gasDone = ethOut ? `, plus ${fmtEth(ethOut)} ETH for gas from ${fmt(topUp)} USDC` : '';
    // The rate is only end-to-end if the whole delivered amount was swapped; it leaves out the gas top-up.
    setStatus(amountIn === burned - fee
      ? `Done! ${sent} → ${fmt(eurcOut)} EURC${dest}${gasDone}. Effective EUR/USD ${eurUsd(sentAmount - topUp, eurcOut)}, all fees included (${before}Circle's fee ${fmt(fee)} USDC, then the Aerodrome swap ${baseTx(hash)}).`
      : `Done! Swapped ${fmt(amountIn - topUp)} USDC to ${fmt(eurcOut)} EURC${dest}${gasDone} on Aerodrome ${baseTx(hash)}. Rate: EUR/USD ${eurUsd(amountIn - topUp, eurcOut)}.`, 'ok');
    refreshBalances();
  } catch (e) {
    console.error(e);
    setStatus(`Swap failed: ${errMsg(e)} Your USDC is safe on Base.`, 'err');
    $('retrySwap').hidden = false;
  }
}

// Swap the wallet's whole Base USDC balance to EURC (e.g. USDC left from earlier transfers).
async function sweep() {
  if (!account || busy) return;
  const r = $('recipient').value.trim();
  if (r && !isAddress(r)) { alert('Recipient is not a valid address.'); return; }
  busy = true;
  $('sweep').disabled = true;
  resetSteps();
  for (const li of document.querySelectorAll('#steps li')) li.hidden = li.dataset.step !== 'swap';
  // Not part of a transfer, so no end-to-end figures: the done message shows the swap's own rate.
  pendingSwap = {
    burned: 0n, fee: 0n, amountIn: 2n ** 255n, signer: account, to: r ? getAddress(r) : account,
    topUp: !$('topUp').disabled && $('topUp').checked, sent: '', sentAmount: 0n, before: '',
  };
  try {
    await swapToEurc();
  } finally {
    busy = false;
    refreshBalances();
  }
}

// ---------- pending-burn persistence ----------

function savePending(hash, out, eurcTo) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ hash, out, eurcTo })); } catch {}
}
// EURC recipient for a resumed transfer: the one saved with it, else the recipient field, else the wallet.
function eurcRecipientFor(hash) {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}');
    if (saved.hash === hash && saved.eurcTo) return saved.eurcTo;
  } catch {}
  const field = $('recipient').value.trim();
  return isAddress(field) ? getAddress(field) : null;
}
function clearPending() {
  try { localStorage.removeItem(PENDING_KEY); } catch {}
}
function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw) {
      const { hash, out } = raw.startsWith('{') ? JSON.parse(raw) : { hash: raw, out: 'USDC' };
      $('resumeHash').value = hash;
      $('resumeHash').closest('details').open = true;
      document.querySelector(`input[name=out][value="${out === 'EURC' ? 'EURC' : 'USDC'}"]`).checked = true;
    }
  } catch {}
}

// ---------- wire up ----------

$('connect').onclick = async () => {
  try {
    if (account && wcProvider) {
      const p = wcProvider;
      wcProvider = null;
      wallet = null;
      setAccount(null);
      await p.disconnect();
    } else {
      await connect();
    }
  } catch (e) {
    if (e?.message !== 'cancelled') alert(errMsg(e));
  }
};
$('bridge').onclick = bridge;
$('resume').onclick = resume;
$('manualMint').onclick = manualMint;
$('retrySwap').onclick = swapToEurc;
$('sweep').onclick = sweep;
$('amount').oninput = refreshForm;
$('topUp').onchange = () => { topUpTouched = true; refreshForm(); };
$('max').onclick = () => { $('amount').value = formatUnits(currentSrc() === 'USDT' ? balanceUsdt : balanceEth, 6); refreshForm(); };
for (const r of document.querySelectorAll('input[name=mode], input[name=out], input[name=src]')) r.onchange = refreshForm;

// The deploy workflow stamps the commit into the footer; unstamped (local) copies link to the repo.
if ($('commit').textContent.startsWith('__')) {
  $('commit').textContent = 'dev';
  $('commit').href = 'https://github.com/SwapMarket/eth2base';
}

loadPending();
loadFees();
setInterval(() => { loadFees(); refreshBalances(); }, 30_000);
