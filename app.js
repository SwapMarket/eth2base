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

// SwapMarket's sites are on GitHub Pages, and also nsites (NIP-5A) under SwapMarket's key, each its own subdomain on a gateway:
// <key in base36><name>.<gateway>, or <npub>.<gateway> for the root site, BTC Swaps. A menu link opened on one of those stays on the
// same gateway; anywhere else, including a copy under another key, it goes to GitHub Pages. As liq2sol's client/site/js/sites.js,
// which has the tests.
const KEY36 = '1cdzwdkc0uepk5ll8mhpcbyw3xh8gakldbfdq8fphhqnv503bc';
const NPUB = 'npub1xhklzztd83v34zsf9da2gvfrctj5wcsvsx09er9v26jy7r0uq8yq4vme7d';
function siteUrl(name, hostname = location.hostname) {
  const [label, ...gateway] = hostname.split('.');
  if (gateway.length && (label === NPUB || (label.startsWith(KEY36) && /^[a-z0-9-]{1,13}$/.test(label.slice(KEY36.length))))) {
    return `https://${name ? KEY36 + name : NPUB}.${gateway.join('.')}/`;
  }
  return `https://swapmarket.github.io/${name ? `${name}/` : ''}`;
}
for (const a of document.querySelectorAll('a[data-site]')) a.href = siteUrl(a.dataset.site);
// The gateway the footer links to for the copy on Nostr (as NSITE_GATEWAY in liq2sol's client/site/js/sites.js): nsite.lol never
// picked up a later manifest of a site it had served, while nwb.tf showed each within minutes (2026-11-19).
const NSITE_GATEWAY = 'nwb.tf';
const nsiteUrl = (name, gateway = NSITE_GATEWAY) => `https://${name ? KEY36 + name : NPUB}.${gateway}/`;
for (const a of document.querySelectorAll('a[data-nsite]')) a.href = nsiteUrl(a.dataset.nsite);
// Already on one of SwapMarket's nsites (the same test as siteUrl's), the page needs no link to its copy on Nostr.
if (siteUrl('') !== 'https://swapmarket.github.io/') for (const note of document.querySelectorAll('[data-nsite-note]')) note.hidden = true;

// The menu: on narrow screens the burger opens it over the page, and choosing a page closes it.
{
  const burger = document.getElementById('burger');
  const menu = document.getElementById('collapse');
  const set = (open) => {
    menu.classList.toggle('open', open);
    burger.classList.toggle('active', open);
    document.body.classList.toggle('menu-open', open);
    burger.setAttribute('aria-expanded', String(open));
  };
  burger.addEventListener('click', () => set(!menu.classList.contains('open')));
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
}

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
// Base → Ethereum: Circle's fee follows Ethereum gas and moves within seconds, so accept a rise up to this
// much on that route (paid with USDC or EURC). It's included in the "fee ≤" the form shows.
const TO_ETH_FEE_TOLERANCE = 20_000n; // 0.02 USDC
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
// The two directions. toBase: Ethereum → Base (the original flow); toEth: Base → Ethereum.
const ROUTES = {
  toBase: { srcDomain: 0, dstDomain: 6, srcName: 'Ethereum', dstName: 'Base' },
  toEth: { srcDomain: 6, dstDomain: 0, srcName: 'Base', dstName: 'Ethereum' },
};
const currentDir = () => document.querySelector('input[name=dir]:checked').value;
const PENDING_KEY = 'eth2base:pendingBurn';
const FORM_KEY = 'eth2base:form'; // the form's choices, restored on reload
const RECIPIENT_KEY = 'eth2base:recipient';
const WALLET_KEY = 'eth2base:wallet'; // 'injected' or 'walletconnect': reconnected on reload
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
let fees = null; // Ethereum → Base: { fast: { bps, forward }, standard: { bps, forward } }, forward in USDC base units
let feesToEth = null; // Base → Ethereum, same shape (Circle's mint on Ethereum costs far more)
let balanceEth = 0n;
let balanceUsdt = 0n;
let balanceBaseUsdc = 0n;
let balanceEurc = 0n;
let baseAllowance = 0n; // Base USDC approved for Circle's TokenMessenger
let gas = null; // { eth, base, allowance, ethPrice, basePrice }: ETH balances, USDC allowance, maxFeePerGas
let pendingMint = null; // { message, attestation, nonce, dir } for the manual fallback
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

