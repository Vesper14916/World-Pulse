import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const skipped = new Set(['.git', 'node_modules', '.world-pulse', 'tmp']);
const textExtensions = new Set([
  '.cjs', '.css', '.geojson', '.html', '.js', '.json', '.md', '.mjs', '.sh', '.svg', '.ts', '.tsx', '.yml', '.yaml',
]);
const patterns = [
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i],
  ['token-like credential', /\b(?:sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
  ['credential in URL user information', /https?:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['secret in URL query', /https?:\/\/[^\s"'<>]+[?&](?:api[_-]?key|token|secret|password|authorization)=([^&\s"'<>]+)/i],
  ['private network URL', /https?:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[A-Z0-9.-]+\.(?:local|internal|lan))(?::\d+)?/i],
  ['local account path', /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
  ['non-placeholder credential assignment', /^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET|PRIVATE_KEY|PASSWORD)\s*=\s*([^\s#]+)/im],
  ['non-example email address', /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)|example\.invalid)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];
const placeholder = /^(?:your[-_ ]?(?:key|token|secret|password)|replace[-_ ]?me|example|test(?:[-_].*)?|<[^>]+>|\$\{[^}]+\})$/i;
const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && skipped.has(entry.name)) continue;
    if (skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.name === '.env.local' || /^\.env\..*\.local$/.test(entry.name)) continue;
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(entry.name.slice(entry.name.lastIndexOf('.'))))
      continue;
    if ((await lstat(path)).size > 8_000_000) continue;
    const source = await readFile(path, 'utf8');
    for (const [label, pattern] of patterns) {
      for (const match of source.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
        const value = match[1] ?? match[0];
        if (label === 'non-placeholder credential assignment' && placeholder.test(value)) continue;
        const line = source.slice(0, match.index).split('\n').length;
        findings.push(`${relative(root, path)}:${line}: ${label}`);
      }
    }
  }
}

await walk(root);
if (findings.length) {
  console.error(`Security scan found ${findings.length} item(s):`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log('Security scan passed. No credentials, private network URLs, personal account paths, or non-example email addresses were found.');
}
