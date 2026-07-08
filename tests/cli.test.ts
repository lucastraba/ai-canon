import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.ts');
const fixture = join(root, 'tests', 'fixtures', 'canon');

const runCli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: root,
    encoding: 'utf8',
  });

test('sync refuses to overwrite hand-authored root config', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'ai-canon-'));
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  writeFileSync(join(consumer, '.mcp.json'), '{"handAuthored":true}\n');

  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite non-generated file/);
  assert.equal(readFileSync(join(consumer, '.mcp.json'), 'utf8'), '{"handAuthored":true}\n');
});

test('non-interactive flags update only the selected agent and preserve user skills', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'ai-canon-'));
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  mkdirSync(join(consumer, '.agents', 'skills', 'my-skill'), { recursive: true });
  mkdirSync(join(consumer, '.agents', 'skills', 'acme-old'), { recursive: true });
  writeFileSync(join(consumer, '.agents', 'skills', 'my-skill', 'SKILL.md'), 'mine\n');
  writeFileSync(join(consumer, '.agents', 'skills', 'acme-old', 'SKILL.md'), 'old\n');

  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'codex', '--no-interactive');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(consumer, '.claude')), false);
  assert.equal(existsSync(join(consumer, '.agents', 'skills', 'my-skill')), true);
  assert.equal(existsSync(join(consumer, '.agents', 'skills', 'acme-old')), false);
  assert.equal(existsSync(join(consumer, '.agents', 'skills', 'acme-test', 'SKILL.md')), true);
});

test('missing MCP env skips server without writing unresolved placeholders', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'ai-canon-'));
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: frontend\n');
  mkdirSync(join(consumer, '.ai.local'), { recursive: true });
  writeFileSync(
    join(consumer, '.ai.local', 'mcp.json'),
    '{"mcpServers":{"missing-env-test":{"command":"x","env":{"TOKEN":"${DEFINITELY_MISSING_AI_CANON_TEST_TOKEN}"}}}}\n'
  );

  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /missing-env-test/);
  assert.doesNotMatch(readFileSync(join(consumer, '.mcp.json'), 'utf8'), /\$\{/);
});

test('syncs scripts and preserves cursor frontmatter in namespaced rules file', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'ai-canon-'));
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: frontend\n');

  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'cursor', '--no-interactive');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(consumer, '.ai', 'scripts', 'open-pr', 'preflight.sh')), true);
  const rules = readFileSync(join(consumer, '.cursor', 'rules', 'acme-rules.mdc'), 'utf8');
  assert.equal(rules.startsWith('---\n'), true);
  assert.equal(rules.indexOf('alwaysApply: true') < rules.indexOf('GENERATED FILE'), true);
});

test('basename globs in manifests are honored', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'ai-canon-'));
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: globtest\n');

  const result = runCli('list', 'skills', '--root', consumer, '--source', fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /acme-test/);
  assert.doesNotMatch(result.stdout, /acme-optin/);
});

test('opt-in skills are excluded by default and included with --include-opt-in', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'ai-canon-'));
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');

  let result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(consumer, '.claude', 'skills', 'acme-optin')), false);

  result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--include-opt-in', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(consumer, '.claude', 'skills', 'acme-optin', 'SKILL.md')), true);
});

test('init scaffolds a consumer .ai.yaml and gitignore block', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'ai-canon-'));

  const result = runCli('init', '--root', consumer, '--canon', '../my-canon', '--repo', 'app', '--no-interactive');

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(consumer, '.ai.yaml'), 'utf8'), /canon: \.\.\/my-canon/);
  assert.match(readFileSync(join(consumer, '.gitignore'), 'utf8'), /ai-canon generated files/);
});

test('init canon scaffolds a valid canon repo that sync can consume', () => {
  const canon = mkdtempSync(join(tmpdir(), 'ai-canon-src-'));
  const consumer = mkdtempSync(join(tmpdir(), 'ai-canon-'));

  let result = runCli('init', 'canon', '--root', canon, '--repo', 'acorp');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(canon, 'canon.json')), true);

  writeFileSync(join(consumer, '.ai.yaml'), 'repo: example\n');
  result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(consumer, '.claude', 'skills', 'acorp-hello', 'SKILL.md')), true);
});
