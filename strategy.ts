// Second-Wind Dip-Recovery Bot v5-local (Wide Hunt).
// Idea: skip brand-new coins. Only buy a coin that already proved it can
// run (price once at least 4x its creation price) and is now dipping
// 12-30% off its peak while buyers are coming back. Creator selling
// 0.5 SOL or more in total vetoes the coin for good. v5 widens v4's
// funnel a little (4x run-up instead of 5x, first entry 50 slots
// earlier) and takes the first half-profit sooner (tp1 20%) with a
// tighter trail (12%).

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  minRunup: number;
  minAge: number;
  flowWindow: number;
  minFlowSol: number;
  minFlowBuyers: number;
  lastMustBeBuy: boolean;
  maxBuyerShare: number;
  dipMax: number;
  dipMin: number;
  minRealSol: number;
  minPeakRealSol: number;
  firstSol: number;
  addSol: number;
  maxPositionSol: number;
  addStep: number;
  minBuySol: number;
  buySlipBps: number;
  tp1: number;
  tp2: number;
  trail: number;
  stopLoss: number;
  fadeWindow: number;
  fadeNetSol: number;
  maxHold: number;
  holdIfUp: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  creatorSellVetoSol: number;
  maxExposureSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minRunup: 4.0,
  minAge: 150,
  flowWindow: 20,
  minFlowSol: 0.02,
  minFlowBuyers: 3,
  lastMustBeBuy: true,
  maxBuyerShare: 0.5,
  dipMax: 0.88,
  dipMin: 0.70,
  minRealSol: 3,
  minPeakRealSol: 8,
  firstSol: 0.1,
  addSol: 0.2,
  maxPositionSol: 0.6,
  addStep: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  tp1: 0.2,
  tp2: 1.0,
  trail: 0.12,
  stopLoss: 0.2,
  fadeWindow: 15,
  fadeNetSol: 0.05,
  maxHold: 1200,
  holdIfUp: 0.2,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  creatorSellVetoSol: 0.5,
  maxExposureSol: 5.0,
  targetCoins: 22,
  targetFills: 100,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1_000_000_000;
const TX_FEE_SOL = 0.000105;
const FEE_HAIRCUT = 0.0125;

interface TradeNote {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: string;
  px: number;
}

interface CoinBook {
  mint: string;
  born: number;
  creator: string;
  startPx: number;
  topPx: number;
  topRealSol: number;
  makerSold: number;
  trades: TradeNote[];
  lastTradeSlot: number;
  entriesLifetime: number;
  lastExitSlot: number;
}

interface HeldBook {
  mint: string;
  openedSlot: number;
  firstPx: number;
  added: boolean;
  tp1Done: boolean;
  bestNet: number;
  isProbe: boolean;
}

type PendingKind = 'main' | 'add' | 'probe' | 'tp1' | 'exit' | 'probeSell';

function pxOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function solLamports(lamports: bigint): number {
  return Number(lamports) / LAMPORTS;
}

// Net flow (buys minus sells, SOL) inside the last `window` slots, plus
// buy-side stats. Returns null when the window holds no trade at all.
function flowStats(book: CoinBook, slot: number, window: number) {
  let buys = 0;
  let distinct = new Set<string>();
  let buySol = 0;
  let net = 0;
  let lastBuy = false;
  let lastSeen = false;
  let biggest = 0;
  const perBuyer = new Map<string, number>();
  for (const t of book.trades) {
    if (t.slot < slot - window) continue;
    lastSeen = true;
    lastBuy = t.isBuy;
    if (t.isBuy) {
      buys++;
      distinct.add(t.user);
      buySol += t.sol;
      net += t.sol;
      const running = (perBuyer.get(t.user) ?? 0) + t.sol;
      perBuyer.set(t.user, running);
      if (running > biggest) biggest = running;
    } else {
      net -= t.sol;
    }
  }
  if (!lastSeen) return null;
  return { buys, buyers: distinct.size, buySol, net, lastBuy, biggest };
}

// Gross value of `tokens` at the curve's current reserves, in SOL.
function grossValueSol(tokens: bigint, vq: bigint, vt: bigint): number {
  if (vt === 0n || tokens === 0n) return 0;
  return solLamports((tokens * vq) / vt);
}

