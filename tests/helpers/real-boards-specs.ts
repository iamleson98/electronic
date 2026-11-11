// Per-deck acceptance metrics for the real-board suite. The SAME function turns
// ngspice data and app-engine data into numbers, so the comparison is about the
// simulator and never about two different measurement scripts.
import { amp, freq, maxIn, minIn, meanIn, interp, maxOf, minOf } from './real-boards';

export interface Series { x: number[]; v: Record<string, number[]>; vi?: Record<string, number[]> }
export type Metrics = Record<string, number>;
export interface Tol { rel?: number; abs?: number }

export interface DeckSpec {
  id: string;
  kind: 'op' | 'tran' | 'ac';
  probes: string[];
  /** analysis card used for BOTH ngspice and the app (window the metrics are defined on) */
  analysis?: string;
  /** app-engine timestep/method (transient) */
  ours?: { tstep: number; method?: 'euler' | 'trap' | 'gear'; every?: number };
  /** ngspice options for the reference run */
  ngOptions?: string;
  metrics: (d: Series) => Metrics;
  tol: Record<string, Tol>;
  /** > ~20 s on the app engine: only run with SLOW=1 */
  slow?: boolean;
  note?: string;
}

const dB = (re: number, im: number) => 20 * Math.log10(Math.hypot(re, im));
const at = (d: Series, net: string, f: number) => {
  const re = interp(d.x, d.v[net], f), im = interp(d.x, d.vi![net], f);
  return { re, im };
};
const dbRatio = (d: Series, num: string, den: string, f: number) => {
  const a = at(d, num, f), b = at(d, den, f);
  return dB(a.re, a.im) - dB(b.re, b.im);
};

export const SPECS: DeckSpec[] = [
  {
    id: 'unode-32u4.indicators', kind: 'op',
    probes: ['v5', 'd13', 'n_r7_pin2', 'ss', 'n_led1_pin2', 'n_led2_pin1', 'n_led3_pin2', 'n_led4_pin2'],
    metrics: ({ v: n }) => ({
      v5: n.v5[0],
      i_led_power_mA: (n.n_led1_pin2[0] / 1000) * 1e3,
      i_led_d13_mA: ((n.d13[0] - n.n_led2_pin1[0]) / 1000) * 1e3,
      i_led_tx_mA: ((n.n_led3_pin2[0] - n.n_r7_pin2[0]) / 1000) * 1e3,
      i_led_rx_mA: ((n.n_led4_pin2[0] - n.ss[0]) / 1000) * 1e3,
    }),
    tol: { v5: { rel: 0.003 }, i_led_power_mA: { rel: 0.01 }, i_led_d13_mA: { rel: 0.01 }, i_led_tx_mA: { rel: 0.01 }, i_led_rx_mA: { rel: 0.01 } },
  },
  {
    id: 'unode-32u4.usb-hotplug', kind: 'tran', probes: ['v5', 'vbus_src', 'n_f1_pin1', 'avcc1'],
    analysis: '.tran 10n 25u', ours: { tstep: 10e-9, method: 'gear' },
    metrics: ({ x, v }) => {
      const i = x.map((_, k) => (v.vbus_src[k] - v.n_f1_pin1[k]) / 0.5);
      let tau = NaN;
      for (let k = 0; k < x.length; k++) if (v.v5[k] >= 0.632 * 5) { tau = x[k] - 2e-6; break; }
      return {
        inrush_peak_A: maxIn(x, i, 1.9e-6, 25e-6),
        v5_final: v.v5[v.v5.length - 1],
        tau_us: tau * 1e6,
        v5_at_4us: interp(x, v.v5, 4e-6),
        avcc1_at_10us: interp(x, v.avcc1, 10e-6),
      };
    },
    tol: { inrush_peak_A: { rel: 0.02 }, v5_final: { rel: 0.003 }, tau_us: { rel: 0.03 }, v5_at_4us: { rel: 0.01, abs: 0.01 }, avcc1_at_10us: { rel: 0.01, abs: 0.01 } },
  },
  {
    id: 'unode-32u4.avcc-isolation', kind: 'ac', probes: ['v5', 'avcc1', 'avcc2'],
    analysis: '.ac dec 120 100k 1g',
    metrics: (d) => ({
      avcc1_dB_500k: dbRatio(d, 'avcc1', 'v5', 5e5),
      avcc1_dB_1M: dbRatio(d, 'avcc1', 'v5', 1e6),
      avcc1_dB_2M: dbRatio(d, 'avcc1', 'v5', 2e6),
      avcc1_dB_10M: dbRatio(d, 'avcc1', 'v5', 1e7),
      avcc1_dB_100M: dbRatio(d, 'avcc1', 'v5', 1e8),
      avcc2_dB_10M: dbRatio(d, 'avcc2', 'v5', 1e7),
    }),
    tol: Object.fromEntries(['avcc1_dB_500k', 'avcc1_dB_1M', 'avcc1_dB_2M', 'avcc1_dB_10M', 'avcc1_dB_100M', 'avcc2_dB_10M'].map((k) => [k, { abs: 0.3 }])),
  },
  {
    id: 'unode-32u4.crystal-resonance', kind: 'ac', probes: ['xtal1'],
    analysis: '.ac lin 400 15.97meg 16.025meg', ngOptions: 'reltol=1e-9 vntol=1e-9',
    metrics: (d) => {
      const z = d.x.map((_, k) => Math.hypot(d.v.xtal1[k], d.vi!.xtal1[k]));
      const iMin = z.indexOf(minOf(z));
      const z3 = Math.SQRT2 * z[iMin];
      let lo = iMin, hi = iMin;
      while (lo > 0 && z[lo] < z3) lo--;
      while (hi < z.length - 1 && z[hi] < z3) hi++;
      return { f_dip_MHz: d.x[iMin] / 1e6, contrast: maxOf(z) / z[iMin], Q: d.x[iMin] / (d.x[hi] - d.x[lo]), z_dip_mV: z[iMin] * 1e3 };
    },
    tol: { f_dip_MHz: { rel: 2e-5 }, contrast: { rel: 0.03 }, Q: { rel: 0.06 }, z_dip_mV: { rel: 0.03 } },
  },
];

