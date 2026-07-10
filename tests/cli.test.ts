import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.ts');
const fixture = join(root, 'tests', 'fixtures', 'canon');
const OWNERSHIP_TAG = '[ai-canon:owned]';

const runCli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: root,
    encoding: 'utf8',
  });

const tmp = (prefix = 'ai-canon-') => mkdtempSync(join(tmpdir(), prefix));

// Write an ad-hoc canon tree so a single test can craft malformed or malicious
// inputs without disturbing the shared fixture.
const writeCanon = (files: Record<string, string>): string => {
  const dir = tmp('ai-canon-src-');
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
};

const canonJson = (namespace = 'acme') => JSON.stringify({ name: namespace, namespace });
const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, skills: [], rules: [], mcp: [], scripts: [], ...over });
const skillFile = (name: string) => `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name}\n\nBody.\n`;

const gitConfig = join(tmp('ai-canon-gitconfig-'), 'config');
writeFileSync(gitConfig, '');
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_SYSTEM: gitConfig,
};
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
const hasGit = spawnSync('git', ['--version']).status === 0;

const gitCanon = (files: Record<string, string>): string => {
  const dir = writeCanon(files);
  git(dir, 'init', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--no-gpg-sign', '-m', 'init');
  return dir;
};
const fileUrl = (path: string) => pathToFileURL(path).href;

test('sync refuses to overwrite hand-authored root config', () => {
  const consumer = mkdtempSync(join(tmpdir(), 'ai-canon-'));
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  writeFileSync(join(consumer, '.mcp.json'), '{"handAuthored":true}\n');

  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite non-generated file/);
  assert.equal(readFileSync(join(consumer, '.mcp.json'), 'utf8'), '{"handAuthored":true}\n');
});

test('non-interactive flags update only the selected agent and preserve hand-authored skills', () => {
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
  assert.equal(existsSync(join(consumer, '.agents', 'skills', 'acme-old')), true);
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

test('init quotes YAML-significant canon values instead of injecting config keys', () => {
  const consumer = tmp();
  const canon = 'path:with:colons\nrepo: injected';
  const result = runCli('init', '--root', consumer, '--canon', canon, '--repo', 'app', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  const config = readFileSync(join(consumer, '.ai.yaml'), 'utf8');
  assert.match(config, /repo: app/);
  const followUp = runCli('init', '--root', consumer, '--canon', canon, '--repo', 'app', '--no-interactive');
  assert.equal(followUp.status, 0, followUp.stderr);
  assert.match(followUp.stdout, /already initialized/);
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

// --- Path safety ---------------------------------------------------------

for (const bad of ['../../secret.md', '/etc/passwd', 'common\\evil.md', 'sub/../../out.md']) {
  test(`manifest path escape is rejected: ${bad}`, () => {
    const canon = writeCanon({
      'canon.json': canonJson(),
      'manifests/app.json': manifest({ skills: [bad] }),
    });
    const consumer = tmp();
    writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
    const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Unsafe|not allowed|escapes/);
  });
}

test('a symlinked destination that escapes the root is rejected', { skip: process.platform === 'win32' }, () => {
  const consumer = tmp();
  const outside = tmp('ai-canon-outside-');
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  // .claude -> outside the consumer root; any write beneath it must be refused.
  symlinkSync(outside, join(consumer, '.claude'));
  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /escapes|symlink|Unsafe/);
});

test('a canon source symlink that escapes its content root is rejected', { skip: process.platform === 'win32' }, () => {
  const canon = writeCanon({
    'canon.json': canonJson(),
    'manifests/app.json': manifest({ scripts: ['tool/link.sh'] }),
  });
  const outside = join(tmp('ai-canon-outside-'), 'outside.sh');
  writeFileSync(outside, '#!/bin/sh\necho outside\n');
  mkdirSync(join(canon, 'canon', 'scripts', 'tool'), { recursive: true });
  symlinkSync(outside, join(canon, 'canon', 'scripts', 'tool', 'link.sh'));
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside|symlink|matched no files/);
});

test('stale cleanup refuses a symlinked scripts root outside the consumer', { skip: process.platform === 'win32' }, () => {
  const canon = writeCanon({ 'canon.json': canonJson(), 'manifests/app.json': manifest() });
  const consumer = tmp();
  const outside = tmp('ai-canon-outside-');
  writeFileSync(join(outside, 'owned.sh'), `# stale ${OWNERSHIP_TAG}\n`);
  mkdirSync(join(consumer, '.ai'), { recursive: true });
  symlinkSync(outside, join(consumer, '.ai', 'scripts'));
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cleanup root|outside|symlink/);
  assert.equal(existsSync(join(outside, 'owned.sh')), true);
});

// --- Ownership / guard ---------------------------------------------------

test('ownership is keyed on the exact tag, not the notice text', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');

  let result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive', '--generated-notice', 'First notice');
  assert.equal(result.status, 0, result.stderr);
  const first = readFileSync(join(consumer, '.mcp.json'), 'utf8');
  assert.ok(first.includes(OWNERSHIP_TAG), 'generated file must carry the ownership tag');

  // A completely different notice must still be recognized as owned and updated
  // in place — never refused — because detection ignores the notice text.
  result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive', '--generated-notice', 'Totally different notice');
  assert.equal(result.status, 0, result.stderr);
  const second = readFileSync(join(consumer, '.mcp.json'), 'utf8');
  assert.ok(second.includes('Totally different notice'));
  assert.ok(second.includes(OWNERSHIP_TAG));
});

