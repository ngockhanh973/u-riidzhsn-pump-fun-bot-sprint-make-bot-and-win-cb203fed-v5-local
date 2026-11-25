// Entry point for the Second-Wind Dip-Recovery Bot v5-local (Wide Hunt).
// Wires the strategy into the make.fun replay shim and runs it on the
// harness batches. Diagnostics go to stderr only; stdout is the wire.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

// The bot answers one reply per harness batch; the shim owns the wire,
// the strategy owns every trading decision, and nothing here reads the
// clock, the environment, or any randomness source.
await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
  onDone: (state, done) => {
    console.error(`done ${done.reason} cash=${state.cash} positions=${state.positions.size} curves=${state.curves.size}`);
  },
});
