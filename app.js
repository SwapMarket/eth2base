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
  zeroHash,
} from 'https://esm.sh/viem@2.21.55';
import { mainnet, base } from 'https://esm.sh/viem@2.21.55/chains';

// CCTP V2 (same addresses on every supported chain).
const TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const MESSAGE_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EURC_BASE = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';
// Aerodrome Slipstream (concentrated liquidity) on Base; USDC/EURC liquidity sits in these tick spacings.
const AERO_ROUTER = '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5';
const AERO_QUOTER = '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0';
const AERO_TICK_SPACINGS = [1, 50];
const SLIPPAGE_BPS = 50n; // 0.5%
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
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);

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
let pendingMint = null; // { message, attestation, nonce } for the manual fallback
let manualMintTx = null;
let viaWalletConnect = false;
let wcProvider = null;
let pendingSwap = null; // { burned, amountIn, recipient } for the EURC swap

// ---------- UI helpers ----------

function setStatus(html, kind = '') {
  $('status').className = 'status ' + kind;
  $('status').innerHTML = html;
}

function setStep(name, state) {
  const li = document.querySelector(`#steps li[data-step="${name}"]`);
  li.classList.remove('active', 'done', 'skipped');
  if (state) li.classList.add(state);
}

function resetSteps() {
  for (const li of document.querySelectorAll('#steps li')) li.className = '';
  document.querySelector('#steps li[data-step="swap"]').hidden = currentOut() !== 'EURC';
  $('manualMint').hidden = true;
  $('retrySwap').hidden = true;
  manualMintTx = null;
  pendingSwap = null;
  $('progress').hidden = false;
}

const fmt = (v) => Number(formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtEth = (v) => Number(formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 });
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

// Best USDC→EURC quote across the Aerodrome Slipstream pools: { amountOut, tickSpacing }.
async function quoteEurc(amountIn) {
  const quotes = await Promise.allSettled(AERO_TICK_SPACINGS.map((tickSpacing) =>
    baseClient.simulateContract({
      address: AERO_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: USDC_BASE, tokenOut: EURC_BASE, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
    }).then(({ result }) => ({ amountOut: result[0], tickSpacing }))));
  const ok = quotes.filter((q) => q.status === 'fulfilled').map((q) => q.value);
  if (!ok.length) throw new Error('No Aerodrome quote for USDC → EURC');
  return ok.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
}

let quoteSeq = 0;
let quoteTimer = null;
// End-to-end EUR/USD: USDC sent from Ethereum per EURC received on Base, all fees included.
const eurUsd = (usdcSent, eurcOut) => (Number(usdcSent) / Number(eurcOut)).toFixed(4);

function showEurcQuote(usdcSent, usdcIn) {
  const seq = ++quoteSeq;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    let text;
    try {
      const { amountOut } = await quoteEurc(usdcIn);
      text = `You receive about ${fmt(amountOut)} EURC on Base. Effective EUR/USD ${eurUsd(usdcSent, amountOut)}, all fees included (at least ${fmt(usdcIn)} USDC swapped at the current Aerodrome rate, max ${Number(SLIPPAGE_BPS) / 100}% slippage)`;
    } catch (e) {
      text = 'Could not get an Aerodrome quote right now.';
    }
    if (seq === quoteSeq) $('receive').textContent = text;
  }, 400);
}

// Max total fee (CCTP protocol fee + Circle forwarding fee, "high" tier) in USDC base units.
// With forwarding, Circle charges the full maxFee, so there is no extra buffer.
// It is deducted from the burned amount on Base, never charged on top.
function maxFeeFor(amount, mode) {
  const { bps, forward } = fees[mode];
  const ppm = BigInt(Math.ceil(bps * 100));
  const protocol = (amount * ppm + 999_999n) / 1_000_000n;
  return protocol + forward;
}

