// Single executables cannot pass --disable-warning=ExperimentalWarning on a command line;
// node:sqlite is still flagged experimental in Node 24 although Livynq depends on it deliberately.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const type = typeof args[0] === 'string' ? args[0] : (args[0] as { type?: string } | undefined)?.type;
  const name = warning instanceof Error ? warning.name : type;
  if (name === 'ExperimentalWarning' && /SQLite/.test(String(warning instanceof Error ? warning.message : warning))) return;
  emitWarning(warning as string, ...(args as []));
}) as typeof process.emitWarning;
