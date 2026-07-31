import { createComplexMnaSystem, solveComplexMna, cStampConductance, cStampVoltageSource } from '../src/lib/circuit/complex-solver';
const sys = createComplexMnaSystem(2, 4);
cStampConductance(sys, 1, 2, { re: 1/1000, im: 0 });
cStampConductance(sys, 2, 0, { re: 1/1000, im: 0 });
cStampVoltageSource(sys, 1, 0, { re: 1, im: 0 });
const x = solveComplexMna(sys);
console.log('Solution:', x);
console.log('V1:', x && x[0]);
console.log('V2:', x && x[1]);
