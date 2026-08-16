// Splits a file with multiple exported React components into individual files.
// Usage: bun scripts/split-file.ts <input-file> <output-dir> [--keep-original]
//
// The script:
// 1. Reads the input file
// 2. Extracts the shared import block (everything before the first export)
// 3. Finds each `export function` / `export const` / `export interface` / `export type`
// 4. Creates one file per export in the output directory
// 5. Creates an index.ts barrel that re-exports everything
// 6. Replaces the original file with a barrel re-export (for backward compat)

import * as fs from 'fs';
import * as path from 'path';

const inputFile = process.argv[2];
const outputDir = process.argv[3];
const keepOriginal = process.argv.includes('--keep-original');

if (!inputFile || !outputDir) {
  console.error('Usage: bun scripts/split-file.ts <input-file> <output-dir> [--keep-original]');
  process.exit(1);
}

const content = fs.readFileSync(inputFile, 'utf-8');
const lines = content.split('\n');

// Find the import block — everything from the start until the first
// `export function` / `export const` / `export interface` / `export type`
// that is NOT inside a comment.
let importEnd = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (line.startsWith('export ') && !line.startsWith('export {') && !line.startsWith('export *')) {
    importEnd = i;
    break;
  }
  // Also stop at section comments (// ─── ...)
  if (line.startsWith('// ───') && importEnd > 0) {
    importEnd = i;
    break;
  }
}

// Find the actual first export line (skip comment blocks before it)
let firstExportLine = 0;
for (let i = importEnd; i < lines.length; i++) {
  const line = lines[i].trim();
  if (line.startsWith('export ')) {
    firstExportLine = i;
    break;
  }
}

const importBlock = lines.slice(0, firstExportLine).join('\n');

// Now find all export boundaries
interface ExportBlock {
  name: string;
  type: 'function' | 'const' | 'interface' | 'type';
  startLine: number;
  endLine: number;
  content: string;
}

const exports: ExportBlock[] = [];
let i = firstExportLine;
while (i < lines.length) {
  const line = lines[i].trim();
  // Match: export function NAME, export const NAME, export interface NAME, export type NAME
  const match = line.match(/^export\s+(function|const|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (match) {
    const type = match[1] as 'function' | 'const' | 'interface' | 'type';
    const name = match[2];
    const startLine = i;

    // Find the end of this export:
    // - For function/const: find the matching closing brace
    // - For interface/type: find the matching closing brace
    let braceDepth = 0;
    let foundOpenBrace = false;
    let endLine = i;

    for (let j = i; j < lines.length; j++) {
      const l = lines[j];
      for (const ch of l) {
        if (ch === '{') { braceDepth++; foundOpenBrace = true; }
        if (ch === '}') { braceDepth--; }
        // For const without braces (e.g., `export const X = 5;`)
        if (ch === ';' && !foundOpenBrace && type === 'const') {
          endLine = j;
          break;
        }
      }
      if (foundOpenBrace && braceDepth === 0) {
        endLine = j;
        break;
      }
      // For const without braces that ended on ;
      if (type === 'const' && !foundOpenBrace && j > i) {
        const trimmed = lines[j].trim();
        if (trimmed.endsWith(';')) {
          endLine = j;
          break;
        }
      }
    }

    const content = lines.slice(startLine, endLine + 1).join('\n');
    exports.push({ name, type, startLine, endLine, content });
    i = endLine + 1;

    // Skip any comment lines between exports
    while (i < lines.length && lines[i].trim().startsWith('//')) {
      i++;
    }
  } else {
    i++;
  }
}

console.log(`Found ${exports.length} exports in ${inputFile}:`);
for (const e of exports) {
  console.log(`  - ${e.type} ${e.name} (lines ${e.startLine + 1}-${e.endLine + 1})`);
}

// Create the output directory
fs.mkdirSync(outputDir, { recursive: true });

// Create one file per export
for (const exp of exports) {
  const fileName = exp.name.replace(/([A-Z])/g, (match, _, offset) => {
    return offset === 0 ? match.toLowerCase() : '-' + match.toLowerCase();
  }).replace(/-/g, '') + '.tsx';

  // Actually, let's use a simpler naming: just the export name with PascalCase
  const simpleFileName = exp.name + (exp.type === 'function' || exp.type === 'const' ? '.tsx' : '.ts');

  const fileContent = `'use client';

${importBlock.replace("'use client';\n\n", '')}

${exp.content}
`;

  fs.writeFileSync(path.join(outputDir, simpleFileName), fileContent);
  console.log(`  Created ${simpleFileName}`);
}

// Create index.ts barrel
const barrelContent = `// Auto-generated barrel: re-exports all dialog components.
${exports.map(e => `export { ${e.name} } from './${e.name}';`).join('\n')}
`;
fs.writeFileSync(path.join(outputDir, 'index.ts'), barrelContent);
console.log(`  Created index.ts barrel`);

// Replace the original file with a re-export barrel (for backward compat)
if (!keepOriginal) {
  const relativeDir = path.relative(path.dirname(inputFile), outputDir);
  const reExportContent = `// This file is now a barrel — all dialogs have been split into individual files
// in ${relativeDir}/. This file re-exports them for backward compatibility with
// existing imports like: import { FindReplaceDialog } from './SchematicDialogs';
export * from './${relativeDir}/index';
`;
  fs.writeFileSync(inputFile, reExportContent);
  console.log(`  Replaced ${inputFile} with re-export barrel`);
}

console.log('\nDone!');