function refreshForm() {
  quoteSeq++; // drop any in-flight EURC quote
  const amt = parseAmount();
  for (const mode of ['fast', 'standard']) {
    const el = $(mode === 'fast' ? 'feeFast' : 'feeStd');
    el.textContent = fees ? `· fee ≤ ${fmt(maxFeeFor(amt ?? 0n, mode))} USDC` : '';
  }

  let label = 'Bridge to Base';
  let ok = !!account && !!amt && !!fees;
  $('receive').textContent = '';
  if (!fees) {
    label = 'Loading fees…';
  } else if (amt) {
    const fee = maxFeeFor(amt, currentMode());
    if (amt <= fee) {
      ok = false;
      label = 'Amount must be larger than the fee';
    } else if (currentOut() === 'EURC') {
      $('receive').textContent = 'Getting Aerodrome quote…';
      showEurcQuote(amt, amt - fee);
    } else {
      $('receive').textContent = `You receive at least ${fmt(amt - fee)} USDC on Base`;
    }
  }
  if (account && amt && amt > balanceEth) {
    ok = false;
    label = 'Insufficient USDC on Ethereum';
  }
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
      url: location.origin,
      icons: [new URL('icon.png', location.href).href],
    },
  });
  if (isMobile) {
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
  if (!account) { balanceEth = 0n; refreshForm(); return; }
  const [e, b, eu, ge, gb] = await Promise.allSettled([
    ethClient.readContract({ address: USDC_ETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    baseClient.readContract({ address: EURC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    ethClient.getBalance({ address: account }),
    baseClient.getBalance({ address: account }),
  ]);
  balanceEth = e.status === 'fulfilled' ? e.value : 0n;
  $('balEth').textContent = e.status === 'fulfilled' ? fmt(e.value) : 'error';
  $('balBase').textContent = b.status === 'fulfilled' ? fmt(b.value) : 'error';
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
  const sent = send();
  sent.catch(() => {}); // a rejection still reaches the race below
  const seen = (async () => {
    while (watching) {
      await sleep(4000);
      try {
        const r = await check();
        if (r) return r;
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
    fees = null;
  }
  refreshForm();
}

async function bridge() {
  const amount = parseAmount();
  if (!amount || !fees) return;
  const mode = currentMode();

  let recipient = $('recipient').value.trim();
  if (recipient) {
    if (!isAddress(recipient)) { alert('Recipient is not a valid address.'); return; }
    recipient = getAddress(recipient);
  } else {
    if (await isContractAccount(account)) {
      alert('Your account is a smart-contract wallet, which may not exist at the same address on Base. Enter a recipient address you control on Base.');
      return;
    }
    recipient = account;
  }
  const out = currentOut();
  if (out === 'EURC' && recipient !== account) {
    alert('To receive EURC, the recipient must be your connected address: the swap on Base is signed by the wallet that receives the USDC.');
    return;
  }

  $('bridge').disabled = true;
  resetSteps();
  try {
    await ensureChain(mainnet);
    await loadFees(); // forwarding fee tracks Base gas, so refresh right before burning
    if (!fees) throw new Error('Could not load current fees from Circle. Try again.');
    const maxFee = maxFeeFor(amount, mode);
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
          args: [amount, DOMAIN_BASE, pad(recipient, { size: 32 }), USDC_ETH, zeroHash, maxFee, FINALITY[mode], FORWARD_HOOK],
        }),
        check: async () => {
          const logs = await ethClient.getLogs({
            address: TOKEN_MESSENGER, event: depositForBurnEvent, args: { depositor: account }, fromBlock,
          });
          return logs.find((l) => l.args.amount === amount)?.transactionHash;
        },
        onHash: (hash) => savePending(hash, out),
      }));
    } catch (e) {
      if (/rejected|denied|reverted/i.test(errMsg(e))) clearPending(); // keep it on transient RPC errors
      throw e;
    }
    setStep('burn', 'done');
    refreshBalances();

    await finish(await track(burnHash, mode), out);
  } catch (e) {
    console.error(e);
    setStatus(errMsg(e), 'err');
  } finally {
    refreshForm();
  }
}

async function resume() {
  const hash = $('resumeHash').value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) { alert('Enter a valid transaction hash.'); return; }
  resetSteps();
  setStep('approve', 'done');
  setStep('burn', 'done');
  try {
    await finish(await track(hash), currentOut());
  } catch (e) {
    console.error(e);
    setStatus(errMsg(e), 'err');
  }
}

