// This file is now a barrel — all dialogs have been split into individual files
// in dialogs/analysis/. This file re-exports them for backward compatibility with
// existing imports like: import { FindReplaceDialog } from './SchematicDialogs';
export * from './dialogs/analysis/index';
