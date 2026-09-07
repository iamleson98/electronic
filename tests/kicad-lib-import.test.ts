// Tests for the KiCad symbol-library importer (.kicad_sym / lib_symbols →
// SymbolDesign) — geometry conversion, y-flip, pin direction mapping,
// multi-unit merge, and type sanitization.

import { describe, it, expect } from 'vitest';
import {
  parseKicadSymbolLibrary,
  symbolNameToTypeId,
} from '../src/lib/circuit/kicad-lib-import';
import { symbolDesignToPlugin } from '../src/lib/circuit/symbol-editor-types';
import { registerPlugin, hasPlugin, getPlugin } from '../src/lib/circuit/registry';

const RESISTOR_LIB = `(kicad_symbol (version 20220914) (generator kicad_symbol_editor)
  (symbol "Device:R" (pin_numbers hide) (pin_names (offset 0.254)) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 2.54 0 90) (effects (font (size 1.27 1.27)) (justify right)))
    (property "Value" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "R_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54)
        (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.778)
        (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.778)
        (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
    )
  )
)`;

const IC_LIB = `(kicad_symbol (version 20220914) (generator kicad_symbol_editor)
  (symbol "Amplifier_Operational:LM358" (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
    (property "Value" "LM358" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
    (symbol "LM358_0_1"
      (polyline (pts (xy -2.54 2.54) (xy 2.54 0) (xy -2.54 -2.54) (xy -2.54 2.54))
        (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "LM358_1_1"
      (pin input line (at -7.62 2.54 0) (length 2.54)
        (name "+" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))
      (pin input line (at -7.62 -2.54 0) (length 2.54)
        (name "-" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
      (pin output line (at 7.62 0 180) (length 2.54)
        (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
    )
  )
)`;

describe('symbolNameToTypeId', () => {
  it('strips the library prefix and sanitizes', () => {
    expect(symbolNameToTypeId('Device:R')).toBe('kicad_r');
    expect(symbolNameToTypeId('Amplifier_Operational:LM358')).toBe('kicad_lm358');
  });

  it('replaces invalid characters', () => {
    expect(symbolNameToTypeId(' Connector:Conn_01x04 ')).toBe('kicad_conn_01x04');
  });

  it('leading digit gets an n prefix (type ids must start with a letter)', () => {
    expect(symbolNameToTypeId('Device:2N3904')).toBe('kicad_n2n3904');
  });
});

