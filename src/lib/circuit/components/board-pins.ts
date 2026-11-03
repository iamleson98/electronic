// Pin drivers for development boards (Arduino, Raspberry Pi).
//
// Real boards never present IDEAL sources on their pins: a GPIO has tens of
// ohms of output resistance, and the 5V / 3V3 header pins are regulator
// outputs that source current but cannot sink it. Ideal sources made common
// wiring unsimulatable — an external supply on the 5V pin (how many Unos are
// powered) or two outputs tied together put two ideal sources in parallel:
// a singular matrix, and the whole simulation stopped.

import type { MnaSystem, SimContext } from '../types';

/** ATmega328P push-pull output ≈ 25 Ω at 5 V (VOH ≈ 4.5 V @ 20 mA). */
export const AVR_GPIO_ROUT = 25;
/** Raspberry Pi GPIO (8 mA drive strength) ≈ 40 Ω. */
export const RPI_GPIO_ROUT = 40;
/** Board regulator output resistance. */
export const REG_ROUT = 0.05;

/** Push-pull GPIO: Thevenin `volts` above `gnd` through `rOut`. */
export function stampGpio(sys: MnaSystem, pin: number, gnd: number, volts: number, rOut: number): void {
  if (pin === gnd) return;
  sys.stampConductance(pin, gnd, 1 / rOut);
  sys.stampCurrentSource(gnd, pin, volts / rOut);
}

/**
 * Regulator output pin (5V / 3V3 header): sources through `rOut` while the
 * pin sits below the regulation voltage; when something else holds the rail
 * at or above it (external supply back-feeding the pin) the regulator stops
 * conducting instead of fighting it. Decided from the Newton iterate.
 */
export function stampRegulatorPin(sys: MnaSystem, sim: SimContext, pin: number, gnd: number, vReg: number, rOut = REG_ROUT): void {
  if (pin === gnd) return;
  const vPin = (sim.nodeVoltage[pin] ?? 0) - (sim.nodeVoltage[gnd] ?? 0);
  if (vPin <= vReg + 1e-6) {
    sys.stampConductance(pin, gnd, 1 / rOut);
    sys.stampCurrentSource(gnd, pin, vReg / rOut);
  } else {
    sys.stampConductance(pin, gnd, 1e-9);
  }
}
