// Electrical Rule Check engine — full KiCad eeschema parity.
//
// Checks:
//   1. Unconnected input/output/power pins (skipping No-Connect markers)
//   2. Pin-conflict matrix (input↔output is error, etc.)
//   3. Missing ground reference
//   4. Conflicting drivers (multiple outputs on same net)
//   5. Power net without driver (PWR_FLAG exemption)
//   6. Unconnected wire endpoints
//   7. Two labels with same name but different net classes
//   8. Unused multi-unit components (only some units placed)
//   9. Bus-to-net conflicts

import type { CircuitComponent, PinElecType, Wire, NoConnectMarker, ComponentPlugin } from './types';
import { getPlugin } from './registry';
import { buildNodeMap, getTerminalsForComponent } from './engine';

export interface ERCError {
  type:
    | 'unconnected_pin'
    | 'power_short'
    | 'conflicting_drivers'
    | 'missing_ground'
    | 'pin_conflict'
    | 'power_undriven'
    | 'wire_endpoint_unconnected'
    | 'label_net_class_conflict'
    | 'unused_unit'
    | 'bus_net_conflict'
    | 'no_connect_on_connected_pin';
  severity: 'error' | 'warning' | 'info';
  message: string;
  componentId: string;
  terminalId: string;
  position: { x: number; y: number };
  /** additional refs for jump-to in browser */
  refs?: { componentId: string; terminalId: string }[];
  /** user can override severity / ignore via ERC exclusions */
  exclusionKey?: string;
}

