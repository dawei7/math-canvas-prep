import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, type ServerOptions } from './server.js';

export { createServer, type ServerOptions } from './server.js';

/** Serves the tools over standard input and output until the client disconnects. Nothing else writes to stdout. */
export async function runStdio(options: ServerOptions = {}): Promise<void> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
}
