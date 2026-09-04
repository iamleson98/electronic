// Example circuits dropdown — extracted from Toolbar.tsx.
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuGroup,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { exampleCategories } from '@/lib/circuit/examples';
import { FileText, ChevronDown } from 'lucide-react';
import type { CircuitDocument } from '@/lib/circuit/types';

export function ExamplesDropdown({
  loadDocument,
  disabled,
}: {
  loadDocument: (doc: CircuitDocument) => void;
  disabled: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" disabled={disabled}>
          <FileText size={14} />
          <span className="ml-1 hidden md:inline">Examples</span>
          <ChevronDown size={12} className="ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 bg-slate-900 border-slate-700 max-h-[70vh] overflow-y-auto">
        <DropdownMenuLabel className="text-slate-300">Load Example Circuit</DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-slate-700" />
        {exampleCategories.map((cat) => (
          <DropdownMenuGroup key={cat.label}>
            <DropdownMenuLabel className="text-xs text-cyan-400 font-semibold uppercase tracking-wide px-2 pt-3 pb-1">
              {cat.label}
            </DropdownMenuLabel>
            {cat.examples.map((ex) => (
              <DropdownMenuItem
                key={ex.name}
                onClick={() => loadDocument(ex.doc)}
                className="flex flex-col items-start gap-1 py-2 text-slate-200 hover:bg-slate-800"
              >
                <span className="text-sm font-medium">{ex.name}</span>
                <span className="text-xs text-slate-400">{ex.description}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