// After the USDC is on Base: done, or continue with the Aerodrome swap.
async function finish({ message: m, mintTx }, out) {
  clearPending();
  refreshBalances();
  const minted = mintTx ? `USDC minted on Base ${baseTx(mintTx)}` : 'USDC is on Base';
  if (out !== 'EURC') {
    setStatus(`Done! ${minted}.`, 'ok');
    return;
  }
  const body = m.decodedMessage?.decodedMessageBody;
  if (!body?.amount || !body?.mintRecipient) {
    setStatus(`${minted}, but the transfer amount couldn't be read, so no swap was made.`, 'err');
    return;
  }
  // Swap only what this transfer delivered, never other USDC in the wallet.
  const fee = BigInt(body.feeExecuted ?? body.maxFee ?? 0);
  pendingSwap = { burned: BigInt(body.amount), amountIn: BigInt(body.amount) - fee, recipient: getAddress(`0x${body.mintRecipient.slice(-40)}`) };
  setStatus(`${minted}. Now swapping to EURC…`);
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

// Swap the bridged USDC to EURC on Aerodrome Slipstream, signed by the recipient on Base.
async function swapToEurc() {
  if (!pendingSwap) return;
  const { recipient } = pendingSwap;
  $('retrySwap').hidden = true;
  setStep('swap', 'active');
  try {
    if (!wallet) await connect();
    if (!account) throw new Error('Connect your wallet to swap.');
    if (recipient !== account) throw new Error(`The USDC went to ${short(recipient)}. Connect that wallet to swap.`);

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
    }

    const { amountOut, tickSpacing } = await quoteEurc(amountIn);
    const amountOutMinimum = (amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    setStatus(`Confirm the swap of ${fmt(amountIn)} USDC for about ${fmt(amountOut)} EURC ${inWallet()}…`);
    const fromBlock = await baseClient.getBlockNumber();
    const r = await sendWatched({
      client: baseClient, label: 'Swap', link: baseTx,
      send: () => wallet.writeContract({
        account, chain: base, address: AERO_ROUTER, abi: routerAbi, functionName: 'exactInputSingle',
        args: [{
          tokenIn: USDC_BASE, tokenOut: EURC_BASE, tickSpacing, recipient: account,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
          amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n,
        }],
      }),
      check: async () => {
        const logs = await baseClient.getLogs({
          address: EURC_BASE, event: transferEvent, args: { to: account }, fromBlock,
        });
        return logs.at(-1)?.transactionHash;
      },
    });
    const hash = r.transactionHash;
    setStep('swap', 'done');
    const eurcOut = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs })
      .filter((l) => l.address.toLowerCase() === EURC_BASE.toLowerCase() && l.args.to === account)
      .reduce((sum, l) => sum + l.args.value, 0n);
    // The rate is only end-to-end if the whole delivered amount was swapped.
    const rate = amountIn === pendingSwap.amountIn ? ` Effective EUR/USD ${eurUsd(pendingSwap.burned, eurcOut)}, all fees included.` : '';
    pendingSwap = null;
    setStatus(`Done! Swapped ${fmt(amountIn)} USDC to ${fmt(eurcOut)} EURC on Aerodrome ${baseTx(hash)}.${rate}`, 'ok');
    refreshBalances();
  } catch (e) {
    console.error(e);
    setStatus(`Swap failed: ${errMsg(e)} Your USDC is safe on Base.`, 'err');
    $('retrySwap').hidden = false;
  }
}

// ---------- pending-burn persistence ----------

function savePending(hash, out) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ hash, out })); } catch {}
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
$('amount').oninput = refreshForm;
$('max').onclick = () => { $('amount').value = formatUnits(balanceEth, 6); refreshForm(); };
for (const r of document.querySelectorAll('input[name=mode], input[name=out]')) r.onchange = refreshForm;

// The deploy workflow stamps the commit into the footer; unstamped (local) copies link to the repo.
if ($('commit').textContent.startsWith('__')) {
  $('commit').textContent = 'dev';
  $('commit').href = 'https://github.com/SwapMarket/eth2base';
}

loadPending();
loadFees();
setInterval(loadFees, 30_000);