const meanOf = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/** AM measurement used on both sides: carrier by mean crossings, depth from per-carrier-period peaks. */
export function amMetrics(x: number[], y: number[], t1: number, t2: number) {
  const fc = freq(x, y, t1, t2);
  const per = 1 / fc;
  const env: number[] = [];
  let k = 0;
  for (let t = t1 + per; t <= t2; t += per) {
    let mx = -Infinity;
    while (k < x.length && x[k] < t - per) k++;
    for (let j = k; j < x.length && x[j] <= t; j++) if (y[j] > mx) mx = y[j];
    env.push(mx);
  }
  const eMax = maxOf(env), eMin = minOf(env);
  return { fc, depth: (eMax - eMin) / (eMax + eMin) };
}

SPECS.push(
  {
    id: 'tricolor-lamp.pwm-channel', kind: 'tran', probes: ['gate3', 'v12', 'vcc', 'p_n_d3a_pin1'],
    analysis: '.tran 50n 2m', ours: { tstep: 100e-9, method: 'gear' },
    metrics: ({ x, v }) => {
      const i = x.map((_, k) => (v.v12[k] - v.p_n_d3a_pin1[k]) / 220);
      const sel = (f: (k: number) => boolean) => i.filter((_, k) => f(k));
      return {
        i_on_mean_mA: meanOf(sel((k) => x[k] > 1.05e-3 && x[k] < 1.33e-3 && v.gate3[k] > 2.5)) * 1e3,
        i_avg_mA: meanOf(sel((k) => x[k] > 1e-3)) * 1e3,
        i_off_max_uA: maxOf(sel((k) => x[k] > 1.4e-3 && v.gate3[k] < 0.5).map(Math.abs)) * 1e6,
        v12_min: minIn(x, v.v12, 1e-3, 2e-3),
        vcc_at_0: v.vcc[0],
        gate_high_V: maxIn(x, v.gate3, 1e-3, 2e-3),
      };
    },
    tol: { i_on_mean_mA: { rel: 0.02 }, i_avg_mA: { rel: 0.03 }, i_off_max_uA: { abs: 1 }, v12_min: { rel: 0.005 }, vcc_at_0: { rel: 0.005 }, gate_high_V: { rel: 0.01 } },
  },
  {
    id: 'radio-lab-tx.am-modulation', kind: 'tran', probes: ['rf_out'],
    analysis: '.tran 10n 2m', ours: { tstep: 25e-9, method: 'gear' }, slow: true,
    metrics: ({ x, v }) => {
      const m = amMetrics(x, v.rf_out, 0.8e-3, 2.0e-3);
      return { f_carrier_kHz: m.fc / 1e3, am_depth_pct: m.depth * 100, rf_amp_V: amp(x, v.rf_out, 0.8e-3, 2e-3) };
    },
    tol: { f_carrier_kHz: { rel: 0.01 }, am_depth_pct: { rel: 0.05 }, rf_amp_V: { rel: 0.03 } },
  },
  {
    id: 'radio-lab-rx.tank-alignment', kind: 'ac', probes: ['tank'], analysis: '.ac lin 80 500k 1.1meg',
    metrics: (d) => {
      const m = d.x.map((_, k) => Math.hypot(d.v.tank[k], d.vi!.tank[k]));
      const i = m.indexOf(maxOf(m));
      return { f_peak_kHz: d.x[i] / 1e3, tank_gain: m[i] };
    },
    tol: { f_peak_kHz: { rel: 0.003 }, tank_gain: { rel: 0.03 } },
  },
  {
    id: 'radio-lab-rx.receiving', kind: 'tran', probes: ['tank', 'det', 'n_c13_pin1'],
    analysis: '.tran 20n 2m', ours: { tstep: 25e-9, method: 'gear' }, slow: true,
    metrics: ({ x, v }) => ({
      tank_amp_mV: amp(x, v.tank, 1e-3, 2e-3) * 1e3,
      det_amp_mV: amp(x, v.det, 1e-3, 2e-3) * 1e3,
      out_amp_mV: amp(x, v.n_c13_pin1, 1e-3, 2e-3) * 1e3,
    }),
    // tank amplitude is resonance-sensitive: a 0.5 % numerical frequency error at 25 ns/step moves a Q = 40 tank by ~10 %
    tol: { tank_amp_mV: { rel: 0.18 }, det_amp_mV: { rel: 0.05 }, out_amp_mV: { rel: 0.05 } },
  },
  {
    id: 'fm-radio-lab-tx.fm-deviation', kind: 'tran', probes: ['tank'],
    analysis: '.tran 0.05n 4u', ours: { tstep: 0.1e-9, method: 'gear' },
    metrics: ({ x, v }) => ({ f_carrier_MHz: freq(x, v.tank, 2e-6, 4e-6) / 1e6, tank_amp_V: amp(x, v.tank, 2e-6, 4e-6) }),
    tol: { f_carrier_MHz: { rel: 0.01 }, tank_amp_V: { rel: 0.05 } },
  },
  {
    // The pluck amplitude is beat-sensitive (the drive sits at the unloaded series resonance, the ring at the
    // loaded one), so acceptance is on the FREE ring after the burst: its frequency and decay time constant.
    id: 'unode-32u4.crystal-ring', kind: 'tran', probes: ['xtal1'],
    analysis: '.tran 1n 80u', ours: { tstep: 1e-9, method: 'trap' }, ngOptions: 'reltol=1e-9 vntol=1e-9', slow: true,
    metrics: ({ x, v }) => {
      const a1 = amp(x, v.xtal1, 54e-6, 59e-6), a2 = amp(x, v.xtal1, 73e-6, 78e-6);
      return {
        f_ring_MHz: freq(x, v.xtal1, 60e-6, 80e-6) / 1e6,
        ring_tau_us: (73e-6 + 78e-6 - 54e-6 - 59e-6) / 2 / Math.log(a1 / a2) * 1e6,
      };
    },
    tol: { f_ring_MHz: { rel: 1.5e-3 }, ring_tau_us: { rel: 0.05 } },
  },
);

