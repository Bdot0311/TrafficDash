#!/usr/bin/env node
// Print the joined report to stdout. Same code path the dashboard uses.
import { getReport } from '../server.js';

const report = await getReport({ force: true });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (report.state === 'unconfigured') {
  console.error('\nPostHog is not connected. Run `npm start` and open /settings.\n');
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

const stripe = report.connected.stripe ? 'PostHog + Stripe' : 'PostHog only';
console.log(`\nTrafficDash · ${stripe} · last ${report.windowDays} days\n`);
console.log(
  pad('SOURCE', 26) +
    ['VISITORS', 'SCANNERS', 'SIGNUPS', 'CHECKOUT', 'PAID'].map((h) => num(h, 10)).join('') +
    num('REVENUE', 11) +
    '  CONFIDENCE',
);
console.log('-'.repeat(102));

for (const s of report.sources) {
  console.log(
    pad(s.label, 26) +
      report.stages.map((st) => num(s.counts[st], 10)).join('') +
      num(s.revenue ? `$${s.revenue.toFixed(2)}` : '-', 11) +
      '  ' +
      s.confidence,
  );
}

console.log('-'.repeat(102));
console.log(
  pad('ALL SOURCES', 26) +
    report.stages.map((st) => num(report.totals[st], 10)).join('') +
    num(`$${report.revenue.attributed.toFixed(2)}`, 11),
);

// Attributed + unattributed must equal what Stripe took, or the funnel is
// quietly reporting less revenue than the account actually made.
if (report.revenue.unattributed > 0) {
  console.log(
    pad('UNATTRIBUTED', 26) +
      ''.padStart(50) +
      num(`$${report.revenue.unattributed.toFixed(2)}`, 11),
  );
  console.log(
    pad('COLLECTED IN STRIPE', 26) +
      ''.padStart(50) +
      num(`$${report.revenue.collected.toFixed(2)}`, 11),
  );
}

for (const w of report.warnings) console.log(`\n  [${w.level}] ${w.text}`);
console.log();
