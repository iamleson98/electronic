// Fast terminal -> node lookup for plugin stamp()/step() hot paths.
//
// The engine passes terminals in plugin.terminals order, so the expected slot
// is almost always right; fall back to a linear find when a caller passes a
// differently ordered array (tests, ad-hoc harnesses). Behaviour is identical
// to `terminals.find((t) => t.terminalId === id)!.nodeId` (throws the same
// TypeError when the terminal is absent).
export function termNode(
  terminals: { terminalId: string; nodeId: number }[],
  id: string,
  hint: number,
): number {
  const t = terminals[hint];
  if (t !== undefined && t.terminalId === id) return t.nodeId;
  return terminals.find((x) => x.terminalId === id)!.nodeId;
}