test('an empty generated notice is rejected', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive', '--generated-notice', '   ');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-empty/);
});

test('a hand-authored file quoting the notice text is not treated as generated', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  // Contains the human notice but not the structured tag: must be refused.
  writeFileSync(join(consumer, '.mcp.json'), '{"note":"GENERATED FILE. Do not edit directly. Run: ai-canon sync"}\n');
  const before = readFileSync(join(consumer, '.mcp.json'), 'utf8');
  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite/);
  assert.equal(readFileSync(join(consumer, '.mcp.json'), 'utf8'), before);
});

test('legacy 0.1 generated markers migrate without --force', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  writeFileSync(
    join(consumer, '.mcp.json'),
    '{"_generated":"GENERATED FILE. Do not edit directly. Run: ai-canon sync","mcpServers":{}}\n'
  );
  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(consumer, '.mcp.json'), 'utf8'), /\[ai-canon:owned\]/);
});

test('a hand-authored file merely quoting the ownership tag is not treated as generated', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  writeFileSync(join(consumer, '.mcp.json'), '{"note":"The marker [ai-canon:owned] is documented here"}\n');
  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite/);
});

test('a hand-authored skill with the canonical name is not overwritten', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  const skill = join(consumer, '.claude', 'skills', 'acme-test', 'SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, 'hand-authored skill\n');
  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite/);
  assert.equal(readFileSync(skill, 'utf8'), 'hand-authored skill\n');
  assert.equal(existsSync(join(consumer, '.ai.lock.json')), false);
});

test('stale generated skill is removed while a same-prefix hand-authored skill survives', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  const skills = join(consumer, '.claude', 'skills');
  mkdirSync(join(skills, 'acme-gone'), { recursive: true });
  mkdirSync(join(skills, 'acme-mine'), { recursive: true });
  writeFileSync(join(skills, 'acme-gone', 'SKILL.md'), `# stale ${OWNERSHIP_TAG}\n`);
  writeFileSync(join(skills, 'acme-mine', 'SKILL.md'), 'hand authored, no tag\n');

  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(skills, 'acme-gone')), false);
  assert.equal(existsSync(join(skills, 'acme-mine', 'SKILL.md')), true);
  assert.equal(existsSync(join(skills, 'acme-test', 'SKILL.md')), true);
});

test('structured ownership cleanup follows a canon namespace rename', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const skills = join(consumer, '.claude', 'skills');
  mkdirSync(join(skills, 'oldcanon-generated'), { recursive: true });
  writeFileSync(join(skills, 'oldcanon-generated', 'SKILL.md'), `<!-- notice ${OWNERSHIP_TAG} -->\n`);
  const canon = writeCanon({ 'canon.json': canonJson('newcanon'), 'manifests/app.json': manifest() });
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(skills, 'oldcanon-generated')), false);
});

