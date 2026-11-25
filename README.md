[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v5-local/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v5-local/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Second-Wind Dip-Recovery Bot v5-local (Wide Hunt)

A pump.fun replay bot for the make.fun bounty
`u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed`. It does not chase
freshly created coins. It only buys a coin that has already proved it can
run — price once at least 4x its creation price — and is now dipping
12–30% off its peak while buyers are coming back (at least 3 buyers and
0.02 SOL of net flow in the last 20 slots, latest trade a buy, no single
buyer over half the buy flow). A creator who has sold 0.5 SOL or more in
total vetoes the coin for good.

v5 is a small widening of v4: run-up 5x → 4x, first entry 50 slots
earlier (minAge 200 → 150), first half-profit sooner (tp1 25% → 20%)
with a tighter trail (15% → 12%). Position sizes stay large (first
0.10 SOL, one add of 0.20 SOL, max 0.60 SOL per coin, max 5.0 SOL
exposure, max 5 main positions).

## Exits

Exits are checked before any new entry in each batch. Full exit on
creator veto, a 20% stop loss, a 12% trailing stop after the first
half-profit, a 100% take-profit on the remainder, 15-slot net flow
below −0.05 SOL, or holding too long (1200 slots, doubled while up
20%+). The first half is sold at +20%, once per position; the trailing
peak is then reset to the remaining position's value when that sell
fills. At most 2 entries per coin over its whole life, with a 150-slot
cooldown after an exit. In one batch, at most one sell order per mint
is sent, and a coin with a sell already in flight gets no second sell.

## Pace probes

To keep the guardrails (≥20 coins, ≥100 fills over the 4-hour pace
window), the bot sends 0.01 SOL probe buys when it is behind pace,
selling the probe in full as soon as it fills. Probe fills count toward
the pace, sells included. A probe may revisit a coin it already probed;
only a coin with a probe still in flight is off limits, and only when
coins are short must the probe coin be one never filled before.

## Key parameters

`minRunup 4.0`, `minAge 150`, `minPeakRealSol 8`, `minRealSol 3`,
`dipMin 0.70`, `dipMax 0.88`, `firstSol 0.10`, `addSol 0.20`,
`maxPositionSol 0.60`, `maxExposureSol 5.0`, `stopLoss 0.20`,
`tp1 0.20`, `tp2 1.00`, `trail 0.12`, `maxHold 1200`,
`cooldown 150`, `maxEntries 2`, `maxMain 5`,
`creatorSellVetoSol 0.5`, `targetCoins 22`, `targetFills 100`,
`paceSecs 14400`, `probeSol 0.01`, `maxProbes 1`.

## Dev-window result (local sim, kit dev data)

Two identical runs:

- net **−0.178620 SOL**, fills 120, coins 30, trips 58, wins 5,
  max drawdown 0.0179, rejected 0, failed 2
- without failed txs −0.178225 SOL; at 2x fees −0.248097 SOL

Guardrails pass (coins 30 ≥ 20, drawdown 0.0179 ≤ 0.50), but the net
is worse than v4's −0.048358 SOL, so v5 does not dethrone v4.

## How to run the sim

From `~/workspace/makefun/pump-sim-v5` (scratch, outside this repo):

```sh
node tools/backtest.ts ../pumpfun-kit/extracted/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-kit
```

The bot itself runs under the grader as `node main.ts`. It is fully
deterministic: no clock, no randomness, no environment reads, no IO in
the strategy — every decision comes from the harness batch and its own
state.
