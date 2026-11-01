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
  zeroHash,
} from 'https://esm.sh/viem@2.21.55';
import { mainnet, base } from 'https://esm.sh/viem@2.21.55/chains';

// CCTP V2 (same addresses on every supported chain).
const TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const MESSAGE_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
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

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const tokenMessengerAbi = parseAbi([
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
]);
const transmitterAbi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
  'function usedNonces(bytes32) view returns (uint256)',
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
  $('manualMint').hidden = true;
  $('progress').hidden = false;
}

const fmt = (v) => Number(formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 6 });
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

// Max total fee (CCTP protocol fee + Circle forwarding fee) in USDC base units, with a 10% buffer.
// It is deducted from the burned amount on Base, never charged on top.
function maxFeeFor(amount, mode) {
  const { bps, forward } = fees[mode];
  const ppm = BigInt(Math.ceil(bps * 100));
  const protocol = (amount * ppm + 999_999n) / 1_000_000n;
  const fee = protocol + forward;
  return fee + fee / 10n + 1n;
}

function refreshForm() {
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
    return window.ethereum;
  }
  const { EthereumProvider } = await import('https://esm.sh/@walletconnect/ethereum-provider@2.17.2');
  const provider = await EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: [mainnet.id],
    optionalChains: [base.id],
    rpcMap: { [mainnet.id]: 'https://ethereum-rpc.publicnode.com', [base.id]: 'https://mainnet.base.org' },
    showQrModal: true,
    metadata: {
      name: 'eth2base',
      description: 'Bridge USDC from Ethereum to Base with CCTP',
      url: location.origin,
      icons: [],
    },
  });
  await provider.enable();
  provider.on('disconnect', () => setAccount(null));
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
  $('account').textContent = account ? `Connected: ${short(account)}` : 'Not connected';
  $('connect').textContent = account ? 'Connected' : 'Connect wallet';
  $('connect').disabled = !!account;
  $('balances').hidden = !account;
  refreshBalances();
}

async function refreshBalances() {
  if (!account) { balanceEth = 0n; refreshForm(); return; }
  const [e, b] = await Promise.allSettled([
    ethClient.readContract({ address: USDC_ETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    baseClient.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
  ]);
  balanceEth = e.status === 'fulfilled' ? e.value : 0n;
  $('balEth').textContent = e.status === 'fulfilled' ? fmt(e.value) : 'error';
  $('balBase').textContent = b.status === 'fulfilled' ? fmt(b.value) : 'error';
  refreshForm();
}

async function ensureChain(chain) {
  const current = await wallet.getChainId();
  if (current === chain.id) return;
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
      setStatus('Confirm the USDC approval in your wallet…');
      const hash = await wallet.writeContract({
        account, chain: mainnet, address: USDC_ETH, abi: erc20Abi,
        functionName: 'approve', args: [TOKEN_MESSENGER, amount],
      });
      setStatus(`Approval sent ${ethTx(hash)}, waiting for confirmation…`);
      const r = await ethClient.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('Approval transaction reverted');
      setStep('approve', 'done');
    } else {
      setStep('approve', 'skipped');
    }

    // 2. Burn, with the forwarding hook so Circle mints on Base
    setStep('burn', 'active');
    setStatus('Confirm the burn in your wallet…');
    const burnHash = await wallet.writeContract({
      account, chain: mainnet, address: TOKEN_MESSENGER, abi: tokenMessengerAbi,
      functionName: 'depositForBurnWithHook',
      args: [amount, DOMAIN_BASE, pad(recipient, { size: 32 }), USDC_ETH, zeroHash, maxFee, FINALITY[mode], FORWARD_HOOK],
    });
    savePending(burnHash);
    setStatus(`Burn sent ${ethTx(burnHash)}, waiting for confirmation…`);
    const r = await ethClient.waitForTransactionReceipt({ hash: burnHash });
    if (r.status !== 'success') { clearPending(); throw new Error('Burn transaction reverted'); }
    setStep('burn', 'done');
    refreshBalances();

    await track(burnHash, mode);
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
    await track(hash);
  } catch (e) {
    console.error(e);
    setStatus(errMsg(e), 'err');
  }
}

// Poll Circle until the forwarder has minted on Base. If the attestation is complete
// but nothing has been forwarded for a while, offer a manual mint as a fallback.
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
      clearPending();
      setStatus(`Done! Circle minted the USDC on Base ${baseTx(m.forwardTxHash)}.`, 'ok');
      refreshBalances();
      return;
    }

    if (m?.status === 'complete' && m.attestation && m.attestation !== 'PENDING') {
      if (!attestedAt) {
        attestedAt = Date.now();
        setStep('attest', 'done');
        setStep('mint', 'active');
        setStatus('Attested. Waiting for Circle to mint on Base…');
      }
      pendingMint = { message: m.message, attestation: m.attestation, nonce: m.eventNonce };
      if (Date.now() - attestedAt > FORWARD_GRACE_MS && $('manualMint').hidden) {
        if (await alreadyMinted(m.eventNonce)) {
          setStep('mint', 'done');
          clearPending();
          setStatus('This transfer was already minted on Base.', 'ok');
          refreshBalances();
          return;
        }
        setStatus('Circle hasn\'t forwarded this transfer yet. You can keep waiting, or mint it yourself on Base (needs a little ETH on Base for gas).');
        $('manualMint').hidden = false;
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
    if (await alreadyMinted(nonce)) {
      setStep('mint', 'done');
      clearPending();
      $('manualMint').hidden = true;
      setStatus('This transfer was already minted on Base.', 'ok');
      return;
    }
    await ensureChain(base);
    setStatus('Confirm the mint on Base in your wallet…');
    const hash = await wallet.writeContract({
      account, chain: base, address: MESSAGE_TRANSMITTER, abi: transmitterAbi,
      functionName: 'receiveMessage', args: [message, attestation],
    });
    setStatus(`Mint sent ${baseTx(hash)}, waiting for confirmation…`);
    const r = await baseClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('Mint transaction reverted');
    setStep('mint', 'done');
    clearPending();
    $('manualMint').hidden = true;
    setStatus(`Done! USDC minted on Base ${baseTx(hash)}.`, 'ok');
    refreshBalances();
  } catch (e) {
    console.error(e);
    setStatus(`Mint failed: ${errMsg(e)}. Your funds are safe; the attested message can be minted any time.`, 'err');
  }
}

// ---------- pending-burn persistence ----------

function savePending(hash) {
  try { localStorage.setItem(PENDING_KEY, hash); } catch {}
}
function clearPending() {
  try { localStorage.removeItem(PENDING_KEY); } catch {}
}
function loadPending() {
  try {
    const h = localStorage.getItem(PENDING_KEY);
    if (h) {
      $('resumeHash').value = h;
      $('resumeHash').closest('details').open = true;
    }
  } catch {}
}

// ---------- wire up ----------

$('connect').onclick = () => connect().catch((e) => alert(errMsg(e)));
$('bridge').onclick = bridge;
$('resume').onclick = resume;
$('manualMint').onclick = manualMint;
$('amount').oninput = refreshForm;
$('max').onclick = () => { $('amount').value = formatUnits(balanceEth, 6); refreshForm(); };
for (const r of document.querySelectorAll('input[name=mode]')) r.onchange = refreshForm;

loadPending();
loadFees();
setInterval(loadFees, 30_000);
