import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkLinks, extractAnchors, extractLinks, globToRegExp, slugify } from './check-docs-links.mjs';

const fixtureParent = path.join(path.dirname(fileURLToPath(import.meta.url)), '.check-docs-links-fixtures');
const tempRoots = [];

function makeRepo(files) {
  const root = (fs.mkdirSync(fixtureParent, { recursive: true }), fs.mkdtempSync(path.join(fixtureParent, 'repo-')));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function run(files, options = {}) {
  const root = makeRepo(files);
  const mdFiles = Object.keys(files).filter((f) => f.endsWith('.md'));
  return checkLinks({ root, files: mdFiles, ...options });
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtureParent, { recursive: true, force: true });
});

describe('slugify and anchors', () => {
  it('produces GitHub-style slugs', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
    assert.equal(slugify('🚀 Quick Start'), '-quick-start');
    assert.equal(slugify('API (v2.0) & `config`'), 'api-v20--config');
    assert.equal(slugify('snake_case-and-dash'), 'snake_case-and-dash');
    assert.equal(slugify('[Linked](x.md) heading'), 'linked-heading');
  });

  it('suffixes duplicate headings and collects explicit ids', () => {
    const anchors = extractAnchors('# Setup\n## Setup\n### Setup\n<a id="custom-id"></a>\n<a name="legacy"></a>\n```\n# not-a-heading\n```\n');
    assert.ok(anchors.has('setup') && anchors.has('setup-1') && anchors.has('setup-2'));
    assert.ok(anchors.has('custom-id') && anchors.has('legacy'));
    assert.ok(!anchors.has('not-a-heading'));
  });
});

describe('extractLinks', () => {
  it('finds inline, image, reference and HTML links but skips code', () => {
    const links = extractLinks(
      [
        '[a](a.md) ![img](<img dir/x.png> "title")',
        '`[code](inline.md)`',
        '```md',
        '[fenced](fenced.md)',
        '```',
        '[ref]: ref.md#part',
        '<img src="pic.png"> <a href="page.md">x</a>',
        '[![badge](badge.svg)](outer.md)',
      ].join('\n'),
    );
    const targets = links.map((l) => l.target).sort();
    assert.deepEqual(targets, ['a.md', 'badge.svg', 'img dir/x.png', 'outer.md', 'page.md', 'pic.png', 'ref.md#part']);
    assert.equal(links.find((l) => l.target === 'ref.md#part').line, 6);
  });
});

describe('checkLinks', () => {
  it('reports missing files and accepts existing files, dirs and source files', () => {
    const result = run({
      'README.md': '[ok](docs/guide.md)\n[dir](docs/)\n[src](src/app.ts#L10)\n[missing](docs/nope.md)\n[space](docs/my%20file.md)\n[notdir](docs/guide.md/)\n[web](https://example.com/x.md)\n[mail](mailto:a@b.c)\n',
      'docs/guide.md': '# Guide\n',
      'docs/my file.md': '# Spaced\n',
      'src/app.ts': 'export {};\n',
    });
    assert.deepEqual(
      result.problems.map((p) => [p.line, p.target, p.reason]),
      [
        [4, 'docs/nope.md', 'file not found'],
        [6, 'docs/guide.md/', 'not a directory'],
      ],
    );
  });

  it('validates anchors in same and other md files', () => {
    const result = run({
      'a.md': '# Intro\n## Setup\n## Setup\n## 🎉 Party Time!\n[s](#setup-1)\n[p](#-party-time)\n[bad](#missing)\n[other](b.md#details)\n[otherbad](b.md#nope)\n[id](b.md#explicit)\n[ref][r]\n\n[r]: b.md#gone\n',
      'b.md': '## Details\n<a id="explicit"></a>\n',
    });
    assert.deepEqual(
      result.problems.map((p) => `${p.line}:${p.reason}`),
      ['7:anchor #missing not found', '9:anchor #nope not found', '13:anchor #gone not found'],
    );
  });

  it('ignores links inside code blocks and inline code', () => {
    const result = run({ 'a.md': '`[x](missing.md)`\n\n~~~\n[y](missing.md)\n~~~\n    \n' });
    assert.equal(result.problems.length, 0);
  });

  it('skips excluded files but still validates links into them', () => {
    const files = {
      'docs/frozen.md': '# Frozen Heading\n[broken](nowhere.md)\n',
      'tests/scripts/README.md': '[broken](nowhere.md)\n',
      'index.md': '[f](docs/frozen.md#frozen-heading)\n[bad](docs/frozen.md#nope)\n',
    };
    const result = run(files, { exclude: ['docs/frozen.md', 'tests/scripts/**'] });
    assert.equal(result.scannedFiles, 1);
    assert.deepEqual(result.problems.map((p) => `${p.file}:${p.reason}`), ['index.md:anchor #nope not found']);
  });

  it('reports orphaned docs', () => {
    const result = run(
      {
        'README.md': '[a](docs/linked.md)\n[d](docs/sub/)\n',
        'docs/README.md': '# Index\n',
        'docs/linked.md': '[self](linked.md)\n',
        'docs/sub/README.md': '# Sub\n',
        'docs/orphan.md': '[x](linked.md)\n',
      },
      { orphans: true },
    );
    assert.deepEqual(result.orphans, ['docs/orphan.md']);
  });
});

describe('globToRegExp', () => {
  it('matches ** and * segments', () => {
    assert.ok(globToRegExp('tests/auth/**').test('tests/auth/a/b.md'));
    assert.ok(globToRegExp('docs/*.md').test('docs/a.md'));
    assert.ok(!globToRegExp('docs/*.md').test('docs/x/a.md'));
    assert.ok(globToRegExp('**/README.md').test('README.md'));
  });
});