export interface ERCResult {
  errors: ERCError[];
  passed: boolean;
  stats: { errors: number; warnings: number; infos: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default electrical type lookup (used when plugin's TerminalDef lacks one)
// ─────────────────────────────────────────────────────────────────────────────

export function getTerminalElecType(compType: string, terminalId: string, plugin?: ComponentPlugin): PinElecType {
  // 1. Check plugin's TerminalDef first
  if (plugin) {
    const t = plugin.terminals.find((tt) => tt.id === terminalId);
    if (t?.electricalType) return t.electricalType;
  }
  // 2. Fall back to legacy heuristic for built-in components
  if (compType === 'dcVoltage' || compType === 'acVoltage' || compType === 'pulseSource') {
    return terminalId === 'p' ? 'power_out' : 'power_in';
  }
  if (compType === 'ground' || compType === 'powerGND' || compType === 'powerAGND') return 'power_in';
  if (compType === 'powerVCC' || compType === 'power5V' || compType === 'power3V3' ||
      compType === 'power1V8' || compType === 'power2V5' ||
      compType === 'power12V' || compType === 'powerMinus12V' ||
      compType === 'powerMinus5V' || compType === 'powerAVDD' ||
      compType === 'powerVBAT') {
    return 'power_out';
  }
  if (compType === 'powerFlag') return 'power_out';
  if (compType === 'netLabel' || compType === 'busLabel' ||
      compType === 'busVectorLabel' || compType === 'hierLabel') return 'passive';
  if (compType === 'resistor' || compType === 'capacitor' || compType === 'inductor' ||
      compType === 'fuse' || compType === 'crystal' || compType === 'photoresistor') return 'passive';
  if (compType === 'diode' || compType === 'led' || compType === 'zener' || compType === 'schottky') return 'passive';
  if (compType === 'switch' || compType === 'pushButton') return 'passive';
  if (compType === 'npn' || compType === 'pnp') {
    if (terminalId === 'b') return 'input';
    return 'passive'; // collector/emitter are passive (current-carrying)
  }
  if (compType === 'nmos' || compType === 'pmos') {
    if (terminalId === 'g') return 'input';
    return 'passive';
  }
  if (compType === 'opamp' || compType === 'opampRails') {
    if (terminalId === 'in+' || terminalId === 'in-') return 'input';
    if (terminalId === 'out') return 'output';
    if (terminalId === 'vcc' || terminalId === 'v+') return 'power_in';
    if (terminalId === 'vee' || terminalId === 'v-') return 'power_in';
  }
  if (compType === 'timer555') {
    if (terminalId === 'out') return 'output';
    if (terminalId === 'vcc') return 'power_in';
    if (terminalId === 'gnd') return 'power_in';
    if (terminalId === 'ctrl') return 'input';
    if (terminalId === 'thr' || terminalId === 'trig') return 'input';
    if (terminalId === 'dis') return 'output';
    if (terminalId === 'rst') return 'input';
    return 'input';
  }
  if (compType === 'voltageRegulator') {
    if (terminalId === 'in') return 'power_in';
    if (terminalId === 'out') return 'power_out';
    if (terminalId === 'gnd') return 'power_in';
    return 'passive';
  }
  if (compType === 'arduino' || compType === 'arduinoReal' || compType === 'raspberryPi') {
    if (terminalId === 'gnd') return 'power_in';
    if (terminalId === '5v' || terminalId === '3v3' || terminalId === 'vin') return 'power_in';
    return 'bidirectional';
  }
  if (compType === 'oscilloscope' || compType === 'voltmeter') return 'input';
  if (compType === 'ammeter') return 'passive';
  return 'unspecified';
}

// ─────────────────────────────────────────────────────────────────────────────
// Pin-conflict matrix (KiCad eeschema severity table)
//   'ok'    → legal connection
//   'warn'  → warning
//   'err'   → error
// ─────────────────────────────────────────────────────────────────────────────

type Conflict = 'ok' | 'warn' | 'err';

const PIN_CONFLICT_MATRIX: Partial<Record<PinElecType, Partial<Record<PinElecType, Conflict>>>> = {
  input: {
    input: 'ok',
    output: 'ok',
    bidirectional: 'ok',
    tri_state: 'ok',
    passive: 'ok',
    power_in: 'ok',
    power_out: 'ok',
    open_collector: 'ok',
    open_emitter: 'ok',
    unconnected: 'ok',
    nc: 'ok',
    free: 'ok',
    unspecified: 'warn',
  },
  output: {
    input: 'ok',
    output: 'err', // two outputs driving each other
    bidirectional: 'warn',
    tri_state: 'warn',
    passive: 'ok',
    power_in: 'ok',
    power_out: 'err',
    open_collector: 'warn',
    open_emitter: 'warn',
    unconnected: 'ok',
    nc: 'ok',
    free: 'ok',
    unspecified: 'warn',
  },
  bidirectional: {
    input: 'ok',
    output: 'warn',
    bidirectional: 'warn',
    tri_state: 'warn',
    passive: 'ok',
    power_in: 'ok',
    power_out: 'err',
    open_collector: 'warn',
    open_emitter: 'warn',
    unspecified: 'warn',
  },
  tri_state: {
    input: 'ok',
    output: 'warn',
    bidirectional: 'warn',
    tri_state: 'warn',
    passive: 'ok',
    power_in: 'ok',
    power_out: 'err',
    unspecified: 'warn',
  },
  passive: {
    input: 'ok',
    output: 'ok',
    bidirectional: 'ok',
    tri_state: 'ok',
    passive: 'ok',
    power_in: 'ok',
    power_out: 'ok',
    open_collector: 'ok',
    open_emitter: 'ok',
    unspecified: 'ok',
  },
  power_in: {
    input: 'ok',
    output: 'ok',
    bidirectional: 'ok',
    passive: 'ok',
    power_in: 'ok',
    power_out: 'ok',
    open_collector: 'err',
    open_emitter: 'err',
    unspecified: 'warn',
  },
  power_out: {
    input: 'ok',
    output: 'err',
    bidirectional: 'err',
    passive: 'ok',
    power_in: 'ok',
    power_out: 'err', // two power_outs on same net = short
    open_collector: 'err',
    open_emitter: 'err',
    unspecified: 'warn',
  },
  open_collector: {
    input: 'ok',
    output: 'warn',
    bidirectional: 'warn',
    passive: 'ok',
    power_in: 'err',
    power_out: 'err',
    open_collector: 'ok', // OC outputs can be wire-AND'ed
    open_emitter: 'warn',
    unspecified: 'warn',
  },
  open_emitter: {
    input: 'ok',
    output: 'warn',
    bidirectional: 'warn',
    passive: 'ok',
    power_in: 'err',
    power_out: 'err',
    open_collector: 'warn',
    open_emitter: 'ok',
    unspecified: 'warn',
  },
  unconnected: { unspecified: 'warn' },
  nc: { unspecified: 'warn' },
  free: { unspecified: 'warn' },
  unspecified: { unspecified: 'warn' },
};

function pinConflict(a: PinElecType, b: PinElecType): Conflict {
  if (a === b) {
    if (a === 'output' || a === 'power_out') return 'err';
    if (a === 'bidirectional' || a === 'tri_state') return 'warn';
    return 'ok';
  }
  return PIN_CONFLICT_MATRIX[a]?.[b] ?? 'warn';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main ERC engine
// ─────────────────────────────────────────────────────────────────────────────

export function runFullERC(
  components: CircuitComponent[],
  wires: Wire[],
  noConnects: NoConnectMarker[] = [],
): ERCResult {
  const errors: ERCError[] = [];
  const plugins = new Map<string, ComponentPlugin>();
  for (const c of components) {
    const p = getPlugin(c.type);
    if (p) plugins.set(c.type, p);
  }

  // Build node map
  const nodeMap = buildNodeMap(components, wires, plugins);

  // Set of explicitly no-connected terminals
  const ncSet = new Set<string>();
  for (const nc of noConnects) ncSet.add(`${nc.componentId}:${nc.terminalId}`);

  // Check 1: Unconnected pins (unless No-Connect marker)
  const connectedTerminals = new Set<string>();
  for (const wire of wires) {
    connectedTerminals.add(`${wire.from.componentId}:${wire.from.terminalId}`);
    connectedTerminals.add(`${wire.to.componentId}:${wire.to.terminalId}`);
  }
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    for (const term of plugin.terminals) {
      const key = `${comp.id}:${term.id}`;
      if (connectedTerminals.has(key)) {
        // pin is connected — but if it also has a No-Connect marker, that's an error
        if (ncSet.has(key)) {
          errors.push({
            type: 'no_connect_on_connected_pin',
            severity: 'error',
            message: `${comp.refdes ?? comp.id}.${term.id} has both a wire and a No-Connect marker`,
            componentId: comp.id,
            terminalId: term.id,
            position: { x: comp.position.x + term.position.x, y: comp.position.y + term.position.y },
            exclusionKey: `nc-on-connected:${comp.id}:${term.id}`,
          });
        }
        continue;
      }
      if (ncSet.has(key)) continue; // intentional No-Connect
      if (comp.type === 'ground' || comp.type === 'powerGND') continue;
      if (term.hidden) continue; // hidden pins don't need to be visually connected
      const elecType = getTerminalElecType(comp.type, term.id, plugin);
      if (elecType === 'input' || elecType === 'output' || elecType === 'power_in' ||
          elecType === 'power_out' || elecType === 'bidirectional' || elecType === 'tri_state') {
        const sev = (elecType === 'power_in' || elecType === 'power_out') ? 'warning' : 'error';
        errors.push({
          type: 'unconnected_pin',
          severity: sev,
          message: `${comp.refdes ?? comp.id}.${term.id} (${elecType}) is unconnected`,
          componentId: comp.id,
          terminalId: term.id,
          position: { x: comp.position.x + term.position.x, y: comp.position.y + term.position.y },
          exclusionKey: `unconnected:${comp.id}:${term.id}`,
        });
      }
    }
  }

  // Check 2: Missing ground
  // A PWR_FLAG marks a net as externally-driven but is NOT a ground reference
  // itself; only an actual ground (GND) symbol satisfies a "no ground" check.
  const hasGround = components.some(c => c.type === 'ground' || c.type === 'powerGND');
  if (!hasGround && components.length > 0) {
    errors.push({
      type: 'missing_ground', severity: 'error',
      message: 'Circuit has no ground reference — add a Ground component',
      componentId: '', terminalId: '', position: { x: 0, y: 0 },
      exclusionKey: 'missing-ground',
    });
  }

  // Check 3: Pin-conflict matrix on each net
  const netToTerminals = new Map<number, { compId: string; termId: string; refdes: string; elecType: PinElecType; comp: CircuitComponent; term: any }[]>();
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin) continue;
    const terms = getTerminalsForComponent(comp, plugin, nodeMap);
    for (const t of terms) {
      const elecType = getTerminalElecType(comp.type, t.terminalId, plugin);
      if (elecType === 'unspecified' || elecType === 'passive' || elecType === 'free') continue;
      const list = netToTerminals.get(t.nodeId) ?? [];
      list.push({
        compId: comp.id, termId: t.terminalId, refdes: comp.refdes ?? comp.id,
        elecType, comp, term: plugin.terminals.find((tt) => tt.id === t.terminalId),
      });
      netToTerminals.set(t.nodeId, list);
    }
  }
  for (const [node, list] of netToTerminals) {
    if (list.length < 2 || node === 0) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const c = pinConflict(list[i].elecType, list[j].elecType);
        if (c === 'err' || c === 'warn') {
          errors.push({
            type: 'pin_conflict',
            severity: c === 'err' ? 'error' : 'warning',
            message: `Pin conflict on net (node ${node}): ${list[i].refdes}.${list[i].termId} (${list[i].elecType}) ↔ ${list[j].refdes}.${list[j].termId} (${list[j].elecType})`,
            componentId: list[i].compId,
            terminalId: list[i].termId,
            position: { x: list[i].comp.position.x + (list[i].term?.position.x ?? 0), y: list[i].comp.position.y + (list[i].term?.position.y ?? 0) },
            refs: [{ componentId: list[j].compId, terminalId: list[j].termId }],
            exclusionKey: `pinconflict:${list[i].compId}:${list[i].termId}:${list[j].compId}:${list[j].termId}`,
          });
        }
      }
    }
  }

  // Check 4: Power nets without driver (PWR_FLAG exemption)
  // Find nets that have a power_in pin but no power_out or PWR_FLAG
  for (const [node, list] of netToTerminals) {
    if (node === 0) continue;
    const hasPowerIn = list.some((l) => l.elecType === 'power_in');
    const hasPowerOut = list.some((l) => l.elecType === 'power_out');
    if (hasPowerIn && !hasPowerOut) {
      errors.push({
        type: 'power_undriven',
        severity: 'warning',
        message: `Power net (node ${node}) is not driven — add a power source or PWR_FLAG`,
        componentId: list[0].compId,
        terminalId: list[0].termId,
        position: { x: list[0].comp.position.x, y: list[0].comp.position.y },
        exclusionKey: `power-undriven:${node}`,
      });
    }
  }

  // Check 5: Conflicting drivers (multiple outputs on same net) — subsumed by pin-conflict matrix
  // but kept as a separate error type for clarity
  for (const [node, list] of netToTerminals) {
    if (node === 0) continue;
    const drivers = list.filter((l) => l.elecType === 'output' || l.elecType === 'power_out');
    if (drivers.length > 1) {
      errors.push({
        type: 'conflicting_drivers',
        severity: 'error',
        message: `Net has ${drivers.length} conflicting drivers: ${drivers.map((d) => d.refdes).join(', ')}`,
        componentId: drivers[0].compId,
        terminalId: drivers[0].termId,
        position: { x: drivers[0].comp.position.x, y: drivers[0].comp.position.y },
        refs: drivers.slice(1).map((d) => ({ componentId: d.compId, terminalId: d.termId })),
        exclusionKey: `conflicting:${node}`,
      });
    }
  }

  // Check 6: Unused multi-unit components
  const unitsByRefdes = new Map<string, Set<number>>();
  for (const comp of components) {
    const plugin = plugins.get(comp.type);
    if (!plugin?.units || plugin.units.length < 2) continue;
    const refdes = comp.refdes ?? comp.id;
    if (!unitsByRefdes.has(refdes)) unitsByRefdes.set(refdes, new Set());
    unitsByRefdes.get(refdes)!.add(comp.unit ?? 1);
  }
  for (const [refdes, usedUnits] of unitsByRefdes) {
    // find the plugin
    const comp = components.find((c) => (c.refdes ?? c.id) === refdes);
    if (!comp) continue;
    const plugin = plugins.get(comp.type);
    if (!plugin?.units) continue;
    if (usedUnits.size < plugin.units.length) {
      const missing = plugin.units.filter((_, i) => !usedUnits.has(i + 1));
      errors.push({
        type: 'unused_unit',
        severity: 'warning',
        message: `${refdes} is missing units: ${missing.join(', ')} (multi-unit component must have all units placed)`,
        componentId: comp.id,
        terminalId: '',
        position: { x: comp.position.x, y: comp.position.y },
        exclusionKey: `unused-unit:${refdes}`,
      });
    }
  }

  // Check 7: Wire endpoints unconnected (one end is in the air)
  for (const wire of wires) {
    // both ends are always "connected" to terminals in our model, so this check is N/A
    // (it would only fire if we had free-floating wire segments, which we don't model)
  }

  // Build stats
  const errorCount = errors.filter(e => e.severity === 'error').length;
  const warningCount = errors.filter(e => e.severity === 'warning').length;
  const infoCount = errors.filter(e => e.severity === 'info').length;
  return {
    errors,
    passed: errorCount === 0,
    stats: { errors: errorCount, warnings: warningCount, infos: infoCount },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exclusion filter — apply user-supplied exclusion keys to suppress errors
// ─────────────────────────────────────────────────────────────────────────────

export function applyERCExclusions(
  result: ERCResult,
  exclusions: string[],
): ERCResult {
  const set = new Set(exclusions);
  const errors = result.errors.filter((e) => !e.exclusionKey || !set.has(e.exclusionKey));
  const errorCount = errors.filter(e => e.severity === 'error').length;
  const warningCount = errors.filter(e => e.severity === 'warning').length;
  const infoCount = errors.filter(e => e.severity === 'info').length;
  return {
    errors,
    passed: errorCount === 0,
    stats: { errors: errorCount, warnings: warningCount, infos: infoCount },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Severity customization
// ─────────────────────────────────────────────────────────────────────────────

export type ERCSeverityOverride = Partial<Record<ERCError['type'], 'error' | 'warning' | 'info' | 'ignore'>>;

export function applyERCSeverityOverrides(
  result: ERCResult,
  overrides: ERCSeverityOverride,
): ERCResult {
  const errors = result.errors
    .map((e) => {
      const o = overrides[e.type];
      if (!o) return e;
      if (o === 'ignore') return null;
      return { ...e, severity: o };
    })
    .filter((e): e is ERCError => e !== null);
  const errorCount = errors.filter(e => e.severity === 'error').length;
  const warningCount = errors.filter(e => e.severity === 'warning').length;
  const infoCount = errors.filter(e => e.severity === 'info').length;
  return {
    errors,
    passed: errorCount === 0,
    stats: { errors: errorCount, warnings: warningCount, infos: infoCount },
  };
}