// Value after the 1.25% curve fee and one tx fee, as the harness charges.
function netValueSol(tokens: bigint, vq: bigint, vt: bigint): number {
  const gross = grossValueSol(tokens, vq, vt);
  if (gross <= 0) return 0;
  return gross * (1 - FEE_HAIRCUT) - TX_FEE_SOL;
}

export function createStrategy(p: Params): Bot {
  const coins = new Map<string, CoinBook>();
  const held = new Map<string, HeldBook>();
  const pendingKind = new Map<string, PendingKind>();
  const everFilledBuy = new Set<string>();
  const probeFlying = new Set<string>();
  let totalFills = 0;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let probesFlying = 0;

  function bookFor(mint: string, slot: number): CoinBook {
    let b = coins.get(mint);
    if (b === undefined) {
      b = {
        mint,
        born: slot,
        creator: '',
        startPx: 0,
        topPx: 0,
        topRealSol: 0,
        makerSold: 0,
        trades: [],
        lastTradeSlot: slot,
        entriesLifetime: 0,
        lastExitSlot: -1_000_000,
      };
      coins.set(mint, b);
    }
    return b;
  }

  function prune(book: CoinBook, slot: number, horizon: number) {
    const cut = slot - horizon;
    while (book.trades.length > 0 && book.trades[0]!.slot < cut) book.trades.shift();
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const soldThisBatch = new Set<string>();
    const horizon = Math.max(p.flowWindow, p.fadeWindow) + 40;

    // ---- ingest this batch's events into the per-coin books ----
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const b = bookFor(e.mint, e.slot);
        b.born = e.slot;
        b.creator = e.creator;
        b.startPx = pxOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (b.topPx < b.startPx) b.topPx = b.startPx;
      } else if (e.event === 'TradeEvent') {
        const b = bookFor(e.mint, e.slot);
        const px = pxOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (px > b.topPx) b.topPx = px;
        const realSol = solLamports(BigInt(e.real_quote_reserves));
        if (realSol > b.topRealSol) b.topRealSol = realSol;
        if (b.creator !== '' && e.user === b.creator && !e.is_buy) {
          b.makerSold += solLamports(BigInt(e.sol_amount));
        }
        b.trades.push({ slot: e.slot, isBuy: e.is_buy, sol: solLamports(BigInt(e.sol_amount)), user: e.user, px });
        b.lastTradeSlot = e.slot;
        prune(b, e.slot, horizon);
      }
    }

    // ---- fold fills in: counts, probe state, TP1 best reset ----
    // A fill only counts once it lands. The TP1 trailing peak is reset
    // here, on the fill, never when the sell order is sent, so a
    // rejected TP1 sell cannot corrupt the trail.
    for (const f of batch.fills) {
      const kind = pendingKind.get(f.client_id);
      if (kind !== undefined) pendingKind.delete(f.client_id);
      if (kind === 'probe' || kind === 'probeSell') {
        if (kind === 'probe') {
          probesFlying = Math.max(0, probesFlying - 1);
          probeFlying.delete(f.mint);
        }
      }
      if (f.status !== 'filled') continue;
      totalFills++;
      if (f.side === 'buy') {
        everFilledBuy.add(f.mint);
        const book = coins.get(f.mint);
        if (kind === 'main' && book !== undefined && !held.has(f.mint)) {
          const curve = state.curves.get(f.mint);
          const px = curve === undefined ? 0 : pxOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          held.set(f.mint, { mint: f.mint, openedSlot: batch.slot, firstPx: px, added: false, tp1Done: false, bestNet: 0, isProbe: false });
          book.entriesLifetime++;
        } else if (kind === 'add') {
          const h = held.get(f.mint);
          if (h !== undefined) h.added = true;
        } else if (kind === 'probe' && !held.has(f.mint)) {
          held.set(f.mint, { mint: f.mint, openedSlot: batch.slot, firstPx: 0, added: true, tp1Done: true, bestNet: 0, isProbe: true });
        }
      } else {
        const h = held.get(f.mint);
        if (h === undefined) continue;
        const pos = state.positions.get(f.mint);
        const remaining = pos === undefined ? 0n : pos.token_amount;
        if (kind === 'tp1') {
          h.tp1Done = true;
          const curve = state.curves.get(f.mint);
          h.bestNet = curve === undefined ? 0 : netValueSol(remaining, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        }
        if (remaining === 0n) {
          if (!h.isProbe) {
            const book = coins.get(f.mint);
            if (book !== undefined) book.lastExitSlot = batch.slot;
          }
          held.delete(f.mint);
        }
      }
    }

    // ---- close books whose position vanished with no order in flight ----
    const pendingMints = new Set<string>();
    const pendingSellMints = new Set<string>();
    for (const po of state.pending.values()) {
      pendingMints.add(po.order.mint);
      if (po.order.side === 'sell') pendingSellMints.add(po.order.mint);
    }
    for (const mint of [...held.keys()]) {
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      const h = held.get(mint)!;
      if (!h.isProbe) {
        const book = coins.get(mint);
        if (book !== undefined) book.lastExitSlot = batch.slot;
      }
      held.delete(mint);
    }

    function pushSell(mint: string, tokens: bigint, kind: PendingKind): boolean {
      if (tokens <= 0n || soldThisBatch.has(mint)) return false;
      soldThisBatch.add(mint);
      const id = state.clientId();
      pendingKind.set(id, kind);
      orders.push({ side: 'sell', client_id: id, mint, token_amount: tokens, max_slippage_bps: 10000 });
      return true;
    }

    function pushBuy(mint: string, sol: number, kind: PendingKind): boolean {
      if (sol < p.minBuySol) return false;
      const lamports = BigInt(Math.floor(sol * LAMPORTS));
      if (lamports <= 0n) return false;
      const id = state.clientId();
      pendingKind.set(id, kind);
      orders.push({ side: 'buy', client_id: id, mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
      return true;
    }

    // ---- exits first, before any new entry in this batch ----
    let spentCashSol = 0;
    const spentPerMint = new Map<string, number>();
    let newMainBuys = 0;

    function mainCostSum(): number {
      let sum = 0;
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (h !== undefined && h.isProbe) continue;
        sum += solLamports(pos.cost_lamports);
      }
      return sum;
    }

    function sizeBuy(mint: string, wantSol: number): number {
      let s = wantSol;
      const capMint = solLamports(state.maxBuyLamports(mint)) - (spentPerMint.get(mint) ?? 0);
      if (s > capMint) s = capMint;
      const freeCash = solLamports(state.freeCashLamports()) - TX_FEE_SOL - spentCashSol;
      if (s > freeCash) s = freeCash;
      const room = p.maxExposureSol - mainCostSum() - spentCashSol;
      if (s > room) s = room;
      if (s < p.minBuySol) return 0;
      spentCashSol += s;
      spentPerMint.set(mint, (spentPerMint.get(mint) ?? 0) + s);
      return s;
    }

    const heldMints = [...held.keys()].sort();
    for (const mint of heldMints) {
      const h = held.get(mint);
      const pos = state.positions.get(mint);
      if (h === undefined || pos === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      // A sell already in flight covers this mint: sending another sell
      // for the same tokens only earns an insufficient_tokens reject.
      if (pendingSellMints.has(mint)) continue;
      if (h.isProbe) {
        pushSell(mint, pos.token_amount, 'probeSell');
        continue;
      }
      const costSol = solLamports(pos.cost_lamports);
      const net = netValueSol(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (net > h.bestNet) h.bestNet = net;
      const book = coins.get(mint);
      const fade = book === undefined ? null : flowStats(book, batch.slot, p.fadeWindow);
      const holdLimit = p.maxHold * (net >= costSol * (1 + p.holdIfUp) ? 2 : 1);
      const mustExit =
        (book !== undefined && book.makerSold >= p.creatorSellVetoSol) ||
        net < costSol * (1 - p.stopLoss) ||
        (h.tp1Done && net < h.bestNet * (1 - p.trail)) ||
        (h.tp1Done && net >= costSol * (1 + p.tp2)) ||
        (fade !== null && fade.net < -p.fadeNetSol) ||
        batch.slot - h.openedSlot > holdLimit;
      if (mustExit) {
        pushSell(mint, pos.token_amount, 'exit');
        continue;
      }
      if (!h.tp1Done && net >= costSol * (1 + p.tp1)) {
        pushSell(mint, pos.token_amount / 2n, 'tp1');
      }
    }

    // ---- one add per position, on a 5% push with fresh flow ----
    for (const mint of heldMints) {
      const h = held.get(mint);
      const pos = state.positions.get(mint);
      if (h === undefined || pos === undefined || h.isProbe || h.added) continue;
      if (pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const px = pxOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (px < h.firstPx * (1 + p.addStep)) continue;
      const book = coins.get(mint);
      if (book === undefined) continue;
      const flow = flowStats(book, batch.slot, p.flowWindow);
      if (flow === null || flow.net < p.minFlowSol) continue;
      if (solLamports(curve.real_quote_reserves) < p.minRealSol) continue;
      const costSol = solLamports(pos.cost_lamports);
      if (costSol >= p.maxPositionSol - p.minBuySol) continue;
      const sized = sizeBuy(mint, Math.min(p.addSol, p.maxPositionSol - costSol));
      if (sized > 0) pushBuy(mint, sized, 'add');
    }

    // ---- first entries: proven runner, dipping, buyers returning ----
    const candidates = [...coins.values()].sort((a, b) => b.lastTradeSlot - a.lastTradeSlot || (a.mint < b.mint ? -1 : 1));
    for (const book of candidates) {
      if (state.committedPositionCount() + newMainBuys >= p.maxMain) break;
      if (held.has(book.mint) || pendingMints.has(book.mint)) continue;
      if (book.entriesLifetime >= p.maxEntries) continue;
      if (batch.slot - book.lastExitSlot < p.cooldown) continue;
      if (book.makerSold >= p.creatorSellVetoSol) continue;
      if (batch.slot - book.born < p.minAge) continue;
      if (book.startPx <= 0 || book.topPx < p.minRunup * book.startPx) continue;
      if (book.topRealSol < p.minPeakRealSol) continue;
      const curve = state.curves.get(book.mint);
      if (curve === undefined || curve.complete) continue;
      if (solLamports(curve.real_quote_reserves) < p.minRealSol) continue;
      const px = pxOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const dip = px / book.topPx;
      if (dip < p.dipMin || dip > p.dipMax) continue;
      prune(book, batch.slot, horizon);
      const flow = flowStats(book, batch.slot, p.flowWindow);
      if (flow === null) continue;
      if (flow.buys < p.minFlowBuyers || flow.buyers < p.minFlowBuyers) continue;
      if (flow.net < p.minFlowSol) continue;
      if (p.lastMustBeBuy && !flow.lastBuy) continue;
      if (flow.buySol > 0 && flow.biggest > p.maxBuyerShare * flow.buySol) continue;
      const sized = sizeBuy(book.mint, p.firstSol);
      if (sized > 0 && pushBuy(book.mint, sized, 'main')) newMainBuys++;
    }

    // ---- probe to keep pace with the guardrails ----
    // totalFills counts every fill, sells included. A probe may revisit a
    // coin it already probed; only a coin with a probe still flying is
    // off limits, and only when coins are short must the coin be fresh.
    if (probesFlying < p.maxProbes && firstBlockTime !== null && lastBlockTime !== null) {
      const elapsed = lastBlockTime - firstBlockTime;
      const progress = Math.min(1, elapsed / p.paceSecs);
      const needCoins = everFilledBuy.size < Math.ceil(p.targetCoins * progress);
      const needFills = totalFills < Math.ceil(p.targetFills * progress);
      if ((needCoins || needFills) && state.committedPositionCount() + newMainBuys < p.maxMain) {
        const liquidBar = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve * 1.5;
        for (const book of candidates) {
          if (held.has(book.mint) || pendingMints.has(book.mint) || probeFlying.has(book.mint)) continue;
          if (book.trades.length === 0) continue;
          if (needCoins && everFilledBuy.has(book.mint)) continue;
          const curve = state.curves.get(book.mint);
          if (curve === undefined || curve.complete) continue;
          if (solLamports(curve.real_quote_reserves) < liquidBar) continue;
          const sized = sizeBuy(book.mint, p.probeSol);
          if (sized > 0 && pushBuy(book.mint, sized, 'probe')) {
            probesFlying++;
            probeFlying.add(book.mint);
          }
          break;
        }
      }
    }

    return orders;
  }

  return { onBatch };
}
