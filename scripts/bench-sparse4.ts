import { createSparseMnaSystem, solveSparse, solveFromTriplets, resetSparseFactorizationCache, sparseFactorizationStats } from '../src/lib/circuit/sparse-klu';

const N = 1500;
const big = createSparseMnaSystem(2 * N + 1, 1);
for (let i = 0; i < N; i++) {
  big.stampConductance(1 + 2 * i, 2 + 2 * i, 1 / 1000);
  big.stampConductance(2 + 2 * i, 2 + 2 * i + 1, 1 / 1000);
  big.stampConductance(2 + 2 * i + 1, 0, 1 / 1000);
}
big.stampVoltageSource(1, 0, 5);

// FULL path only (solveFromTriplets never uses the cache)
solveFromTriplets(big.size, big.triplets.row, big.triplets.col, big.triplets.val, big.triplets.count, big.z); // warmup
let t0 = performance.now();
for (let s = 0; s < 20; s++) {
  solveFromTriplets(big.size, big.triplets.row, big.triplets.col, big.triplets.val, big.triplets.count, big.z);
}
let t1 = performance.now();
console.log(`FULL path (Markowitz every solve):  ${((t1 - t0) / 20).toFixed(2)} ms/solve`);

// REUSE path
resetSparseFactorizationCache();
solveSparse(big); // warmup full
t0 = performance.now();
for (let s = 0; s < 20; s++) solveSparse(big);
t1 = performance.now();
console.log(`REUSE path (fixed pivots):           ${((t1 - t0) / 20).toFixed(2)} ms/solve  ${JSON.stringify(sparseFactorizationStats())}`);

// Changing values (realistic transient: values drift)
resetSparseFactorizationCache();
solveSparse(big);
t0 = performance.now();
for (let s = 0; s < 20; s++) {
  // simulate value drift like a companion model: re-stamp with different conductances
  big.clearStamps();
  big.nextExtra = big.numNodes;
  for (let i = 0; i < N; i++) {
    const g = 1 / (1000 + Math.sin(s + i) * 10);
    big.stampConductance(1 + 2 * i, 2 * i + 2, g);
    big.stampConductance(2 + 2 * i, 2 * i + 3, g);
    big.stampConductance(2 * i + 3, 0, g);
  }
  big.stampVoltageSource(1, 0, 5);
  solveSparse(big);
}
t1 = performance.now();
console.log(`REUSE with value drift:              ${((t1 - t0) / 20).toFixed(2)} ms/solve  ${JSON.stringify(sparseFactorizationStats())}`);
