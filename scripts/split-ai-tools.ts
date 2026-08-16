// Splits the AI tools index.ts into category files.
// Each section is delimited by comment headers like "// SCHEMATIC COMPONENT TOOLS".

import * as fs from 'fs';
import * as path from 'path';

const sourceFile = 'src/lib/ai/tools/index.ts';
const outputDir = 'src/lib/ai/tools';
const content = fs.readFileSync(sourceFile, 'utf-8');
const lines = content.split('\n');

// The shared imports that every tool file needs
const sharedImports = `import type { Tool } from './types';
import type { ToolContext } from './types';
import { genId, findComponent } from './helpers';
import type { CircuitDocument, CircuitComponent, Wire, SimContext } from '@/lib/circuit/types';
import { simulateStep, buildNodeMap, getTerminalsForComponent, computeComponentCurrents, computeWireCurrents, solveDC } from '@/lib/circuit/engine';
import { getPlugin, getAllPlugins, getPluginsByCategory } from '@/lib/circuit/registry';
import { validatePhysics } from '@/lib/circuit/physics-validator';
import { exampleCategories } from '@/lib/circuit/examples';
import { exportSPICENetlist, exportBOMCSV, exportKiCadNetlist } from '@/lib/circuit/netlist-export';
import { runDRC } from '@/lib/pcb/drc';
import { verifyNetlist } from '@/lib/pcb/netlist-verify';
import { autoRoute } from '@/lib/pcb/auto-router';
import { routeTopologically, DEFAULT_ROUTER_OPTIONS } from '@/lib/pcb/topological-router';
`;

// Find section boundaries — look for lines that are ALL CAPS comments
// like "// SCHEMATIC COMPONENT TOOLS"
const sections: { name: string; start: number; end: number }[] = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  // Match section headers: "// ALL CAPS WORDS" but not the separator lines
  if (line.startsWith('// ') && line === line.toUpperCase() && !line.includes('─') && line.length > 5) {
    sections.push({ name: line.replace('// ', ''), start: i, end: lines.length });
  }
}
// Set end boundaries
for (let i = 0; i < sections.length - 1; i++) {
  sections[i].end = sections[i + 1].start;
}

console.log('Found sections:');
for (const s of sections) {
  console.log(`  ${s.name} (lines ${s.start + 1}-${s.end})`);
}

// Extract each section into a file
for (const section of sections) {
  // Skip the TOOL REGISTRY section (we'll rebuild it in index.ts)
  if (section.name.includes('TOOL REGISTRY')) continue;

  // Get the section content (skip the header comment line)
  const sectionLines = lines.slice(section.start + 1, section.end);
  // Remove trailing empty lines
  while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].trim() === '') {
    sectionLines.pop();
  }

  if (sectionLines.length === 0) continue;

  // Find all exported const names in this section
  const toolNames: string[] = [];
  for (const line of sectionLines) {
    const match = line.match(/^const (\w+Tool): Tool/);
    if (match) toolNames.push(match[1]);
  }

  if (toolNames.length === 0) continue;

  // Generate filename from section name
  const fileName = section.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') + '.ts';

  // Create the file
  const fileContent = `// ${section.name}
// Auto-extracted from the original ai/tools/index.ts during refactor.

${sharedImports}
${sectionLines.join('\n')}

export { ${toolNames.join(', ')} };
`;

  fs.writeFileSync(path.join(outputDir, fileName), fileContent);
  console.log(`  Created ${fileName} with ${toolNames.length} tools: ${toolNames.join(', ')}`);
}

console.log('\nDone! Now update index.ts to import from these files.');