describe('parseKicadSymbolLibrary', () => {
  it('parses Device:R with correct pin geometry', () => {
    const { designs, warnings, skipped } = parseKicadSymbolLibrary(RESISTOR_LIB);
    expect(skipped).toHaveLength(0);
    expect(designs).toHaveLength(1);
    const d = designs[0];
    expect(d.type).toBe('kicad_r');
    expect(d.name).toBe('R');
    expect(d.pins).toHaveLength(2);

    // y-flip: KiCad +y (up) → our −y (up on screen). Pin "1" at lib (0, 3.81)
    // (top) must end up ABOVE pin "2" at lib (0, −3.81) (bottom).
    const p1 = d.pins.find((p) => p.number === '1')!;
    const p2 = d.pins.find((p) => p.number === '2')!;
    expect(p1.position.y).toBeLessThan(p2.position.y);

    // Pin direction: angle 270 = stub points up (pin 1 on top) → 'up';
    // angle 90 = pin 2 on the bottom → 'down'.
    expect(p1.direction).toBe('up');
    expect(p2.direction).toBe('down');

    // Pin length converted mm → grid units
    expect(p1.length).toBeCloseTo(1.778 / 2.54, 4);

    // Body rect converted
    expect(d.rects).toHaveLength(1);
    // All coordinates normalized to ≥ 0
    for (const p of d.pins) {
      expect(p.position.x).toBeGreaterThanOrEqual(0);
      expect(p.position.y).toBeGreaterThanOrEqual(0);
    }
    expect(d.boundingBox.width).toBeGreaterThan(0);
    void warnings;
  });

  it('parses the op-amp: left pins direction left, output direction right', () => {
    const { designs } = parseKicadSymbolLibrary(IC_LIB);
    expect(designs).toHaveLength(1);
    const d = designs[0];
    expect(d.pins).toHaveLength(3);
    const inPlus = d.pins.find((p) => p.number === '3')!;
    const out = d.pins.find((p) => p.number === '1')!;
    expect(inPlus.direction).toBe('left');
    expect(out.direction).toBe('right');
    // input pin is left of the output pin after normalization
    expect(inPlus.position.x).toBeLessThan(out.position.x);
    // electrical types preserved
    expect(inPlus.electricalType).toBe('input');
    expect(out.electricalType).toBe('output');
    // polyline (4 pts) → 3 line segments
    expect(d.lines.length).toBeGreaterThanOrEqual(3);
  });

  it('merges multi-unit symbols with a warning and skips De Morgan bodies', () => {
    const lib = `(kicad_symbol (version 20220914) (generator kicad_symbol_editor)
      (symbol "74xx:7400" (in_bom yes) (on_board yes)
        (symbol "7400_0_1" (polyline (pts (xy -5.08 0) (xy 0 5.08)) (stroke (width 0.254) (type default)) (fill none)))
        (symbol "7400_1_1"
          (pin input line (at -7.62 5.08 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
          (pin output line (at 7.62 5.08 180) (length 2.54) (name "Y" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))
        )
        (symbol "7400_2_1"
          (pin input line (at -7.62 -5.08 0) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
        )
        (symbol "7400_1_2"
          (circle (center 0 0) (radius 2.54) (stroke (width 0.254) (type default)) (fill none))
        )
      )
    )`;
    const { designs, warnings } = parseKicadSymbolLibrary(lib);
    expect(designs).toHaveLength(1);
    // unit 1 pins + unit 2 pin merged, unit 0 polyline kept
    expect(designs[0].pins.length).toBe(3);
    expect(warnings.some((w) => w.includes('merged'))).toBe(true);
    expect(warnings.some((w) => w.toLowerCase().includes('de morgan'))).toBe(true);
    // the style-2 circle must NOT be present (16 segment approximation absent)
    expect(designs[0].lines.length).toBe(1);
  });

  it('approximates circles as 16-segment polygons', () => {
    const lib = `(kicad_symbol (version 20220914) (generator kicad_symbol_editor)
      (symbol "Device:LED" (in_bom yes) (on_board yes)
        (symbol "LED_1_1"
          (pin passive line (at 0 3.81 270) (length 1.778) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
          (pin passive line (at 0 -3.81 90) (length 1.778) (name "K" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
          (circle (center 2.54 0) (radius 2.54) (stroke (width 0.254) (type default)) (fill none))
        )
      )
    )`;
    const { designs } = parseKicadSymbolLibrary(lib);
    expect(designs[0].lines.length).toBe(16);
  });

  it('extracts lib_symbols from a .kicad_sch schematic', () => {
    const sch = `(kicad_sch (version 20230121) (generator eeschema)
      (lib_symbols
        (symbol "Device:R" (in_bom yes) (on_board yes)
          (symbol "R_1_1"
            (pin passive line (at 0 3.81 270) (length 1.778) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
            (pin passive line (at 0 -3.81 90) (length 1.778) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
          )
        )
      )
      (symbol (lib_id "Device:R") (at 100 100 0) (property "Reference" "R1" (at 0 0 0)))
    )`;
    const { designs } = parseKicadSymbolLibrary(sch);
    expect(designs).toHaveLength(1);
    expect(designs[0].type).toBe('kicad_r');
    expect(designs[0].pins).toHaveLength(2);
  });

  it('rejects legacy KiCad 5 .lib files with a clear warning', () => {
    const { designs, warnings } = parseKicadSymbolLibrary('EESchema-LIBRARY Version 2.4\n# encoding utf-8\n');
    expect(designs).toHaveLength(0);
    expect(warnings[0]).toContain('KiCad 5');
  });

  it('skips graphical-only symbols (no pins)', () => {
    const lib = `(kicad_symbol (version 20220914) (generator kicad_symbol_editor)
      (symbol "Device:Logo" (in_bom yes) (on_board yes)
        (symbol "Logo_0_1" (polyline (pts (xy 0 0) (xy 5.08 0)) (stroke (width 0.254) (type default)) (fill none)))
      )
    )`;
    const { designs, skipped } = parseKicadSymbolLibrary(lib);
    expect(designs).toHaveLength(0);
    expect(skipped).toContain('Device:Logo');
  });

  it('imported designs convert to working plugins with terminals', () => {
    const { designs } = parseKicadSymbolLibrary(RESISTOR_LIB);
    const plugin = symbolDesignToPlugin(designs[0]);
    expect(plugin.terminals).toHaveLength(2);
    expect(plugin.boundingBox.width).toBeGreaterThan(0);
    // registration works and the palette can discover it
    if (!hasPlugin(plugin.type)) registerPlugin(plugin);
    expect(getPlugin(plugin.type)).toBeDefined();
  });
});
