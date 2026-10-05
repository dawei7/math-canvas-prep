// Check what an agent delivered for a queue of books, without trusting its report, its progress file or its certificate.
//
//   node scripts/check-delivery.mjs <queue.json | folder of PDFs> --work <root of the work folders> [--out DIR] [--only NAME[,NAME]] [--allow-zero NAME[,NAME]] [--copy-bundles DIR]
//   npm run check-delivery -- <queue.json | folder of PDFs> --work <root of the work folders>
//
// The queue is the one that audit-books.mjs reads (a queue file, or a folder of PDFs with sidecars). The work folder of a book is
// <work>/<book name>/ (the WORK of docs/AGENT_RUNBOOK.md). For every book the project, the notes, the certificate and the bundle in it are
// opened, the gate is run again from scratch in memory, the bundle is checked as the importer checks it and compared with the one the project
// gives now. DELIVERY.md and DELIVERY.json go to --out (default: the work root); nothing is ever written into a work folder. --copy-bundles
// DIR copies the accepted bundles into DIR/perfect, DIR/awaiting-confirmation and DIR/draft.
//
// Exit code: 0 only when every book that was checked is PERFECT, 1 when any is not, 2 for a usage error. What is checked and how a verdict
// is reached lives in packages/cli/src/delivery.ts (tested); this file only starts it. Run `npm run build` first.
import { runDeliveryCheck } from '../packages/cli/dist/index.js';

try {
  process.exitCode = await runDeliveryCheck(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
  });
} catch (error) {
  console.error(`check-delivery stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