SPECS.push(
  {
    // The blocking oscillator is stiff and chaotic: its strike timing differs between ngspice
    // integrators (trap even rings numerically), so acceptance is on the physical limits the
    // harness checks - peak switch current, TVS clamp, battery draw, driver rail - not on edge times.
    id: 'arc-lighter.firing', kind: 'tran', probes: ['col', 'emit', 'vdrv', 'bat'],
    analysis: '.tran 20n 600u', ours: { tstep: 20e-9, method: 'gear' }, ngOptions: 'method=gear',
    metrics: ({ x, v }) => ({
      i_switch_peak_A: maxIn(x, v.emit, 300e-6, 600e-6) / 0.255,
      v_collector_max_V: maxIn(x, v.col, 300e-6, 600e-6),
      i_battery_avg_A: meanIn(x, v.bat.map((b) => (3.7 - b) / 0.15), 300e-6, 600e-6),
      v_drv_mean_V: meanIn(x, v.vdrv, 300e-6, 600e-6),
    }),
    tol: { i_switch_peak_A: { rel: 0.06 }, v_collector_max_V: { rel: 0.03 }, i_battery_avg_A: { rel: 0.1 }, v_drv_mean_V: { rel: 0.03 } },
  },
  {
    id: 'fm-radio-lab-rx.super-regen', kind: 'tran', probes: ['tank', 'q2c'],
    analysis: '.tran 0.05n 24u', ours: { tstep: 0.2e-9, method: 'gear' }, slow: true,
    metrics: ({ x, v }) => {
      const W = 0.1e-6;
      let pk = 0, tBest = 0;
      for (let t = 3e-6; t < 24e-6 - W; t += W) { const a = amp(x, v.tank, t, t + W); if (a > pk) { pk = a; tBest = t; } }
      const edges: number[] = [];
      for (let i = 1; i < x.length; i++) if (x[i] > 1e-6 && v.q2c[i - 1] < 2.5 && v.q2c[i] >= 2.5) edges.push(x[i]);
      return { rf_peak_V: pk, f_rf_MHz: freq(x, v.tank, tBest, tBest + 0.2e-6) / 1e6, quench_period_us: edges.length > 1 ? (edges[1] - edges[0]) * 1e6 : NaN };
    },
    tol: { rf_peak_V: { rel: 0.08 }, f_rf_MHz: { rel: 0.01 }, quench_period_us: { rel: 0.05 } },
  },
);

export const specById = (id: string) => SPECS.find((s) => s.id === id)!;
export { amp, freq, minIn, meanIn };