test('guard refusal leaves scripts, skills and lock untouched', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: frontend\n');
  writeFileSync(join(consumer, '.mcp.json'), '{"handAuthored":true}\n');

  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No changes were made/);
  assert.equal(existsSync(join(consumer, '.ai', 'scripts')), false);
  assert.equal(existsSync(join(consumer, '.claude')), false);
  assert.equal(existsSync(join(consumer, '.ai.lock.json')), false);
  assert.equal(readFileSync(join(consumer, '.mcp.json'), 'utf8'), '{"handAuthored":true}\n');
});

test('a late write failure rolls back every earlier planned change', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  let result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  const skill = join(consumer, '.claude', 'skills', 'acme-test', 'SKILL.md');
  const beforeSkill = readFileSync(skill, 'utf8');
  const beforeMcp = readFileSync(join(consumer, '.mcp.json'), 'utf8');
  const beforeLock = readFileSync(join(consumer, '.ai.lock.json'), 'utf8');
  writeFileSync(join(consumer, '.codex'), 'blocking file\n');
  result = runCli(
    'sync', '--root', consumer, '--source', fixture, '--agent', 'claude,codex', '--no-interactive', '--generated-notice', 'Changed notice'
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rolled back/);
  assert.equal(readFileSync(join(consumer, '.codex'), 'utf8'), 'blocking file\n');
  assert.equal(readFileSync(skill, 'utf8'), beforeSkill);
  assert.equal(readFileSync(join(consumer, '.mcp.json'), 'utf8'), beforeMcp);
  assert.equal(readFileSync(join(consumer, '.ai.lock.json'), 'utf8'), beforeLock);
  assert.equal(existsSync(join(consumer, '.agents')), false);
});

// --- Renderers -----------------------------------------------------------

test('all four agent renderers emit native, owned config', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude,codex,cursor,opencode', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);

  const mcp = readFileSync(join(consumer, '.mcp.json'), 'utf8');
  assert.ok(JSON.parse(mcp).mcpServers.echo, '.mcp.json must contain the echo server');
  assert.ok(mcp.includes(OWNERSHIP_TAG));

  const toml = readFileSync(join(consumer, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\."echo"\]/);
  assert.ok(toml.includes(OWNERSHIP_TAG));

  const opencode = JSON.parse(readFileSync(join(consumer, 'opencode.json'), 'utf8'));
  assert.equal(opencode.mcp.echo.type, 'local');

  assert.equal(existsSync(join(consumer, '.cursor', 'mcp.json')), true);
  assert.equal(existsSync(join(consumer, '.cursor', 'rules', 'acme-rules.mdc')), true);
});

test('secret root config is written with 0600 on POSIX', { skip: process.platform === 'win32' }, () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(join(consumer, '.mcp.json')).mode & 0o777, 0o600);
});

test('sync corrects an overly permissive generated secret config mode', { skip: process.platform === 'win32' }, () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  let result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  chmodSync(join(consumer, '.mcp.json'), 0o644);
  result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(join(consumer, '.mcp.json')).mode & 0o777, 0o600);
});

test('sync refuses to place resolved config into a Git-tracked generated file', { skip: !hasGit }, () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  writeFileSync(join(consumer, '.mcp.json'), `{"_generated":"notice ${OWNERSHIP_TAG}","mcpServers":{}}\n`);
  assert.equal(git(consumer, 'init', '-b', 'main').status, 0);
  assert.equal(git(consumer, 'add', '.mcp.json').status, 0);
  assert.equal(git(consumer, 'commit', '-m', 'track generated config').status, 0);
  const before = readFileSync(join(consumer, '.mcp.json'), 'utf8');
  const result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tracked by Git/);
  assert.equal(readFileSync(join(consumer, '.mcp.json'), 'utf8'), before);
});

test('script executable bit is preserved on POSIX', { skip: process.platform === 'win32' }, () => {
  const canon = writeCanon({
    'canon.json': canonJson(),
    'manifests/app.json': manifest({ scripts: ['tool/*'] }),
    'canon/scripts/tool/run.sh': '#!/usr/bin/env bash\necho hi\n',
  });
  chmodSync(join(canon, 'canon', 'scripts', 'tool', 'run.sh'), 0o755);
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  const mode = statSync(join(consumer, '.ai', 'scripts', 'tool', 'run.sh')).mode & 0o777;
  assert.ok((mode & 0o111) !== 0, `expected executable bit, got ${mode.toString(8)}`);
});

