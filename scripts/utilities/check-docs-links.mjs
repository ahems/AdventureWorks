#!/usr/bin/env node
// Dependency-free Markdown link checker for the repository documentation.
// Usage: node scripts/utilities/check-docs-links.mjs [--orphans] [--strict] [--json] [--exclude <glob>]...

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Frozen files: not scanned for outgoing links, but still valid link targets.
// Paths temporarily owned by other in-flight work; add globs here to skip scanning them.
export const FROZEN_EXCLUDES = Object.freeze([]);

export const SKIPPED_DIRECTORIES = Object.freeze(['node_modules', 'review-output', 'bin', 'obj', 'dist']);

export const EXTRA_FILES = Object.freeze(['llms.txt']);

export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function isExcluded(file, globs) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

export function isSkippedPath(file) {
  return file.split('/').some((segment) => SKIPPED_DIRECTORIES.includes(segment));
}

// Returns an array of booleans: true when the line is inside (or delimits) a fenced code block.
export function fencedLineMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      mask[i] = true;
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && /^\s*$/.test(lines[i].slice(match[0].length))) {
        fence = null;
      }
    } else if (match && !(match[1][0] === '`' && lines[i].slice(match[0].length).includes('`'))) {
      fence = match[1];
      mask[i] = true;
    }
  }
  return mask;
}

function blankOut(text) {
  return text.replace(/[^\n]/g, ' ');
}

// Replaces inline code spans and HTML comments with spaces so offsets are preserved.
export function stripInlineCode(text) {
  let result = text.replace(/<!--[\s\S]*?-->/g, blankOut);
  result = result.replace(/(`+)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/g, blankOut);
  return result;
}

function headingText(raw) {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '');
}

export function slugify(text) {
  return headingText(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

export function extractAnchors(content) {
  const anchors = new Set();
  const counts = new Map();
  const addSlug = (text) => {
    const base = slugify(text);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  };
  const lines = content.split(/\r?\n/);
  const fenced = fencedLineMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const line = lines[i];
    const atx = /^ {0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(line);
    if (atx) {
      addSlug(atx[1] ?? '');
    } else if (
      i + 1 < lines.length &&
      !fenced[i + 1] &&
      line.trim() !== '' &&
      /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1]) &&
      !/^ {0,3}([-*+]\s|>|\|)/.test(line) &&
      (i === 0 || lines[i - 1].trim() === '')
    ) {
      addSlug(line.trim());
    }
    for (const match of stripInlineCode(line).matchAll(/<[a-zA-Z][^>]*?\s(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)')/g)) {
      anchors.add(match[1] ?? match[2]);
    }
  }
  return anchors;
}

function lineAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function unwrapTarget(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1);
  return trimmed;
}

// Extracts { line, target } entries for inline links/images, reference definitions and HTML src/href.
export function extractLinks(content) {
  const lines = content.split(/\r?\n/);
  const fenced = fencedLineMask(lines);
  const visible = stripInlineCode(lines.map((line, i) => (fenced[i] ? blankOut(line) : line)).join('\n'));
  const lineStarts = [0];
  for (let i = 0; i < visible.length; i++) if (visible[i] === '\n') lineStarts.push(i + 1);

  const links = [];
  const inline = /\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (const match of visible.matchAll(inline)) {
    links.push({ line: lineAt(lineStarts, match.index), target: unwrapTarget(match[1]), kind: 'inline' });
  }
  const reference = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|\S+)/gm;
  for (const match of visible.matchAll(reference)) {
    if (match[1].startsWith('^')) continue;
    links.push({ line: lineAt(lineStarts, match.index), target: unwrapTarget(match[2]), kind: 'reference' });
  }
  const html = /<(?:a|img|source)\b[^>]*?\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of visible.matchAll(html)) {
    links.push({ line: lineAt(lineStarts, match.index), target: (match[1] ?? match[2]).trim(), kind: 'html' });
  }
  return links.sort((a, b) => a.line - b.line);
}

export function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function statOrNull(fullPath) {
  try {
    return fs.statSync(fullPath);
  } catch {
    return null;
  }
}

/**
 * Checks links in the given repo-relative Markdown files.
 * @param {{ root: string, files: string[], exclude?: string[], orphans?: boolean }} options
 */
export function checkLinks({ root, files, exclude = FROZEN_EXCLUDES, orphans = false }) {
  const rootDir = path.resolve(root);
  const normalized = files.map((f) => f.split(path.sep).join('/')).filter((f) => !isSkippedPath(f));
  const scanned = normalized.filter((f) => !isExcluded(f, exclude));
  const anchorCache = new Map();
  const anchorsFor = (rel) => {
    if (!anchorCache.has(rel)) {
      anchorCache.set(rel, extractAnchors(fs.readFileSync(path.join(rootDir, rel), 'utf8')));
    }
    return anchorCache.get(rel);
  };
  const problems = [];
  const inbound = new Map();

  for (const file of scanned) {
    const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
    for (const { line, target } of extractLinks(content)) {
      if (!target || isExternal(target)) continue;
      const report = (reason) => problems.push({ file, line, target, reason });
      const hashIndex = target.indexOf('#');
      const pathPart = (hashIndex >= 0 ? target.slice(0, hashIndex) : target).split('?')[0];
      const anchor = hashIndex >= 0 ? safeDecode(target.slice(hashIndex + 1)) : null;
      let targetRel;
      let isDirectory = false;

      if (pathPart === '') {
        targetRel = file;
      } else {
        const decoded = safeDecode(pathPart);
        const resolved = decoded.startsWith('/')
          ? path.join(rootDir, decoded)
          : path.resolve(rootDir, path.dirname(file), decoded);
        const relative = path.relative(rootDir, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          report('outside repository');
          continue;
        }
        const stat = statOrNull(resolved);
        if (!stat) {
          report('file not found');
          continue;
        }
        if (decoded.endsWith('/') && !stat.isDirectory()) {
          report('not a directory');
          continue;
        }
        isDirectory = stat.isDirectory();
        targetRel = relative.split(path.sep).join('/');
      }

      const inboundTarget = isDirectory ? (targetRel ? `${targetRel}/README.md` : 'README.md') : targetRel;
      if (inboundTarget !== file) {
        if (!inbound.has(inboundTarget)) inbound.set(inboundTarget, new Set());
        inbound.get(inboundTarget).add(file);
      }

      if (anchor && !isDirectory && /\.md$/i.test(targetRel)) {
        const anchors = anchorsFor(targetRel);
        const lower = anchor.toLowerCase();
        if (!anchors.has(anchor) && ![...anchors].some((a) => a.toLowerCase() === lower)) {
          report(`anchor #${anchor} not found`);
        }
      }
    }
  }

  const orphanList = orphans
    ? normalized
        .filter((f) => f.startsWith('docs/') && f.toLowerCase().endsWith('.md') && f !== 'docs/README.md')
        .filter((f) => !inbound.has(f))
        .sort()
    : [];

  return { scannedFiles: scanned.length, problems, orphans: orphanList };
}

