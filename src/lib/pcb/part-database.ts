// Local part database with manufacturer information.
// Hand-curated database of common electronic parts with MPN, distributor links,
// datasheets, and pricing. Used by the Library Manager and BOM exporter.

export interface PartInfo {
  mpn: string;
  manufacturer: string;
  description: string;
  package: string;
  category: 'resistor' | 'capacitor' | 'inductor' | 'diode' | 'transistor' | 'ic' | 'connector' | 'led' | 'misc';
  digikeyPN?: string;
  mouserPN?: string;
  /** LCSC part number for JLCPCB assembly ordering */
  lcscPN?: string;
  datasheet?: string;
  unitPrice?: number;
  moq?: number;
}

export const partDatabase: PartInfo[] = [
  // ICs
  { mpn: 'NE555P', manufacturer: 'Texas Instruments', description: 'Single Precision Timer', package: 'DIP-8', category: 'ic', digikeyPN: '296-NE555P-ND', mouserPN: '595-NE555P', datasheet: 'https://www.ti.com/lit/ds/symlink/ne555.pdf', unitPrice: 0.45, moq: 1 },
  { mpn: 'LM358P', manufacturer: 'Texas Instruments', description: 'Dual Operational Amplifier', package: 'DIP-8', category: 'ic', digikeyPN: '296-1395-5-ND', mouserPN: '595-LM358P', unitPrice: 0.32, moq: 1 },
  { mpn: 'LM7805', manufacturer: 'STMicroelectronics', description: '5V Positive Voltage Regulator', package: 'TO-220', category: 'ic', digikeyPN: '497-1443-5-ND', mouserPN: '511-L7805CV', unitPrice: 0.55, moq: 1 },
  { mpn: '74HC00N', manufacturer: 'Nexperia', description: 'Quad 2-input NAND gate', package: 'DIP-14', category: 'ic', digikeyPN: '1727-2845-5-ND', mouserPN: '771-74HC00N', unitPrice: 0.35, moq: 1 },
  { mpn: '74HC595', manufacturer: 'Texas Instruments', description: '8-bit serial-in parallel-out shift register', package: 'DIP-16', category: 'ic', digikeyPN: '296-1600-5-ND', mouserPN: '595-SN74HC595N', unitPrice: 0.42, moq: 1 },
  { mpn: 'ATmega328P-PU', manufacturer: 'Microchip', description: '8-bit AVR microcontroller (Arduino)', package: 'DIP-28', category: 'ic', digikeyPN: 'ATmega328P-PU-ND', mouserPN: '556-ATmega328P-PU', unitPrice: 2.88, moq: 1 },
  { mpn: 'ESP32-WROOM-32', manufacturer: 'Espressif', description: 'WiFi + Bluetooth MCU module', package: 'QFN-38', category: 'ic', digikeyPN: '1904-ESP32-WROOM-32D-ND', mouserPN: '356-ESP32-WROOM-32D', unitPrice: 2.85, moq: 1 },
  { mpn: 'CD4017BE', manufacturer: 'Texas Instruments', description: 'CMOS decade counter', package: 'DIP-16', category: 'ic', digikeyPN: '296-2061-5-ND', mouserPN: '595-CD4017BE', unitPrice: 0.52, moq: 1 },
  { mpn: 'LM386N-1', manufacturer: 'Texas Instruments', description: 'Audio power amplifier, 325mW', package: 'DIP-8', category: 'ic', digikeyPN: '296-4395-5-ND', mouserPN: '595-LM386N-1', unitPrice: 0.78, moq: 1 },
  // Transistors
  { mpn: '2N3904', manufacturer: 'ON Semiconductor', description: 'NPN general-purpose transistor', package: 'TO-92', category: 'transistor', digikeyPN: '2N3904-ND', mouserPN: '512-2N3904', unitPrice: 0.10, moq: 1 },
  { mpn: '2N3906', manufacturer: 'ON Semiconductor', description: 'PNP general-purpose transistor', package: 'TO-92', category: 'transistor', digikeyPN: '2N3906-ND', mouserPN: '512-2N3906', unitPrice: 0.10, moq: 1 },
  { mpn: 'IRF540N', manufacturer: 'Infineon', description: 'N-channel MOSFET, 33A 100V', package: 'TO-220', category: 'transistor', digikeyPN: 'IRF540NPBF-ND', mouserPN: '942-IRF540NPBF', unitPrice: 1.20, moq: 1 },
  { mpn: 'BC547', manufacturer: 'Nexperia', description: 'NPN transistor, 45V 100mA', package: 'TO-92', category: 'transistor', digikeyPN: '1727-2919-ND', mouserPN: '771-BC547BCT', unitPrice: 0.06, moq: 1 },
  // Diodes
  { mpn: '1N4148', manufacturer: 'ON Semiconductor', description: 'Small-signal fast switching diode', package: 'DO-35', category: 'diode', digikeyPN: '1N4148FS-ND', mouserPN: '512-1N4148', unitPrice: 0.04, moq: 1 },
  { mpn: '1N4007', manufacturer: 'ON Semiconductor', description: 'General-purpose rectifier, 1000V 1A', package: 'DO-41', category: 'diode', digikeyPN: '1N4007-ND', mouserPN: '512-1N4007', unitPrice: 0.08, moq: 1 },
  { mpn: '1N5817', manufacturer: 'ON Semiconductor', description: 'Schottky rectifier, 20V 1A', package: 'DO-41', category: 'diode', digikeyPN: '1N5817-ND', mouserPN: '512-1N5817', unitPrice: 0.16, moq: 1 },
  // LEDs
  { mpn: 'WP710A10ID', manufacturer: 'Kingbright', description: 'Red LED, 5mm THT', package: 'LED-5mm', category: 'led', digikeyPN: '754-1602-ND', mouserPN: '604-WP710A10ID', unitPrice: 0.18, moq: 1 },
  { mpn: 'WP710A10SGD', manufacturer: 'Kingbright', description: 'Green LED, 5mm THT', package: 'LED-5mm', category: 'led', digikeyPN: '754-1610-ND', mouserPN: '604-WP710A10SGD', unitPrice: 0.18, moq: 1 },
  // Connectors
  { mpn: 'PEC02SAAN', manufacturer: 'Sullins', description: '2.54mm pin header, 1×2', package: 'PinHeader-1x2', category: 'connector', digikeyPN: 'S1012EC-40-ND', mouserPN: '710-PEC02SAAN', unitPrice: 0.12, moq: 1 },
  { mpn: 'PEC04SAAN', manufacturer: 'Sullins', description: '2.54mm pin header, 1×4', package: 'PinHeader-1x4', category: 'connector', digikeyPN: 'S1012EC-40-ND', mouserPN: '710-PEC04SAAN', unitPrice: 0.18, moq: 1 },
  { mpn: 'PJ-102A', manufacturer: 'CUI Devices', description: 'DC power jack, 2.1mm', package: 'DCJack', category: 'connector', digikeyPN: 'CP-102A-ND', mouserPN: '490-PJ-102A', unitPrice: 0.65, moq: 1 },
  // Resistors (common values)
  ...[10, 100, 220, 330, 470, 1000, 2200, 4700, 10000, 22000, 47000, 100000, 220000, 470000, 1000000].map(v => ({
    mpn: `RC0805FR-07${v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}K` : `${v}`}RL`,
    manufacturer: 'Yageo',
    description: `${v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}K` : v}Ω resistor, 1% 1/8W, 0805`,
    package: '0805',
    category: 'resistor' as const,
    unitPrice: 0.01,
    moq: 1,
  })),
  // Capacitors (common values)
  ...[1e-9, 10e-9, 100e-9, 1e-6, 10e-6, 100e-6].map(c => {
    const label = c >= 1e-6 ? `${c * 1e6}uF` : `${c * 1e9}nF`;
    return {
      mpn: `CC0805KKX7R${label}`,
      manufacturer: 'Yageo',
      description: `${label} capacitor, X7R, 50V, 0805`,
      package: '0805',
      category: 'capacitor' as const,
      unitPrice: 0.03,
      moq: 1,
    };
  }),
];

export function searchParts(query: string): PartInfo[] {
  if (!query.trim()) return partDatabase;
  const q = query.toLowerCase();
  return partDatabase.filter(p =>
    p.mpn.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q) ||
    p.package.toLowerCase().includes(q) ||
    p.manufacturer.toLowerCase().includes(q)
  );
}

export function getPartsByCategory(category: PartInfo['category']): PartInfo[] {
  return partDatabase.filter(p => p.category === category);
}