// --- doctor --check ------------------------------------------------------

test('doctor --check flags stale skill and missing lock, exits 1, mutates nothing', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  const skills = join(consumer, '.claude', 'skills');
  mkdirSync(join(skills, 'acme-stale'), { recursive: true });
  writeFileSync(join(skills, 'acme-stale', 'SKILL.md'), `# stale ${OWNERSHIP_TAG}\n`);

  const result = runCli('doctor', '--check', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1, result.stdout);
  // No mutation: stale still present, lock still absent, target skill not created.
  assert.equal(existsSync(join(skills, 'acme-stale')), true);
  assert.equal(existsSync(join(consumer, '.ai.lock.json')), false);
  assert.equal(existsSync(join(skills, 'acme-test')), false);
});

test('doctor --check exits 0 when everything is in sync', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: backend\n');
  let result = runCli('sync', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  result = runCli('doctor', '--check', '--root', consumer, '--source', fixture, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stdout);
});

test('stale generated scripts are reported by check and removed by sync', () => {
  const canon = writeCanon({
    'canon.json': canonJson(),
    'manifests/app.json': manifest({ scripts: ['tool/*'] }),
    'canon/scripts/tool/run.sh': '#!/bin/sh\necho old\n',
  });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  let result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  const script = join(consumer, '.ai', 'scripts', 'tool', 'run.sh');
  assert.equal(existsSync(script), true);

  writeFileSync(join(canon, 'manifests', 'app.json'), manifest());
  result = runCli('doctor', '--check', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1, result.stdout);
  assert.equal(existsSync(script), true);
  result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(script), false);
});

// --- Malformed inputs ----------------------------------------------------

test('malformed manifest JSON is rejected with a clear error', () => {
  const canon = writeCanon({ 'canon.json': canonJson(), 'manifests/app.json': '{ not valid json' });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid JSON/);
});

test('manifest with version other than 1 is rejected', () => {
  const canon = writeCanon({ 'canon.json': canonJson(), 'manifests/app.json': manifest({ version: 2 }) });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"version" must be 1/);
});

test('unknown manifest fields are rejected before stale cleanup', () => {
  const canon = writeCanon({
    'canon.json': canonJson(),
    'manifests/app.json': JSON.stringify({ version: 1, skill: ['acme-test.md'], rules: [], mcp: [], scripts: [] }),
  });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const stale = join(consumer, '.claude', 'skills', 'acme-old', 'SKILL.md');
  mkdirSync(dirname(stale), { recursive: true });
  writeFileSync(stale, `# stale ${OWNERSHIP_TAG}\n`);
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown manifest field.*skill/);
  assert.equal(existsSync(stale), true);
});

test('manifest with an unknown defaultAgents entry is rejected', () => {
  const canon = writeCanon({ 'canon.json': canonJson(), 'manifests/app.json': manifest({ defaultAgents: ['claude', 'bogus'] }) });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const result = runCli('sync', '--root', consumer, '--source', canon, '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown agent in defaultAgents/);
});

test('invalid MCP server shape is rejected', () => {
  const canon = writeCanon({
    'canon.json': canonJson(),
    'manifests/app.json': manifest({ mcp: ['bad.json'] }),
    'canon/mcp/bad.json': JSON.stringify({ mcpServers: { broken: { command: 123 } } }),
  });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /broken\.command.*must be a non-empty string/);
});

test('duplicate MCP names across canon catalogs are rejected', () => {
  const server = { mcpServers: { duplicate: { command: 'node' } } };
  const canon = writeCanon({
    'canon.json': canonJson(),
    'manifests/app.json': manifest({ mcp: ['one.json', 'two.json'] }),
    'canon/mcp/one.json': JSON.stringify(server),
    'canon/mcp/two.json': JSON.stringify(server),
  });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate MCP server name/);
});

test('manifest repo metadata must match its filename', () => {
  const canon = writeCanon({ 'canon.json': canonJson(), 'manifests/app.json': manifest({ repo: 'other' }) });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repo.*must match its filename/);
});

test('comments in .ai.yaml are ignored', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), '# adopt the acme canon\nrepo: backend  # manifest name\n');
  const result = runCli('list', 'skills', '--root', consumer, '--source', fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /acme-test/);
});