export function listRepositoryFiles(root) {
  // Tracked plus untracked-but-not-ignored files, so new docs are checked before they are committed.
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.md'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = [...new Set(output.split('\0').filter(Boolean))].filter((f) => fs.existsSync(path.join(root, f)));
  for (const extra of EXTRA_FILES) {
    if (fs.existsSync(path.join(root, extra)) && !files.includes(extra)) files.push(extra);
  }
  return files;
}

export function parseArgs(argv) {
  const options = { exclude: [], orphans: false, strict: false, json: false, root: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--orphans') options.orphans = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--exclude' || arg === '--root') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--exclude') options.exclude.push(value);
      else options.root = value;
    } else if (arg.startsWith('--exclude=')) options.exclude.push(arg.slice('--exclude='.length));
    else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function formatReport(result, { orphans }) {
  const lines = result.problems.map((p) => `${p.file}:${p.line} -> ${p.target} (${p.reason})`);
  const brokenFiles = new Set(result.problems.map((p) => p.file)).size;
  lines.push(`${result.problems.length} broken link(s) in ${brokenFiles} file(s); scanned ${result.scannedFiles} file(s).`);
  if (orphans) {
    for (const orphan of result.orphans) lines.push(`${orphan} (orphan: no inbound links from scanned docs)`);
    lines.push(`${result.orphans.length} orphaned doc(s) under docs/.`);
  }
  return lines.join('\n');
}

const USAGE = `Usage: node scripts/utilities/check-docs-links.mjs [options]
  --exclude <glob>  Additional file glob to skip scanning (repeatable); frozen files are always skipped
  --orphans         Report docs/ Markdown files with no inbound links
  --strict          With --orphans, exit 1 when orphans are found
  --json            Emit machine-readable JSON
  --root <dir>      Repository root (default: resolved relative to this script)`;

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const root = path.resolve(options.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const exclude = [...FROZEN_EXCLUDES, ...options.exclude];
  const result = checkLinks({ root, files: listRepositoryFiles(root), exclude, orphans: options.orphans });
  if (options.json) {
    console.log(JSON.stringify({ ...result, orphans: options.orphans ? result.orphans : undefined }, null, 2));
  } else {
    console.log(formatReport(result, options));
  }
  const orphanFailure = options.orphans && options.strict && result.orphans.length > 0;
  return result.problems.length > 0 || orphanFailure ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
