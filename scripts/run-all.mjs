// Runs every regression suite and fails on the first non-zero exit.
// Usage: npm test  (or: node scripts/run-all.mjs)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const suites = [
  { name: 'route/declaration consistency (3-way)', file: 'scripts/test-route-consistency.mjs', node: [] },
  { name: 'desktop /api fetch routes', file: 'scripts/test-desktop-routes.mjs', node: [] },
  { name: 'stream / range / traversal', file: 'scripts/test-stream.mjs', node: [] },
  { name: 'security / limits', file: 'scripts/test-security.mjs', node: [] },
  { name: 'perf / memory / fd', file: 'scripts/test-perf.mjs', node: ['--expose-gc'] },
  { name: 'leak / release surface (reload, fd, cpu)', file: 'scripts/test-leak.mjs', node: ['--expose-gc'] },
  { name: 'plugin lifecycle (process)', file: 'scripts/test-lifecycle.mjs', node: [] },
  { name: 'progress bar', file: 'scripts/test-progress.mjs', node: [] },
  { name: 'resume after cut', file: 'scripts/test-resume.mjs', node: [] },
  { name: 'refresh remap', file: 'scripts/test-refresh-remap.mjs', node: [] },
  { name: 'restore race', file: 'scripts/test-restore-race.mjs', node: [] },
  { name: 'teardown', file: 'scripts/test-teardown.mjs', node: [] },
  { name: 'poll teardown (no self-rearming timer)', file: 'scripts/test-poll-teardown.mjs', node: [] },
  { name: 'entry fallback (positive identification)', file: 'scripts/test-entry-fallback.mjs', node: [] },
  { name: 'teardown wins over in-flight hot reload', file: 'scripts/test-teardown-race.mjs', node: [] },
  { name: 'token lifetime (survives host reload)', file: 'scripts/test-token-lifetime.mjs', node: [] },
  { name: 'MV seek (absolute token source)', file: 'scripts/test-mv-seek.mjs', node: [] },
  { name: 'MV teardown (in-flight ffmpeg child)', file: 'scripts/test-mv-teardown.mjs', node: [] },
  { name: 'delete flow', file: 'scripts/test-delete.mjs', node: [] },
  { name: 'online metadata match (host)', file: 'scripts/test-match.mjs', node: [] },
  { name: 'apply tags + rename (host)', file: 'scripts/test-apply.mjs', node: [] },
  { name: 'online metadata match (client)', file: 'scripts/test-match-client.mjs', node: [] },
  { name: 'client shell: icons / tooltips / OS media', file: 'scripts/test-client-shell.mjs', node: [] },
  { name: 'static audit (dead code / css shadowing / i18n)', file: 'scripts/test-audit.mjs', node: [] },
  { name: 'MV / music video (scan / plan / ffmpeg remux)', file: 'scripts/test-mv.mjs', node: [] },
  { name: 'host hot reload', file: 'scripts/test-hot-reload.mjs', node: [] },
];
let failed = 0;
for (const suite of suites) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [...suite.node, suite.file], { cwd: root, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  const ok = run.status === 0;
  if (!ok) failed += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + suite.name + ' (' + (Date.now() - started) + ' ms)');
  if (!ok) console.log(run.stdout ?? '' + run.stderr ?? '');
}
console.log(failed === 0 ? 'ALL ' + suites.length + ' SUITES PASS' : failed + '/' + suites.length + ' SUITES FAILED');
process.exit(failed === 0 ? 0 : 1);