test('lock provenance uses the resolved local source rather than a canon-controlled label', () => {
  const canon = writeCanon({
    'canon.json': JSON.stringify({ name: 'Acme Canon', namespace: 'acme', sourceLabel: 'https://example.invalid/claimed.git' }),
    'manifests/app.json': manifest(),
  });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'repo: app\n');
  const result = runCli('sync', '--root', consumer, '--source', canon, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  const lock = JSON.parse(readFileSync(join(consumer, '.ai.lock.json'), 'utf8'));
  assert.equal(lock.source, `local:${realpathSync(canon)}`);
  assert.doesNotMatch(lock.source, /example\.invalid/);
});

// --- init idempotency ----------------------------------------------------

test('init on an existing repo retains config, and refuses a conflicting canon', () => {
  const consumer = tmp();
  let result = runCli('init', '--root', consumer, '--canon', '../a-canon', '--repo', 'app', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);

  // Same config: idempotent success.
  result = runCli('init', '--root', consumer, '--canon', '../a-canon', '--repo', 'app', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already initialized/);

  // Different canon: refuse without clobbering.
  result = runCli('init', '--root', consumer, '--canon', '../different-canon', '--repo', 'app', '--no-interactive');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /different configuration/);
  assert.match(readFileSync(join(consumer, '.ai.yaml'), 'utf8'), /a-canon/);
});

test('init repairs missing generated-state ignore entries on an existing config', () => {
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), 'canon: ../a-canon\nrepo: app\n');
  writeFileSync(join(consumer, '.gitignore'), '# ai-canon generated files\n.ai/\n');
  const result = runCli('init', '--root', consumer, '--canon', '../a-canon', '--repo', 'app', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  const ignore = readFileSync(join(consumer, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.mcp\.json$/m);
  assert.match(ignore, /^\.ai\.lock\.json$/m);
});

// --- git-backed canon fetch ---------------------------------------------

test('cached checkout is rebuilt when the canon origin changes', { skip: !hasGit }, () => {
  const canonA = gitCanon({
    'canon.json': canonJson(),
    'manifests/app.json': manifest({ skills: ['common/*.md'] }),
    'canon/skills/common/acme-a.md': skillFile('acme-a'),
  });
  const canonB = gitCanon({
    'canon.json': canonJson(),
    'manifests/app.json': manifest({ skills: ['common/*.md'] }),
    'canon/skills/common/acme-b.md': skillFile('acme-b'),
  });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), `canon: ${fileUrl(canonA)}\nrepo: app\n`);

  let result = runCli('sync', '--root', consumer, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(consumer, '.claude', 'skills', 'acme-a', 'SKILL.md')), true);

  writeFileSync(join(consumer, '.ai.yaml'), `canon: ${fileUrl(canonB)}\nrepo: app\n`);
  result = runCli('sync', '--root', consumer, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(consumer, '.claude', 'skills', 'acme-b', 'SKILL.md')), true);
  // acme-a came from the old origin and is now stale: it must be reclaimed.
  assert.equal(existsSync(join(consumer, '.claude', 'skills', 'acme-a')), false);
});

test('an explicit branch ref advances after new canon commits', { skip: !hasGit }, () => {
  const canon = gitCanon({
    'canon.json': canonJson(),
    'manifests/app.json': manifest({ skills: ['common/*.md'] }),
    'canon/skills/common/acme-v1.md': skillFile('acme-v1'),
  });
  const consumer = tmp();
  writeFileSync(join(consumer, '.ai.yaml'), `canon: ${fileUrl(canon)}\nrepo: app\ncanonRef: main\n`);

  let result = runCli('sync', '--root', consumer, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(consumer, '.claude', 'skills', 'acme-v1', 'SKILL.md')), true);

  // Advance main; the next sync must pick the new commit up via origin/main.
  writeFileSync(join(canon, 'canon', 'skills', 'common', 'acme-v2.md'), skillFile('acme-v2'));
  git(canon, 'add', '-A');
  git(canon, 'commit', '--no-gpg-sign', '-m', 'add v2');

  result = runCli('sync', '--root', consumer, '--agent', 'claude', '--no-interactive');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(consumer, '.claude', 'skills', 'acme-v2', 'SKILL.md')), true);
});