function resetSteps(dir = currentDir()) {
  const step = (name) => document.querySelector(`#steps li[data-step="${name}"]`);
  for (const li of document.querySelectorAll('#steps li')) {
    li.className = '';
    li.hidden = false;
    li.querySelector('.elapsed')?.remove();
  }
  const toEth = dir === 'toEth';
  const { srcName, dstName } = ROUTES[dir];
  step('swapIn').textContent = toEth ? 'Swap EURC to USDC on Aerodrome' : 'Swap USDT to USDC';
  step('burn').textContent = `Burn on ${srcName}`;
  step('mint').textContent = `Circle mints on ${dstName}`;
  step('swap').textContent = toEth ? 'Swap USDC to USDT on Ethereum' : 'Swap USDC to EURC on Aerodrome';
  step('swapIn').hidden = toEth ? currentSrcB() !== 'EURC' : currentSrc() !== 'USDT';
  step('swap').hidden = toEth ? currentOutE() !== 'USDT' : currentOut() !== 'EURC';
  $('manualMint').textContent = `Mint manually on ${dstName}`;
  $('retrySwap').textContent = toEth ? 'Swap to USDT' : 'Swap to EURC';
  $('manualMint').hidden = true;
  $('retrySwap').hidden = true;
  manualMintTx = null;
  pendingSwap = null;
  pendingUsdt = null;
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

// Best quote across Aerodrome Slipstream pools: { amountOut, tickSpacing }.
async function quoteAero(tokenOut, amountIn, tickSpacings, tokenIn = USDC_BASE) {
  const quotes = await Promise.allSettled(tickSpacings.map((tickSpacing) =>
    baseClient.simulateContract({
      address: AERO_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
    }).then(({ result }) => ({ amountOut: result[0], tickSpacing }))));
  const ok = quotes.filter((q) => q.status === 'fulfilled').map((q) => q.value);
  if (!ok.length) throw new Error('No Aerodrome quote');
  return ok.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
}
const quoteEurc = (amountIn) => quoteAero(EURC_BASE, amountIn, AERO_TICK_SPACINGS);
const quoteEurcToUsdc = (amountIn) => quoteAero(USDC_BASE, amountIn, AERO_TICK_SPACINGS, EURC_BASE);
const quoteTopUp = () => quoteAero(WETH_BASE, TOPUP_USDC, AERO_WETH_TICK_SPACINGS);
const topUpOn = () => currentOut() === 'EURC' && $('topUp').checked;
let topUpTouched = false;
let preferredOut = 'USDC'; // the user's choice; EURC is re-selected when it becomes available again // the user ticked/unticked it; otherwise it follows the Base gas balance
let topUpEth = null; // ETH that TOPUP_USDC buys right now, for the label

// ---------- USDT ⇄ USDC on Ethereum ----------

const currentSrc = () => document.querySelector('input[name=src]:checked').value;
const minOut = (amount) => (amount * (10_000n - SLIPPAGE_BPS)) / 10_000n;
const isUserRejection = (e) => /rejected|denied/i.test(errMsg(e));
const tokenName = (t) => (t === USDT_ETH ? 'USDT' : 'USDC');

async function uniswapQuote(tokenIn, tokenOut, amountIn) {
  const { result } = await ethClient.simulateContract({
    address: UNI_QUOTER, abi: uniQuoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee: UNI_FEE, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

async function kyberRoute(tokenIn, tokenOut, amountIn) {
  const res = await fetch(`${KYBER_API}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`,
    { headers: { 'x-client-id': 'eth2base' } });
  const { code, data } = await res.json();
  if (code !== 0 || getAddress(data.routerAddress) !== KYBER_ROUTER) throw new Error('KyberSwap route unavailable');
  return { routeSummary: data.routeSummary, amountOut: BigInt(data.routeSummary.amountOut) };
}

// Best quote: KyberSwap when it is at least as good as Uniswap's pool. uniOut is kept as the
// independent reference used to check Kyber's route.
async function quotePair(tokenIn, tokenOut, amountIn) {
  const [k, u] = await Promise.allSettled([kyberRoute(tokenIn, tokenOut, amountIn), uniswapQuote(tokenIn, tokenOut, amountIn)]);
  const uniOut = u.status === 'fulfilled' ? u.value : null;
  if (k.status === 'fulfilled' && (uniOut === null || k.value.amountOut >= uniOut)) {
    return { via: 'KyberSwap', amountOut: k.value.amountOut, uniOut };
  }
  if (uniOut !== null) return { via: 'Uniswap', amountOut: uniOut, uniOut };
  throw new Error(`No ${tokenName(tokenIn)} → ${tokenName(tokenOut)} quote right now`);
}
const quoteUsdt = (amountIn) => quotePair(USDT_ETH, USDC_ETH, amountIn);

// Build a Kyber swap and check it before signing: official router, the right tokens, the exact amount,
// output to `to`, no fee takers, and a guaranteed minimum no lower than `floor`.
async function kyberSwapTx(tokenIn, tokenOut, amountIn, floor, to) {
  const { routeSummary, amountOut } = await kyberRoute(tokenIn, tokenOut, amountIn);
  const res = await fetch(`${KYBER_API}/route/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': 'eth2base' },
    body: JSON.stringify({ routeSummary, sender: account, recipient: to, slippageTolerance: Number(SLIPPAGE_BPS), source: 'eth2base' }),
  });
  const { code, data } = await res.json();
  if (code !== 0) throw new Error('KyberSwap could not build the swap');
  if (getAddress(data.routerAddress) !== KYBER_ROUTER || BigInt(data.transactionValue ?? 0) !== 0n) throw new Error('Unexpected KyberSwap transaction');
  const { functionName, args } = decodeFunctionData({ abi: kyberRouterAbi, data: data.data });
  const d = args[0].desc;
  const ok = functionName === 'swap'
    && getAddress(d.srcToken) === tokenIn && getAddress(d.dstToken) === tokenOut
    && d.amount === amountIn && getAddress(d.dstReceiver) === to
    && d.feeReceivers.length === 0 && d.minReturnAmount >= floor;
  if (!ok) throw new Error('KyberSwap route failed the safety checks');
  return { via: 'KyberSwap', to: KYBER_ROUTER, data: data.data, expected: amountOut, spender: KYBER_ROUTER };
}

function uniswapSwapTx(tokenIn, tokenOut, amountIn, expected, to) {
  return {
    via: 'Uniswap', to: UNI_ROUTER, expected, spender: UNI_ROUTER,
    data: encodeFunctionData({
      abi: uniRouterAbi, functionName: 'exactInputSingle',
      args: [{ tokenIn, tokenOut, fee: UNI_FEE, recipient: to, amountIn, amountOutMinimum: minOut(expected), sqrtPriceLimitX96: 0n }],
    }),
  };
}

// Approve `spender` for `amount` of an Ethereum token. USDT's approve reverts when changing one non-zero
// allowance to another, so for USDT reset to 0 first.
async function approveOnEthereum(token, spender, amount) {
  const name = tokenName(token);
  const allowanceOf = () => ethClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, spender] });
  const current = await allowanceOf();
  if (current >= amount) return;
  if (token === USDT_ETH && current > 0n) {
    setStatus(`Confirm resetting the USDT approval to 0 (USDT requires this before a new approval) ${inWallet()}…`);
    await sendWatched({
      client: ethClient, label: 'Approval reset', link: ethTx,
      send: () => wallet.writeContract({ account, chain: mainnet, address: token, abi: erc20Abi, functionName: 'approve', args: [spender, 0n] }),
      check: async () => (await allowanceOf()) === 0n,
    });
  }
  setStatus(`Confirm the ${name} approval ${inWallet()}…`);
  await sendWatched({
    client: ethClient, label: 'Approval', link: ethTx,
    send: () => wallet.writeContract({ account, chain: mainnet, address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    check: async () => (await allowanceOf()) >= amount,
  });
}

// Swap on Ethereum between USDT and USDC, signed by the connected wallet, paying `to`.
// Resolves to { received, via, hash }.
async function swapOnEthereum({ tokenIn, tokenOut, amountIn, to = account, step }) {
  const [inName, outName] = [tokenName(tokenIn), tokenName(tokenOut)];
  setStep(step, 'active');
  setStatus(`Finding the best ${inName} → ${outName} route…`);
  const q = await quotePair(tokenIn, tokenOut, amountIn);
  // Kyber's guaranteed minimum must not be below Uniswap's quote less slippage (or 1:1 less slippage
  // if Uniswap couldn't quote), so a bad route from the API can't lower the floor.
  const floor = minOut(q.uniOut ?? amountIn);
  let tx = null;
  if (q.via === 'KyberSwap') {
    try {
      await approveOnEthereum(tokenIn, KYBER_ROUTER, amountIn);
      tx = await kyberSwapTx(tokenIn, tokenOut, amountIn, floor, to);
    } catch (e) {
      if (isUserRejection(e)) throw e;
      console.warn('KyberSwap failed, falling back to Uniswap', e);
    }
  }
  if (!tx) {
    tx = uniswapSwapTx(tokenIn, tokenOut, amountIn, q.uniOut ?? await uniswapQuote(tokenIn, tokenOut, amountIn), to);
    await approveOnEthereum(tokenIn, UNI_ROUTER, amountIn);
  }
  setStatus(`Confirm the swap of ${fmt(amountIn)} ${inName} for about ${fmt(tx.expected)} ${outName} (${tx.via}) ${inWallet()}…`);
  const fromBlock = await ethClient.getBlockNumber();
  const r = await sendWatched({
    client: ethClient, label: 'Swap', link: ethTx,
    send: () => wallet.sendTransaction({ account, chain: mainnet, to: tx.to, data: tx.data }),
    check: async () => (await ethClient.getLogs({
      address: tokenOut, event: transferEvent, args: { to }, fromBlock,
    })).at(-1)?.transactionHash,
  });
  const received = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs })
    .filter((l) => l.address.toLowerCase() === tokenOut.toLowerCase() && l.args.to === to)
    .reduce((sum, l) => sum + l.args.value, 0n);
  if (received === 0n) throw new Error(`The swap delivered no ${outName}`);
  setStep(step, 'done');
  return { received, via: tx.via, hash: r.transactionHash };
}
const swapUsdtToUsdc = (amountIn) => swapOnEthereum({ tokenIn: USDT_ETH, tokenOut: USDC_ETH, amountIn, step: 'swapIn' });

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
  const dir = currentDir();
  for (const el of document.querySelectorAll('[data-dir]')) el.hidden = el.dataset.dir !== dir;
  $('finalChain').textContent = ROUTES[dir].srcName;
  if (dir === 'toEth') { quoteSeq++; refreshFormToEth(); return; }
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
  // Say whose address the recipient is.
  const typed = $('recipient').value.trim();
  $('recipientHint').textContent = !typed
    ? (account ? `Using your connected wallet (${short(account)}).` : '')
    : !isAddress(typed) ? ''
      : account && getAddress(typed) === account ? 'This is your connected wallet.'
        : account ? `Not your connected wallet (${short(account)}): make sure you control this address on Base.`
          : 'Make sure you control this address on Base.';
  // EURC needs the connected wallet to pay gas on Base for the swap (and a bit more with the top-up):
  // disable the options it can't afford at the current network price.
  const eurcRadio = document.querySelector('input[name=out][value=EURC]');
  const swapGas = gas ? GAS_UNITS.swap * gas.basePrice : 0n;
  const eurcOk = !gas || gas.base >= swapGas;
  const topUpOk = !gas || gas.base >= (GAS_UNITS.swap + GAS_UNITS.topUp) * gas.basePrice;
  eurcRadio.disabled = !eurcOk;
  if (eurcOk && preferredOut === 'EURC') eurcRadio.checked = true;
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

// Quotes for the Base → Ethereum form: { value, at } or { error, at } per key, refreshed every 30 s.
// The form keeps showing the last value while a refresh runs.
const quoteCache = new Map();
const quoteInFlight = new Set();
function cachedQuote(key, fn) {
  const c = quoteCache.get(key);
  if ((!c || Date.now() - c.at > 30_000) && !quoteInFlight.has(key)) {
    quoteInFlight.add(key);
    fn().then((value) => quoteCache.set(key, { value, at: Date.now() }))
      // A failed refresh keeps the last good value (with a fresh timestamp, so it isn't retried in a loop).
      .catch(() => quoteCache.set(key, { ...(c?.value ? { value: c.value } : { error: true }), at: Date.now() }))
      .finally(() => { quoteInFlight.delete(key); if (!busy) refreshForm(); });
  }
  return c ?? null;
}

function refreshFormToEth() {
  const srcB = currentSrcB();
  const out = currentOutE();
  const mode = currentMode();
  const amt = parseAmount();
  $('amountLabel').textContent = `Amount (${srcB})`;
  $('recipientLabel').textContent = out === 'USDT' ? 'USDT recipient on Ethereum' : 'Recipient on Ethereum';
  const typed = $('recipient').value.trim();
  $('recipientHint').textContent = !typed
    ? (account ? `Using your connected wallet (${short(account)}).` : '')
    : !isAddress(typed) ? ''
      : account && getAddress(typed) === account ? 'This is your connected wallet.'
        : account ? `Not your connected wallet (${short(account)}): make sure you control this address on Ethereum.`
          : 'Make sure you control this address on Ethereum.';

  // USDT out needs the connected wallet to pay Ethereum gas for the approval and the swap.
  const usdtRadio = document.querySelector('input[name=outE][value=USDT]');
  const usdtGas = gas ? (GAS_UNITS.approve + GAS_UNITS.usdtSwap) * gas.ethPrice : 0n;
  const usdtOk = !gas || gas.eth >= usdtGas;
  usdtRadio.disabled = !usdtOk;
  if (!usdtOk && usdtRadio.checked) document.querySelector('input[name=outE][value=USDC]').checked = true;
  $('usdtHint').textContent = usdtOk ? '· KyberSwap or Uniswap; needs a little ETH on Ethereum for gas'
    : `· needs ETH on Ethereum for gas: you have ${fmtEth(gas.eth)}, the swap takes about ${fmtEth(usdtGas)}`;

  // USDC that reaches the burn: the amount itself, or the EURC → USDC quote.
  let usdc = amt;
  let eurcNote = '';
  let quoteState = null;
  if (srcB === 'EURC' && amt) {
    const q = cachedQuote(`eurcIn:${amt}`, () => quoteEurcToUsdc(amt));
    usdc = q?.value?.amountOut ?? null;
    quoteState = q?.error && !q.value ? 'error' : 'loading';
    if (usdc) eurcNote = `${fmt(amt)} EURC → about ${fmt(usdc)} USDC on Aerodrome`;
  }

  for (const m of ['fast', 'standard']) {
    const fee = feesToEth ? maxFeeFor(usdc ?? 0n, m, feesToEth) : null;
    $(m === 'fast' ? 'feeFast' : 'feeStd').textContent = fee === null ? ''
      : `· fee ≤ ${fmt(fee + TO_ETH_FEE_TOLERANCE)} USDC`;
  }

  let label = 'Bridge to Ethereum';
  let ok = !!account && !!amt && !!feesToEth;
  let receive = '';
  if (!feesToEth) {
    label = 'Loading fees…';
  } else if (amt && !usdc) {
    ok = false;
    label = quoteState === 'error' ? 'No EURC → USDC route right now' : 'Getting EURC → USDC quote…';
  } else if (amt) {
    const fee = maxFeeFor(usdc, mode, feesToEth);
    if (usdc <= fee) {
      ok = false;
      label = 'Amount must be larger than the fee';
    } else if (out === 'USDT') {
      const q = cachedQuote(`usdtOut:${usdc - fee}`, () => quotePair(USDC_ETH, USDT_ETH, usdc - fee));
      const usdt = q?.value?.amountOut;
      const rate = usdt && srcB === 'EURC' ? ` Effective EUR/USD ${eurUsd(usdt, amt)}, all fees included.` : '';
      receive = usdt
        ? `You receive about ${fmt(usdt)} USDT on Ethereum (${eurcNote ? `${eurcNote}, then ` : ''}Circle's fee, then USDC → USDT via ${q.value.via}).${rate}`
        : q?.error ? 'Could not get a USDC → USDT quote right now.' : 'Getting USDC → USDT quote…';
    } else if (eurcNote) {
      receive = `You receive about ${fmt(usdc - fee)} USDC on Ethereum (${eurcNote}, then Circle's fee). Effective EUR/USD ${eurUsd(usdc - fee, amt)}, all fees included.`;
    } else {
      receive = `You receive at least ${fmt(usdc - fee - TO_ETH_FEE_TOLERANCE)} USDC on Ethereum`;
    }
  }
  if (receive !== $('receive').textContent) $('receive').textContent = receive;

  let gasWarn = '';
  const balance = srcB === 'EURC' ? balanceEurc : balanceBaseUsdc;
  if (account && amt && amt > balance) {
    ok = false;
    label = `Insufficient ${srcB} on Base`;
  } else if (account && amt && usdc && gas) {
    const baseUnits = (srcB === 'EURC' ? GAS_UNITS.swap : 0n) + (baseAllowance < usdc ? GAS_UNITS.approve : 0n) + GAS_UNITS.burn;
    if (gas.base < baseUnits * gas.basePrice) {
      ok = false;
      label = 'Not enough ETH for gas on Base';
    } else {
      const baseWallet = baseUnits * max(gas.basePrice, WALLET_MIN_GAS_PRICE_BASE);
      const ethWallet = (GAS_UNITS.approve + GAS_UNITS.usdtSwap) * max(gas.ethPrice, WALLET_MIN_GAS_PRICE_ETH);
      if (gas.base < baseWallet) {
        gasWarn = `Low ETH for gas on Base: you have ${fmtEth(gas.base)} ETH, and wallets may ask for about ${fmtEth(baseWallet)} ETH.`;
      } else if (out === 'USDT' && gas.eth < ethWallet) {
        gasWarn = `Low ETH for the swap gas on Ethereum: you have ${fmtEth(gas.eth)} ETH, and wallets may ask for about ${fmtEth(ethWallet)} ETH.`;
      }
    }
  }
  if (gasWarn !== $('gasWarn').textContent) $('gasWarn').textContent = gasWarn;
  $('bridge').disabled = !ok;
  $('bridge').textContent = label;
}

// ---------- wallet ----------

// Injected wallet (browser extension or wallet in-app browser) if present, else WalletConnect
// so mobile wallet apps like Rabby can connect via QR code or deep link. With an extension present,
// the separate WalletConnect button (useWc) still lets a phone wallet connect.
// silent: only reconnect what was connected before, without prompts or a QR code; null if nothing.
async function getProvider(silent = false, useWc = false) {
  if (window.ethereum && !useWc) {
    if (silent) {
      if (!(await window.ethereum.request({ method: 'eth_accounts' }))?.length) return null;
    } else {
      await window.ethereum.request({ method: 'eth_requestAccounts' });
    }
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
  // A stored session is restored by init(); reuse it rather than pairing again.
  if (silent && !provider.session) return null;
  if (isMobile && !provider.session) {
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
  if (!provider.session) {
    try {
      await (isMobile
        ? Promise.race([provider.enable(), new Promise((_, reject) => { $('wcCancel').onclick = () => reject(new Error('cancelled')); })])
        : provider.enable());
    } finally {
      $('wcMobile').hidden = true;
    }
  }
  provider.on('disconnect', () => {
    wcProvider = null;
    wallet = null;
    setAccount(null);
    try { localStorage.removeItem(WALLET_KEY); } catch {} // ended in the wallet: don't try to restore it
  });
  viaWalletConnect = true;
  wcProvider = provider;
  return provider;
}

async function connect(silent = false, useWc = false) {
  const provider = await getProvider(silent, useWc);
  if (!provider) return;
  wallet = createWalletClient({ transport: custom(provider) });
  const [addr] = silent ? await wallet.getAddresses() : await wallet.requestAddresses();
  if (!addr) return;
  setAccount(addr);
  try { localStorage.setItem(WALLET_KEY, viaWalletConnect ? 'walletconnect' : 'injected'); } catch {}
  if (!listening.has(provider)) {
    listening.add(provider);
    // Follow account switches in the wallet, unless the user disconnected it here.
    provider.on?.('accountsChanged', (accs) => { if (wallet) setAccount(accs[0] ?? null); });
  }
}
const listening = new WeakSet();

// Disconnect: end a WalletConnect session, or ask an extension wallet to forget this site where it supports
// that (MetaMask, Rabby); either way the page stops using the wallet and won't reconnect it on reload.
async function disconnect() {
  if (busy || !account) return;
  const p = wcProvider;
  wcProvider = null;
  wallet = null;
  setAccount(null);
  try { localStorage.removeItem(WALLET_KEY); } catch {}
  try {
    if (p) await p.disconnect();
    else await window.ethereum?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
  } catch (e) {
    console.warn('disconnect', e);
  }
}

function setAccount(addr) {
  account = addr ? getAddress(addr) : null;
  $('account').textContent = account ? `Connected${viaWalletConnect ? ' via WalletConnect' : ''}: ${short(account)}` : 'Not connected';
  $('connect').textContent = account ? 'Disconnect' : 'Connect wallet';
  $('connect').disabled = false;
  // A separate WalletConnect button, only when the main one would use the extension.
  $('connectWc').hidden = !!account || !window.ethereum;
  $('balances').hidden = !account;
  refreshBalances();
}

async function refreshBalances() {
  if (!account) { balanceEth = 0n; balanceUsdt = 0n; gas = null; refreshForm(); return; }
  const [e, b, eu, ge, gb, al, fe, fb, ut, ba] = await Promise.allSettled([
    ethClient.readContract({ address: USDC_ETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    baseClient.readContract({ address: EURC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    ethClient.getBalance({ address: account }),
    baseClient.getBalance({ address: account }),
    ethClient.readContract({ address: USDC_ETH, abi: erc20Abi, functionName: 'allowance', args: [account, TOKEN_MESSENGER] }),
    ethClient.estimateFeesPerGas(),
    baseClient.estimateFeesPerGas(),
    ethClient.readContract({ address: USDT_ETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'allowance', args: [account, TOKEN_MESSENGER] }),
  ]);
  balanceEurc = eu.status === 'fulfilled' ? eu.value : 0n;
  baseAllowance = ba.status === 'fulfilled' ? ba.value : 0n;
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
    const route = async (src, dst, tier) => {
      const list = await (await fetch(`${IRIS}/v2/burn/USDC/fees/${src}/${dst}?forward=true`)).json();
      const pick = (threshold) => {
        const f = list.find((x) => x.finalityThreshold === threshold);
        if (!f?.forwardFee) throw new Error('missing forward fee');
        return { bps: f.minimumFee, forward: BigInt(f.forwardFee[tier]) };
      };
      return { fast: pick(FINALITY.fast), standard: pick(FINALITY.standard) };
    };
    // Ethereum → Base: the "high" forwarding tier (cents either way). Base → Ethereum: "med", the tier Circle's docs
    // recommend as the minimum; "high" costs about $0.2 more there because Circle pays Ethereum gas.
    [fees, feesToEth] = await Promise.all([route(DOMAIN_ETH, DOMAIN_BASE, 'high'), route(DOMAIN_BASE, DOMAIN_ETH, 'med')]);
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
        onHash: (hash) => { unburned = null; savePending({ hash, dir: 'toBase', out, eurcTo }); },
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
  // The saved transfer says which direction it went; otherwise go by the direction switch.
  const saved = savedPending();
  const same = saved?.hash === hash;
  const dir = same && saved.dir ? saved.dir : currentDir();
  resetSteps(dir);
  for (const st of ['swapIn', 'approve', 'burn']) setStep(st, 'done');
  try {
    if (dir === 'toEth') {
      const r = $('recipient').value.trim();
      const to = same && saved.to ? saved.to : isAddress(r) ? getAddress(r) : account;
      await finishToEth(await track(hash, null, 'toEth'), same ? saved.out : currentOutE(), to);
      return;
    }
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
async function track(burnHash, mode, dir = 'toBase') {
  const route = ROUTES[dir];
  const srcTx = dir === 'toEth' ? baseTx : ethTx;
  setStep('attest', 'active');
  const wait = mode === 'standard' ? 'usually 15–20 minutes' : mode === 'fast' ? 'usually under a minute' : 'this can take a while';
  setStatus(`Waiting for Circle to attest the burn (${wait}). You can close this page and resume later with ${srcTx(burnHash)}.`);

  const url = `${IRIS}/v2/messages/${route.srcDomain}?transactionHash=${burnHash}`;
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

    if (m && m.decodedMessage && Number(m.decodedMessage.destinationDomain) !== route.dstDomain) {
      throw new Error(`This burn is not destined for ${route.dstName}.`);
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
        setStatus(`Attested. Waiting for Circle to mint on ${route.dstName}…`);
      }
      pendingMint = { message: m.message, attestation: m.attestation, nonce: m.eventNonce, dir };
      if (Date.now() - attestedAt > FORWARD_GRACE_MS) {
        // Covers both a manual mint from this page and one made elsewhere.
        if (await alreadyMinted(m.eventNonce, dir)) {
          setStep('mint', 'done');
          $('manualMint').hidden = true;
          return { message: m, mintTx: manualMintTx };
        }
        if ($('manualMint').hidden && !manualMintTx) {
          setStatus(`Circle hasn't forwarded this transfer yet. You can keep waiting, or mint it yourself on ${route.dstName} (needs a little ETH on ${route.dstName} for gas).`);
          $('manualMint').hidden = false;
        }
      }
    }

    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function alreadyMinted(nonce, dir = 'toBase') {
  if (!nonce) return false;
  try {
    const used = await (dir === 'toEth' ? ethClient : baseClient).readContract({
      address: MESSAGE_TRANSMITTER, abi: transmitterAbi, functionName: 'usedNonces', args: [nonce],
    });
    return used !== 0n;
  } catch {
    return false;
  }
}

// Fallback only: mint on the destination chain from the connected wallet.
async function manualMint() {
  if (!pendingMint) return;
  const { message, attestation, nonce, dir } = pendingMint;
  const toEth = dir === 'toEth';
  const [chain, client, link, name] = toEth ? [mainnet, ethClient, ethTx, 'Ethereum'] : [base, baseClient, baseTx, 'Base'];
  try {
    if (!wallet) await connect();
    if (!account) return;
    $('manualMint').hidden = true;
    if (await alreadyMinted(nonce, dir)) {
      setStatus(`Already minted on ${name}, finishing up…`);
      return; // track() notices on its next poll
    }
    await ensureChain(chain);
    setStatus(`Confirm the mint on ${name} ${inWallet()}…`);
    const r = await sendWatched({
      client, label: 'Mint', link,
      send: () => wallet.writeContract({
        account, chain, address: MESSAGE_TRANSMITTER, abi: transmitterAbi,
        functionName: 'receiveMessage', args: [message, attestation],
      }),
      check: () => alreadyMinted(nonce, dir),
    });
    manualMintTx = r?.transactionHash ?? null;
    setStatus(`Minted on ${name}${r ? ` ${link(r.transactionHash)}` : ''}, finishing up…`);
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

// ---------- Base → Ethereum ----------

const currentSrcB = () => document.querySelector('input[name=srcB]:checked').value;
const currentOutE = () => document.querySelector('input[name=outE]:checked').value;
let pendingUsdt = null; // { signer, amountIn, to, sent, sentAmount, fromEurc, before, fee } for the USDC → USDT swap on Ethereum

// Smart-contract wallets may not control the same address on the other chain.
// EIP-7702 delegated EOAs (code prefix 0xef0100) are fine.
async function isContractOn(client, addr) {
  const code = await client.getCode({ address: addr });
  return !!code && code !== '0x' && !code.toLowerCase().startsWith('0xef0100');
}

// Approve `spender` for `amount` of a Base token, then give the wallet's node two blocks to see it
// (wallets simulate the next transaction before showing it).
async function approveOnBase(token, name, spender, amount) {
  const allowanceOf = () => baseClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, spender] });
  if ((await allowanceOf()) >= amount) return false;
  setStatus(`Confirm the ${name} approval ${inWallet()}…`);
  await sendWatched({
    client: baseClient, label: 'Approval', link: baseTx,
    send: () => wallet.writeContract({ account, chain: base, address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    check: async () => (await allowanceOf()) >= amount,
  });
  const approvedAt = await baseClient.getBlockNumber();
  while ((await baseClient.getBlockNumber()) < approvedAt + 2n) await sleep(1000);
  return true;
}

// Swap EURC to USDC on Aerodrome, into the connected wallet. Resolves to { received, hash }.
async function swapEurcToUsdcOnBase(amountIn) {
  setStep('swapIn', 'active');
  await approveOnBase(EURC_BASE, 'EURC', AERO_ROUTER, amountIn);
  const { amountOut, tickSpacing } = await quoteEurcToUsdc(amountIn);
  const deadline = (await baseClient.getBlock()).timestamp + 20n * 60n; // Base's clock, not the computer's
  setStatus(`Confirm the swap of ${fmt(amountIn)} EURC for about ${fmt(amountOut)} USDC ${inWallet()}…`);
  const fromBlock = await baseClient.getBlockNumber();
  const r = await sendWatched({
    client: baseClient, label: 'Swap', link: baseTx,
    send: () => wallet.writeContract({
      account, chain: base, address: AERO_ROUTER, abi: routerAbi, functionName: 'exactInputSingle',
      args: [{ tokenIn: EURC_BASE, tokenOut: USDC_BASE, tickSpacing, recipient: account, deadline, amountIn, amountOutMinimum: minOut(amountOut), sqrtPriceLimitX96: 0n }],
    }),
    check: async () => (await baseClient.getLogs({ address: USDC_BASE, event: transferEvent, args: { to: account }, fromBlock })).at(-1)?.transactionHash,
  });
  const received = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs })
    .filter((l) => l.address.toLowerCase() === USDC_BASE.toLowerCase() && l.args.to === account)
    .reduce((sum, l) => sum + l.args.value, 0n);
  if (received === 0n) throw new Error('The swap delivered no USDC');
  setStep('swapIn', 'done');
  return { received, hash: r.transactionHash };
}

async function bridgeToEth() {
  let amount = parseAmount();
  if (!amount || !feesToEth || !account) return;
  const srcB = currentSrcB();
  const out = currentOutE();
  const mode = currentMode();
  // USDC the user saw quoted (for EURC, the Aerodrome quote); fees are checked against it.
  const shownUsdc = srcB === 'EURC' ? quoteCache.get(`eurcIn:${amount}`)?.value?.amountOut : amount;
  if (!shownUsdc) return;
  let recipient = $('recipient').value.trim() || null;
  if (recipient) {
    if (!isAddress(recipient)) { alert('Recipient is not a valid address.'); return; }
    recipient = getAddress(recipient);
  }
  const dest = recipient ?? account;
  // For USDT the USDC is minted to the connected wallet, which signs the swap on Ethereum.
  const mintTo = out === 'USDT' ? account : dest;
  if (mintTo === account && await isContractOn(baseClient, account)) {
    alert('Your account is a smart-contract wallet on Base, which may not exist at the same address on Ethereum. Enter a recipient address you control on Ethereum (and receive USDC).');
    return;
  }
  await askNotifications();

  $('bridge').disabled = true;
  resetSteps('toEth');
  busy = true;
  // Never charge more than the "fee ≤" the user saw, which includes the route's tolerance.
  const allowedFee = maxFeeFor(shownUsdc, mode, feesToEth) + TO_ETH_FEE_TOLERANCE;
  let source = null; // { amount, hash } when paid with EURC
  let unburned = null; // USDC from the EURC swap that hasn't been burned yet
  try {
    await ensureChain(base);

    // 0. EURC → USDC on Aerodrome.
    if (srcB === 'EURC') {
      const r = await swapEurcToUsdcOnBase(amount);
      source = { amount, hash: r.hash };
      amount = r.received;
      unburned = amount;
      refreshBalances();
    }

    if (!(await loadFees())) throw new Error('Could not load current fees from Circle. Try again.');
    const maxFee = maxFeeFor(amount, mode, feesToEth);
    const swapped = source ? `Swapped to ${fmt(amount)} USDC. ` : '';
    if (maxFee > allowedFee) throw new Error(`${swapped}Circle's fee just went up from ${fmt(allowedFee)} to ${fmt(maxFee)} USDC. Click Bridge again to accept it.`);
    if (amount <= maxFee) throw new Error(`${swapped}Amount must be larger than the fee.`);

    // 1. Approve USDC for Circle's TokenMessenger on Base
    setStep('approve', 'active');
    setStep('approve', (await approveOnBase(USDC_BASE, 'USDC', TOKEN_MESSENGER, amount)) ? 'done' : 'skipped');

    // 2. Burn on Base, with the forwarding hook so Circle mints on Ethereum
    setStep('burn', 'active');
    setStatus(`Confirm the burn ${inWallet()}…`);
    const fromBlock = await baseClient.getBlockNumber();
    let burnHash;
    try {
      ({ transactionHash: burnHash } = await sendWatched({
        client: baseClient, label: 'Burn', link: baseTx,
        send: () => wallet.writeContract({
          account, chain: base, address: TOKEN_MESSENGER, abi: tokenMessengerAbi,
          functionName: 'depositForBurnWithHook',
          args: [amount, DOMAIN_ETH, pad(mintTo, { size: 32 }), USDC_BASE, zeroHash, maxFee, FINALITY[mode], FORWARD_HOOK],
        }),
        check: async () => {
          const logs = await baseClient.getLogs({ address: TOKEN_MESSENGER, event: depositForBurnEvent, args: { depositor: account }, fromBlock });
          return logs.find((l) => l.args.amount === amount)?.transactionHash;
        },
        onHash: (hash) => { unburned = null; savePending({ hash, dir: 'toEth', out, to: dest }); },
      }));
    } catch (e) {
      if (/rejected|denied|reverted/i.test(errMsg(e))) clearPending(); // keep it on transient RPC errors
      throw e;
    }
    setStep('burn', 'done');
    refreshBalances();

    await finishToEth(await track(burnHash, mode, 'toEth'), out, dest, source);
  } catch (e) {
    console.error(e);
    setStatus(errMsg(e), 'err');
    // Stopped after the EURC swap but before the burn: set the form to bridge that USDC.
    if (unburned) {
      document.querySelector('input[name=srcB][value=USDC]').checked = true;
      $('amount').value = formatUnits(unburned, 6);
    }
  } finally {
    busy = false;
    refreshForm();
  }
}

// After the USDC is on Ethereum: done, or continue with the USDC → USDT swap.
async function finishToEth({ message: m, mintTx }, out, dest, source = null) {
  clearPending();
  refreshBalances();
  const mintLink = mintTx ? ` ${ethTx(mintTx)}` : '';
  const body = m.decodedMessage?.decodedMessageBody;
  if (!body?.amount || !body?.mintRecipient) {
    setStatus(out === 'USDT'
      ? `USDC is on Ethereum${mintLink}, but the transfer amount couldn't be read, so no swap was made.`
      : `Done! USDC minted on Ethereum${mintLink}.`, out === 'USDT' ? 'err' : 'ok');
    return;
  }
  const burned = BigInt(body.amount);
  const fee = BigInt(body.feeExecuted ?? body.maxFee ?? 0);
  const minted = burned - fee;
  const signer = getAddress(`0x${body.mintRecipient.slice(-40)}`);
  const sent = source ? `${fmt(source.amount)} EURC` : `${fmt(burned)} USDC`;
  const before = source ? `EURC → ${fmt(burned)} USDC on Aerodrome ${baseTx(source.hash)}, ` : '';
  if (out !== 'USDT') {
    const forWhom = signer === account ? '' : ` for ${short(signer)}`;
    // Paid with EURC: the end-to-end rate is USD received per EUR sent, all fees included.
    const rate = source ? ` Effective EUR/USD ${eurUsd(minted, source.amount)}, all fees included.` : '';
    setStatus(`Done! ${sent} → ${fmt(minted)} USDC on Ethereum${forWhom}${mintLink}. Fees: ${before}Circle's fee ${fmt(fee)} USDC.${rate}`, 'ok');
    return;
  }
  // Swap only what this transfer delivered, never other USDC in the wallet.
  pendingUsdt = { signer, amountIn: minted, to: dest, sent, sentAmount: source?.amount ?? null, before, fee, mintLink };
  setStatus(`${fmt(minted)} USDC minted on Ethereum${mintLink}. Now swapping to USDT…`);
  await swapToUsdt();
}

// Swap the bridged USDC to USDT on Ethereum (KyberSwap or Uniswap), signed by the wallet the USDC
// was minted to, paying the recipient.
async function swapToUsdt() {
  if (!pendingUsdt) return;
  const p = pendingUsdt;
  $('retrySwap').hidden = true;
  try {
    if (!wallet) await connect();
    if (!account) throw new Error('Connect your wallet to swap.');
    if (p.signer !== account) throw new Error(`The USDC went to ${short(p.signer)}. Connect that wallet to swap.`);
    const balance = await ethClient.readContract({ address: USDC_ETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
    const amountIn = balance < p.amountIn ? balance : p.amountIn;
    if (amountIn === 0n) throw new Error('No USDC on Ethereum to swap.');
    if ((await ethClient.getBalance({ address: account })) === 0n) {
      throw new Error('You need a little ETH on Ethereum to pay gas for the swap. Your USDC is already on Ethereum; add some ETH and retry.');
    }
    await ensureChain(mainnet);
    const r = await swapOnEthereum({ tokenIn: USDC_ETH, tokenOut: USDT_ETH, amountIn, to: p.to, step: 'swap' });
    pendingUsdt = null;
    const forWhom = p.to === account ? '' : ` for ${short(p.to)}`;
    // The figures are only end-to-end if the whole delivered amount was swapped.
    const whole = amountIn === p.amountIn;
    const rate = whole && p.sentAmount ? ` Effective EUR/USD ${eurUsd(r.received, p.sentAmount)}, all fees included.` : '';
    setStatus(whole
      ? `Done! ${p.sent} → ${fmt(r.received)} USDT on Ethereum${forWhom}. Fees: ${p.before}Circle's fee ${fmt(p.fee)} USDC${p.mintLink}, then USDC → USDT via ${r.via} ${ethTx(r.hash)}.${rate}`
      : `Done! Swapped ${fmt(amountIn)} USDC to ${fmt(r.received)} USDT${forWhom} via ${r.via} ${ethTx(r.hash)}.`, 'ok');
    refreshBalances();
  } catch (e) {
    console.error(e);
    setStatus(`Swap failed: ${errMsg(e)} Your USDC is safe on Ethereum.`, 'err');
    $('retrySwap').hidden = false;
  }
}

// ---------- pending-burn persistence ----------

// { hash, dir, out, eurcTo (Ethereum → Base) | to (Base → Ethereum) }
function savePending(p) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch {}
}
function savedPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (raw.startsWith('{') ? JSON.parse(raw) : { hash: raw, out: 'USDC' }) : null;
  } catch { return null; }
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
      const { hash, out, dir } = raw.startsWith('{') ? JSON.parse(raw) : { hash: raw, out: 'USDC' };
      $('resumeHash').value = hash;
      $('resumeHash').closest('details').open = true;
      if (dir === 'toEth') {
        document.querySelector('input[name=dir][value=toEth]').checked = true;
        if (out === 'USDT') document.querySelector('input[name=outE][value=USDT]').checked = true;
      } else if (out === 'EURC') { preferredOut = 'EURC'; document.querySelector('input[name=out][value=EURC]').checked = true; }
    }
  } catch {}
}

// ---------- form persistence ----------

function saveForm() {
  const v = (name) => document.querySelector(`input[name=${name}]:checked`).value;
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify({
      dir: v('dir'), src: v('src'), srcB: v('srcB'), outE: v('outE'),
      amount: $('amount').value, out: preferredOut, mode: v('mode'), topUp: topUpTouched ? $('topUp').checked : null,
    }));
  } catch {}
}
function loadForm() {
  try {
    const f = JSON.parse(localStorage.getItem(FORM_KEY) ?? 'null');
    if (f) {
      const pick = (name, value) => { const el = document.querySelector(`input[name=${name}][value="${value}"]`); if (el) el.checked = true; };
      pick('dir', f.dir);
      pick('src', f.src);
      pick('srcB', f.srcB);
      pick('outE', f.outE);
      pick('mode', f.mode);
      if (f.amount) $('amount').value = f.amount;
      preferredOut = f.out === 'EURC' ? 'EURC' : 'USDC';
      pick('out', preferredOut);
      if (f.topUp !== null && f.topUp !== undefined) { topUpTouched = true; $('topUp').checked = f.topUp; }
    }
    const to = localStorage.getItem(RECIPIENT_KEY);
    if (to) $('recipient').value = to;
  } catch {}
}

// ---------- wire up ----------

$('connect').onclick = async () => {
  try {
    if (account) await disconnect();
    else await connect();
  } catch (e) {
    if (e?.message !== 'cancelled') alert(errMsg(e));
  }
};
$('connectWc').onclick = async () => {
  try {
    await connect(false, true);
  } catch (e) {
    if (e?.message !== 'cancelled') alert(errMsg(e));
  }
};
$('bridge').onclick = () => (currentDir() === 'toEth' ? bridgeToEth() : bridge());
$('resume').onclick = resume;
$('manualMint').onclick = manualMint;
$('retrySwap').onclick = () => (pendingUsdt ? swapToUsdt() : swapToEurc());
$('sweep').onclick = sweep;
$('amount').oninput = () => { refreshForm(); saveForm(); };
$('recipient').oninput = () => {
  refreshForm();
  const r = $('recipient').value.trim();
  try { if (!r) localStorage.removeItem(RECIPIENT_KEY); else if (isAddress(r)) localStorage.setItem(RECIPIENT_KEY, getAddress(r)); } catch {}
};
$('topUp').onchange = () => { topUpTouched = true; refreshForm(); saveForm(); };
$('max').onclick = () => {
  const balance = currentDir() === 'toEth'
    ? (currentSrcB() === 'EURC' ? balanceEurc : balanceBaseUsdc)
    : (currentSrc() === 'USDT' ? balanceUsdt : balanceEth);
  $('amount').value = formatUnits(balance, 6);
  refreshForm();
  saveForm();
};
for (const r of document.querySelectorAll('input[name=mode], input[name=out], input[name=src], input[name=dir], input[name=srcB], input[name=outE]')) {
  r.onchange = () => {
    if (r.name === 'out') preferredOut = r.value;
    refreshForm();
    saveForm();
  };
}

// The deploy workflow stamps the commit into the footer; unstamped (local) copies link to the repo.
if ($('commit').textContent.startsWith('__')) {
  $('commit').textContent = 'dev';
  $('commit').href = 'https://github.com/SwapMarket/eth2base';
}

loadForm();
loadPending();
loadFees();
// Reconnect the wallet used last time (extension: silently; WalletConnect: the stored session, no QR).
try {
  const kind = localStorage.getItem(WALLET_KEY);
  if (kind) connect(true, kind === 'walletconnect').catch((e) => console.warn('reconnect', e));
} catch {}
$('connectWc').hidden = !window.ethereum;
setInterval(() => { loadFees(); refreshBalances(); }, 30_000);
