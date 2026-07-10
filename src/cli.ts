#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cancel, confirm, intro, isCancel, multiselect, outro, select, text } from '@clack/prompts';
import chalk from 'chalk';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

type Agent = 'claude' | 'codex' | 'cursor' | 'opencode';
type Status = 'unchanged' | 'created' | 'updated' | 'would-create' | 'would-update' | 'would-refuse';

interface Args {
  command: 'sync' | 'doctor' | 'list' | 'init';
  listKind?: 'skills';
  initKind: 'consumer' | 'canon';
  root?: string;
  source?: string;
  canonUrl?: string;
  ref?: string;
  repo?: string;
  agents: Agent[];
  skills: string[];
  mcps: string[];
  includeOptIn: boolean;
  force: boolean;
  check: boolean;
  interactive: boolean;
  noInteractive: boolean;
  generatedNotice?: string;
}

interface CanonConfig {
  name: string;
  namespace: string;
  sourceLabel?: string;
  generatedNotice?: string;
}

interface ConsumerConfig {
  canon?: string;
  canonSource?: string;
  canonRef?: string;
  repo?: string;
  generatedNotice?: string;
}

interface Manifest {
  version: number;
  repo?: string;
  skills: string[];
  rules: string[];
  mcp: string[];
  scripts: string[];
  defaultAgents?: Agent[];
}

interface Skill {
  name: string;
  description: string;
  agents: Agent[];
  isDefault: boolean;
  requiresEnv: string[];
  frontmatterRaw: string;
  body: string;
}

interface McpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  agents?: Agent[];
  default?: boolean;
}

interface McpSource {
  mcpServers: Record<string, McpServer>;
}

interface Context {
  root: string;
  source: string;
  sourceLabel: string;
  refLabel: string;
  repo: string;
  canon: CanonConfig;
  prefix: string;
  manifest: Manifest;
  agents: Agent[];
  skills: string[];
  mcps: string[];
  includeOptInSkills: boolean;
  includeOptInMcps: boolean;
  force: boolean;
  generatedNotice: string;
}

interface PlannedWrite {
  file: string;
  content: string;
  status: Status;
  guarded: boolean;
  mode?: number;
}

interface PlannedRemoval {
  label: string;
  path: string;
  // If set, empty parent directories are pruned up to (but not including) this
  // base after the removal, so reclaiming a stale script leaves no empty shell.
  pruneUpTo?: string;
}

interface Plan {
  writes: PlannedWrite[];
  removals: PlannedRemoval[];
  skippedSkills: string[];
  skippedMcps: string[];
}

type Selection = Pick<Context, 'agents' | 'skills' | 'mcps' | 'includeOptInSkills' | 'includeOptInMcps' | 'force'>;
type ContextBase = Omit<Context, keyof Selection>;

const ALL_AGENTS: Agent[] = ['claude', 'codex', 'cursor', 'opencode'];
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const PLACEHOLDER_RE = /\$\{([A-Z0-9_]+)}/g;
const GENERATED_MARKER = 'GENERATED FILE. Do not edit directly';
// Exact, structured ownership tag embedded in every generated file. Overwrite
// protection and stale-cleanup key off this literal token only — never the
// user-customizable notice text, and never a loose substring of it. A blank or
// crafted notice therefore cannot disable protection, and a hand-authored file
// that merely quotes the human-readable notice is never mistaken for generated.
const OWNERSHIP_TAG = '[ai-canon:owned]';
const GEN_NOTICE_DEFAULT = `${GENERATED_MARKER}. Run: ai-canon sync`;
const GIT_URL_RE = /^(git@|ssh:\/\/|https?:\/\/|git:\/\/|file:\/\/)/;
const SECRET_MODE = 0o600;

const cliVersion = (): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const usage = `Usage:
  ai-canon sync [options]            Render canon content into this repo
  ai-canon doctor [--check]          Inspect setup (--check reports drift, exits 1 on changes)
  ai-canon list skills               List skills available to this repo
  ai-canon init [canon]              Scaffold a consumer repo (default) or a new canon repo

Options:
  --root <path>              Consumer repo root (default: git toplevel)
  --source <path>            Local canon checkout (skips clone/fetch)
  --canon <url|path>         Canon git URL or path (init; overrides .ai.yaml)
  --ref <git-ref>            Canon git ref to check out (default: remote default branch)
  --repo <name>              Manifest name (default: 'repo' in .ai.yaml, else directory name)
  --agent <a,b>              claude,codex,cursor,opencode
  --skill <name|all>         Install specific skill(s) or all
  --mcp <name|all|none>      Install specific MCP(s), all, or none
  --include-opt-in           Include opt-in skills/MCPs
  --check                    Report drift without writing
  --force                    Allow replacing non-generated files at managed destinations
  --interactive              Force the TTY selector UI
  --no-interactive           Disable the TTY selector UI
  --generated-notice <text>  Override the generated-file notice

Environment:
  AI_CANON_SOURCE            Local canon path (same as --source)
  AI_CANON_REF               Canon git ref (same as --ref)
`;

const parseList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const isAgent = (value: string): value is Agent => (ALL_AGENTS as string[]).includes(value);

const parseArgs = (): Args => {
  const raw = process.argv.slice(2);
  const command = raw.shift();
  if (!command || command === '--help' || command === '-h') {
    console.log(usage);
    process.exit(0);
  }
  if (command === '--version' || command === '-v') {
    console.log(cliVersion());
    process.exit(0);
  }
  if (!['sync', 'doctor', 'list', 'init'].includes(command)) {
    throw new Error(`Unknown command: ${command}\n\n${usage}`);
  }
  const args: Args = {
    command: command as Args['command'],
    initKind: 'consumer',
    agents: [],
    skills: [],
    mcps: [],
    includeOptIn: false,
    force: false,
    check: false,
    interactive: false,
    noInteractive: false,
  };
  if (args.command === 'list') {
    const kind = raw.shift();
    if (kind !== 'skills') throw new Error(`Usage: ai-canon list skills [options]`);
    args.listKind = kind;
  }
  if (args.command === 'init' && raw[0] === 'canon') {
    args.initKind = 'canon';
    raw.shift();
  }
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index]!;
    if (arg === '--') continue;
    const next = (): string => {
      const value = raw[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') {
      console.log(usage);
      process.exit(0);
    } else if (arg === '--root') args.root = next();
    else if (arg === '--source') args.source = next();
    else if (arg === '--canon') args.canonUrl = next();
    else if (arg === '--ref') args.ref = next();
    else if (arg === '--repo') args.repo = next();
    else if (arg === '--agent') {
      for (const agent of parseList(next())) {
        if (!isAgent(agent)) throw new Error(`Unknown agent: ${agent}`);
        args.agents.push(agent);
      }
    } else if (arg === '--skill') args.skills.push(...parseList(next()));
    else if (arg === '--mcp') args.mcps.push(...parseList(next()));
    else if (arg === '--include-opt-in') args.includeOptIn = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--interactive') args.interactive = true;
    else if (arg === '--no-interactive' || arg === '--non-interactive') args.noInteractive = true;
    else if (arg === '--generated-notice') args.generatedNotice = next();
    else throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
  }
  args.agents = [...new Set(args.agents)];
  args.skills = [...new Set(args.skills)];
  args.mcps = [...new Set(args.mcps)];
  return args;
};

// --- Credential redaction ------------------------------------------------

const redactUrl = (value: string): string =>
  value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, '$1***@')
    .replace(/([?&](?:access_token|api_key|apikey|key|password|secret|token)=)[^&#\s]+/gi, '$1***');

// --- Path safety ---------------------------------------------------------

const isUnsafeRelative = (path: string): boolean =>
  path === '' ||
  path.startsWith('/') ||
  path.startsWith('\\') ||
  /^[A-Za-z]:[\\/]?/.test(path) ||
  path.includes('\\') ||
  path.split('/').some((segment) => segment === '..');

const assertSafeRelative = (path: string, label: string): void => {
  if (isUnsafeRelative(path)) {
    throw new Error(
      `Unsafe ${label} path ${JSON.stringify(path)}: absolute paths, "..", and backslashes are not allowed.`
    );
  }
};

const withinLexical = (base: string, target: string): boolean => {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const nearestExisting = (path: string): string => {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
};

// Reject anything that escapes `base` either lexically or after resolving
// symlinks (source symlinks pointing out, or a symlinked destination ancestor).
const assertWithin = (base: string, target: string, label: string): void => {
  if (!withinLexical(base, target)) {
    throw new Error(`Unsafe ${label}: ${target} escapes ${base}.`);
  }
  const realBase = realpathSync(nearestExisting(base));
  const real = realpathSync(nearestExisting(target));
  if (real !== realBase && !real.startsWith(realBase + sep)) {
    throw new Error(`Unsafe ${label}: ${target} resolves outside ${base} via a symlink.`);
  }
};

const assertSafeName = (name: string, label: string): void => {
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..') || /^[A-Za-z]:/.test(name) || name === '.') {
    throw new Error(`Unsafe ${label} ${JSON.stringify(name)}: must be a single path segment without separators or "..".`);
  }
};

// --- Consumer config -----------------------------------------------------

const asString = (value: unknown, path: string, key: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${path}: "${key}" must be a string.`);
  return value;
};

const loadConsumerConfig = (root: string): ConsumerConfig => {
  const path = join(root, '.ai.yaml');
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path}: expected a YAML mapping.`);
  const record = parsed as Record<string, unknown>;
  return {
    canon: asString(record.canon, path, 'canon'),
    canonSource: asString(record.canonSource, path, 'canonSource'),
    canonRef: asString(record.canonRef, path, 'canonRef'),
    repo: asString(record.repo, path, 'repo'),
    generatedNotice: asString(record.generatedNotice, path, 'generatedNotice'),
  };
};

const repoRoot = (): string => {
  try {
    const result = run('git', ['rev-parse', '--show-toplevel'], process.cwd(), true).trim();
    return result || process.cwd();
  } catch {
    return process.cwd();
  }
};

const run = (cmd: string, args: string[], cwd: string, quiet = false): string => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.error) throw new Error(redactUrl(`${cmd} ${args.join(' ')} failed: ${result.error.message}`));
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(redactUrl(`${cmd} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`));
  }
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  return result.stdout ?? '';
};

const tryGit = (args: string[], cwd: string): string | null => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 || result.error) return null;
  return (result.stdout ?? '').trim();
};

const detectRepo = (root: string, config: ConsumerConfig, explicit?: string): string => {
  const repo = explicit ?? config.repo ?? basename(root);
  assertSafeName(repo, 'repo name');
  return repo;
};

const isCanonDir = (path: string): boolean => existsSync(join(path, 'canon.json'));

const validateNotice = (notice: string): string => {
  const trimmed = notice.trim();
  if (trimmed === '') throw new Error('generatedNotice must be a non-empty string.');
  if (notice.includes('\n') || notice.includes('\r')) throw new Error('generatedNotice must be a single line.');
  return notice;
};

const loadCanonConfig = (source: string): CanonConfig => {
  const path = join(source, 'canon.json');
  if (!existsSync(path)) {
    throw new Error(`${source} is not a canon repo (no canon.json). Create one with: ai-canon init canon`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path}: expected a JSON object.`);
  const record = parsed as Record<string, unknown>;
  const name = asString(record.name, path, 'name');
  if (!name) throw new Error(`${path}: missing "name".`);
  if (/[\r\n\0]/.test(name)) throw new Error(`${path}: "name" must not contain control characters.`);
  const namespace = asString(record.namespace, path, 'namespace') ?? name;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(namespace)) {
    throw new Error(`${path}: "namespace" must be lowercase alphanumeric/dashes (got: ${namespace}).`);
  }
  const generatedNotice = asString(record.generatedNotice, path, 'generatedNotice');
  if (generatedNotice !== undefined) validateNotice(generatedNotice);
  return { name, namespace, sourceLabel: asString(record.sourceLabel, path, 'sourceLabel'), generatedNotice };
};

// --- Canon fetch ---------------------------------------------------------

const resolveGitRef = (checkout: string, ref: string): string => {
  for (const candidate of [`origin/${ref}`, `refs/tags/${ref}`, ref]) {
    const sha = tryGit(['-C', checkout, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], checkout);
    if (sha) return sha;
  }
  throw new Error(`Canon ref not found after fetch: ${ref}.`);
};

const fetchCanon = (root: string, url: string, ref: string | undefined): string => {
  const checkout = join(root, '.ai', '.canon');
  assertWithin(root, checkout, 'canon cache');
  if (existsSync(join(checkout, '.git'))) {
    const origin = tryGit(['-C', checkout, 'remote', 'get-url', 'origin'], checkout);
    if (!origin || redactUrl(origin) !== redactUrl(url)) {
      // Cached checkout points at a different canon; discard it entirely.
      rmSync(checkout, { recursive: true, force: true });
    }
  }
  if (!existsSync(join(checkout, '.git'))) {
    mkdirSync(dirname(checkout), { recursive: true });
    run('git', ['clone', '--quiet', url, checkout], root, true);
  }
  run('git', ['-C', checkout, 'fetch', '--prune', '--tags', '--quiet', 'origin'], root, true);
  let target: string;
  if (ref) {
    target = resolveGitRef(checkout, ref);
  } else {
    run('git', ['-C', checkout, 'remote', 'set-head', 'origin', '--auto'], root, true);
    target = resolveGitRef(checkout, 'HEAD');
  }
  // Scrub untracked content BEFORE checkout so a dirty cache can never block it,
  // force the checkout past any tracked local edits, then pin exactly to target
  // and clean once more so nothing off-canon can leak into the render.
  run('git', ['-C', checkout, 'clean', '-fdx', '--quiet'], root, true);
  run('git', ['-C', checkout, 'checkout', '--quiet', '--force', '--detach', target], root, true);
  run('git', ['-C', checkout, 'reset', '--hard', '--quiet', target], root, true);
  run('git', ['-C', checkout, 'clean', '-fdx', '--quiet'], root, true);
  return checkout;
};

const resolveSource = (args: Args, root: string, config: ConsumerConfig): string => {
  const local = args.source ?? process.env.AI_CANON_SOURCE;
  if (local) {
    const path = resolve(local);
    if (!isCanonDir(path)) throw new Error(`--source/AI_CANON_SOURCE is not a canon repo (no canon.json): ${path}`);
    return path;
  }
  const canon = args.canonUrl ?? config.canon;
  if (canon) {
    if (GIT_URL_RE.test(canon)) {
      const ref = args.ref ?? process.env.AI_CANON_REF ?? config.canonRef;
      return fetchCanon(root, canon, ref);
    }
    const path = resolve(root, canon);
    if (!isCanonDir(path)) throw new Error(`canon path in .ai.yaml is not a canon repo (no canon.json): ${path}`);
    return path;
  }
  if (isCanonDir(root)) return root;
  throw new Error(
    `No canon configured. Add 'canon: <git-url-or-path>' to ${join(root, '.ai.yaml')} (run: ai-canon init), or pass --source <path>.`
  );
};

const refLabelFor = (args: Args, config: ConsumerConfig): string => {
  if (args.source ?? process.env.AI_CANON_SOURCE) return 'local';
  const canon = args.canonUrl ?? config.canon;
  if (canon && GIT_URL_RE.test(canon)) return args.ref ?? process.env.AI_CANON_REF ?? config.canonRef ?? 'default';
  return 'local';
};

// --- Pattern expansion ---------------------------------------------------

const globToRe = (glob: string): RegExp =>
  new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

const allFiles = (base: string): string[] => {
  if (!existsSync(base)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const path = join(base, entry.name);
    if (entry.isDirectory()) result.push(...allFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
};

const expandPatterns = (base: string, patterns: string[], label: string): string[] => {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    assertSafeRelative(pattern, label);
    const candidates = pattern.includes('*')
      ? allFiles(join(base, dirname(pattern))).filter((file) => globToRe(basename(pattern)).test(basename(file)))
      : [join(base, pattern)];
    let matched = false;
    for (const file of candidates.toSorted()) {
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      assertWithin(base, file, `${label} source`);
      matched = true;
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
    if (!matched) throw new Error(`Manifest ${label} entry ${JSON.stringify(pattern)} matched no files under ${base}.`);
  }
  return files;
};

// --- Manifest ------------------------------------------------------------

const stringArray = (value: unknown, path: string, key: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${path}: "${key}" must be an array of strings.`);
  }
  return value as string[];
};

const loadManifest = (source: string, repo: string): Manifest => {
  const path = join(source, 'manifests', `${repo}.json`);
  if (!existsSync(path)) {
    const available = existsSync(join(source, 'manifests'))
      ? readdirSync(join(source, 'manifests'))
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.replace(/\.json$/, ''))
          .join(', ')
      : '(none)';
    throw new Error(
      `No manifest for repo '${repo}' at ${path}. Available manifests: ${available}. ` +
        `Create ${repo}.json in the canon's manifests/ directory (copy manifests/example.json).`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path}: expected a JSON object.`);
  const record = parsed as Record<string, unknown>;
  const allowedKeys = new Set(['version', 'repo', 'skills', 'rules', 'mcp', 'scripts', 'defaultAgents']);
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) throw new Error(`${path}: unknown manifest field(s): ${unknownKeys.join(', ')}.`);
  if (record.version !== 1) throw new Error(`${path}: "version" must be 1 (got: ${JSON.stringify(record.version)}).`);
  const manifestRepo = asString(record.repo, path, 'repo');
  if (manifestRepo !== undefined) {
    assertSafeName(manifestRepo, 'manifest repo name');
    if (manifestRepo !== repo) throw new Error(`${path}: "repo" must match its filename (${JSON.stringify(repo)}).`);
  }
  const defaultAgents = record.defaultAgents === undefined ? undefined : stringArray(record.defaultAgents, path, 'defaultAgents');
  if (defaultAgents) {
    if (defaultAgents.length === 0) throw new Error(`${path}: "defaultAgents" must not be empty when provided.`);
    for (const agent of defaultAgents) if (!isAgent(agent)) throw new Error(`${path}: unknown agent in defaultAgents: ${agent}.`);
  }
  return {
    version: 1,
    repo: manifestRepo,
    skills: stringArray(record.skills, path, 'skills'),
    rules: stringArray(record.rules, path, 'rules'),
    mcp: stringArray(record.mcp, path, 'mcp'),
    scripts: stringArray(record.scripts, path, 'scripts'),
    defaultAgents: defaultAgents as Agent[] | undefined,
  };
};

// --- Skills --------------------------------------------------------------

const parseSkillFile = (file: string, prefix: string): Skill => {
  const name = basename(file).replace(/\.md$/, '');
  const content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter.`);
  const frontmatterRaw = match[1]!;
  const body = match[2]!.replace(/^\n+/, '');
  let fm: Record<string, unknown>;
  try {
    fm = (parseYaml(frontmatterRaw) ?? {}) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${file}: invalid frontmatter YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (fm.name !== name) throw new Error(`${file}: frontmatter name must match filename.`);
  if (typeof fm.description !== 'string' || fm.description.trim() === '') throw new Error(`${file}: missing description.`);
  const agents = Array.isArray(fm.agents) ? fm.agents : ALL_AGENTS;
  for (const agent of agents) if (typeof agent !== 'string' || !isAgent(agent)) throw new Error(`${file}: unknown agent ${String(agent)}.`);
  if (fm.default !== undefined && typeof fm.default !== 'boolean') throw new Error(`${file}: "default" must be a boolean.`);
  if (Array.isArray(fm['requires-env']) && fm['requires-env'].some((item) => typeof item !== 'string')) {
    throw new Error(`${file}: "requires-env" must contain only strings.`);
  }
  const requiresEnv = Array.isArray(fm['requires-env'])
    ? (fm['requires-env'] as string[])
    : typeof fm['requires-env'] === 'string'
      ? parseList(fm['requires-env'])
      : [];
  if (!name.startsWith(prefix)) {
    throw new Error(`${file}: skill names must start with the canon namespace prefix '${prefix}' (stale-cleanup safety).`);
  }
  return {
    name,
    description: fm.description,
    agents: agents as Agent[],
    isDefault: fm.default !== false,
    requiresEnv,
    frontmatterRaw,
    body,
  };
};

const allSkills = (ctx: ContextBase): Skill[] =>
  expandPatterns(join(ctx.source, 'canon', 'skills'), ctx.manifest.skills, 'skills')
    .map((file) => parseSkillFile(file, ctx.prefix))
    .toSorted((a, b) => a.name.localeCompare(b.name));

const envMap = (root: string): Record<string, string> => {
  const result: Record<string, string> = { ...process.env } as Record<string, string>;
  const envPath = join(root, '.ai.local', 'env');
  if (!existsSync(envPath)) return result;
  assertWithin(root, envPath, 'local environment file');
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length);
    const [key, ...rest] = line.split('=');
    result[key!.trim()] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
};

const selectSkills = (ctx: Context): { skills: Skill[]; skipped: string[] } => {
  const skills = allSkills(ctx);
  const known = new Set(skills.map((skill) => skill.name));
  const selected = new Set(ctx.skills);
  const unknown = [...selected].filter((name) => name !== 'all' && !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown skill(s): ${unknown.join(', ')}`);
  const candidates = selected.has('all')
    ? skills
    : selected.size > 0
      ? skills.filter((skill) => selected.has(skill.name))
      : skills.filter((skill) => ctx.includeOptInSkills || skill.isDefault);
  const env = envMap(ctx.root);
  const skipped: string[] = [];
  const result: Skill[] = [];
  for (const skill of candidates) {
    const missing = skill.requiresEnv.filter((name) => !env[name]);
    if (missing.length > 0) skipped.push(`${skill.name} (missing: ${missing.join(', ')})`);
    else result.push(skill);
  }
  return { skills: result, skipped };
};

// --- MCP -----------------------------------------------------------------

const validateMcpServer = (name: string, value: unknown, path: string): McpServer => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: server "${name}" must be an object.`);
  const record = value as Record<string, unknown>;
  if (typeof record.command !== 'string' || record.command.trim() === '') {
    throw new Error(`${path}: "${name}.command" must be a non-empty string.`);
  }
  if (record.args !== undefined && (!Array.isArray(record.args) || record.args.some((item) => typeof item !== 'string'))) {
    throw new Error(`${path}: "${name}.args" must be an array of strings.`);
  }
  if (record.env !== undefined) {
    if (record.env === null || typeof record.env !== 'object' || Array.isArray(record.env)) throw new Error(`${path}: "${name}.env" must be an object.`);
    for (const [key, item] of Object.entries(record.env)) if (typeof item !== 'string') throw new Error(`${path}: "${name}.env.${key}" must be a string.`);
  }
  if (record.agents !== undefined) {
    if (!Array.isArray(record.agents)) throw new Error(`${path}: "${name}.agents" must be an array.`);
    for (const agent of record.agents) if (typeof agent !== 'string' || !isAgent(agent)) throw new Error(`${path}: "${name}.agents" has unknown agent ${String(agent)}.`);
  }
  if (record.default !== undefined && typeof record.default !== 'boolean') throw new Error(`${path}: "${name}.default" must be a boolean.`);
  return record as McpServer;
};

const readMcpFile = (path: string, required: boolean): McpSource => {
  if (!existsSync(path)) {
    if (required) throw new Error(`Manifest mcp entry references missing file: ${path}.`);
    return { mcpServers: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path}: expected a JSON object.`);
  const record = parsed as Record<string, unknown>;
  const raw = record.mcpServers ?? record.mcp ?? {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path}: "mcpServers" must be an object.`);
  const mcpServers: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(raw)) mcpServers[name] = validateMcpServer(name, server, path);
  return { mcpServers };
};

const mergedMcp = (ctx: ContextBase): McpSource => {
  const servers: Record<string, McpServer> = {};
  for (const name of ctx.manifest.mcp) {
    assertSafeRelative(name, 'mcp');
    const path = join(ctx.source, 'canon', 'mcp', name);
    assertWithin(join(ctx.source, 'canon', 'mcp'), path, 'mcp source');
    const catalog = readMcpFile(path, true).mcpServers;
    const duplicates = Object.keys(catalog).filter((serverName) => Object.hasOwn(servers, serverName));
    if (duplicates.length > 0) throw new Error(`${path}: duplicate MCP server name(s): ${duplicates.join(', ')}.`);
    Object.assign(servers, catalog);
  }
  const localMcp = join(ctx.root, '.ai.local', 'mcp.json');
  if (existsSync(localMcp)) assertWithin(ctx.root, localMcp, 'local MCP file');
  Object.assign(servers, readMcpFile(localMcp, false).mcpServers);
  return { mcpServers: servers };
};

const resolveValue = (value: unknown, env: Record<string, string>, missing: Set<string>): unknown => {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_RE, (match, name: string) => {
      if (!env[name]) {
        missing.add(name);
        return match;
      }
      return env[name];
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, env, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, env, missing)]));
  }
  return value;
};

const resolveMcp = (ctx: Context, agent: Agent): { source: McpSource; skipped: string[] } => {
  const selected = new Set(ctx.mcps);
  const all = mergedMcp(ctx).mcpServers;
  const known = new Set(Object.keys(all));
  const unknown = [...selected].filter((name) => !['all', 'none'].includes(name) && !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown MCP server(s): ${unknown.join(', ')}`);
  if (selected.has('none')) return { source: { mcpServers: {} }, skipped: [] };
  const env = envMap(ctx.root);
  const skipped: string[] = [];
  const mcpServers: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(all)) {
    const agents = server.agents ?? ALL_AGENTS;
    if (!agents.includes(agent)) continue;
    if (selected.size > 0 && !selected.has('all') && !selected.has(name)) continue;
    if (selected.size === 0 && !ctx.includeOptInMcps && server.default === false) continue;
    const missing = new Set<string>();
    const resolved = resolveValue(server, env, missing) as McpServer;
    if (missing.size > 0) {
      skipped.push(`${name} (missing: ${[...missing].toSorted().join(', ')})`);
      continue;
    }
    delete resolved.agents;
    delete resolved.default;
    mcpServers[name] = resolved;
  }
  return { source: { mcpServers }, skipped };
};

// --- Rendering -----------------------------------------------------------

// The exact ownership tag rides along with every notice so ownership detection
// never depends on the customizable text.
const brandNotice = (notice: string): string => `${notice} ${OWNERSHIP_TAG}`;
const hasOwnershipTag = (content: string): boolean => {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const marker = (parsed as Record<string, unknown>)._generated;
      if (typeof marker === 'string' && marker.endsWith(OWNERSHIP_TAG)) return true;
    }
  } catch {
    // Non-JSON generated files use a structured comment line below.
  }
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ') && trimmed.endsWith(OWNERSHIP_TAG)) return true;
    if (trimmed.startsWith('<!-- ') && trimmed.endsWith(`${OWNERSHIP_TAG} -->`)) return true;
    return false;
  });
};

const isGeneratedContent = (content: string): boolean => {
  if (hasOwnershipTag(content)) return true;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const marker = (parsed as Record<string, unknown>)._generated;
      if (typeof marker === 'string' && marker.startsWith(GENERATED_MARKER)) return true;
    }
  } catch {
    // Legacy non-JSON files use a structured comment line below.
  }
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`# ${GENERATED_MARKER}`)) return true;
    return trimmed.startsWith(`<!-- ${GENERATED_MARKER}`) && trimmed.endsWith('-->');
  });
};

const renderSkill = (skill: Skill, agent: Agent, notice: string): string => {
  const header = `<!-- ${brandNotice(notice)} -->`;
  if (agent === 'opencode') return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${header}\n\n${skill.body}`;
  return `---\n${skill.frontmatterRaw}\n---\n${header}\n\n${skill.body}`;
};

const renderMcpJson = (src: McpSource, notice: string): string => `${JSON.stringify({ _generated: brandNotice(notice), ...src }, null, 2)}\n`;

const renderCodexConfig = (src: McpSource, notice: string): string => {
  const lines = [`# ${brandNotice(notice)}`, ''];
  for (const [name, server] of Object.entries(src.mcpServers).toSorted(([a], [b]) => a.localeCompare(b))) {
    lines.push(`[mcp_servers.${JSON.stringify(name)}]`);
    if (server.command) lines.push(`command = ${JSON.stringify(server.command)}`);
    if (server.args) lines.push(`args = ${JSON.stringify(server.args)}`);
    if (server.env) {
      lines.push('', `[mcp_servers.${JSON.stringify(name)}.env]`);
      for (const [key, value] of Object.entries(server.env).toSorted(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
};

const renderOpencodeConfig = (src: McpSource, notice: string): string => {
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(src.mcpServers)) {
    if (!server.command) continue;
    mcp[name] = { type: 'local', command: [server.command, ...(server.args ?? [])], enabled: true, ...(server.env ? { environment: server.env } : {}) };
  }
  return `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', _generated: brandNotice(notice), mcp }, null, 2)}\n`;
};

const stripFrontmatter = (content: string): [string | null, string] => {
  const match = content.replace(/\r\n/g, '\n').match(/^(---\n[\s\S]*?\n---)\n?([\s\S]*)$/);
  return match ? [match[1]!, match[2]!.replace(/^\n+/, '')] : [null, content];
};

const renderRules = (ctx: Context): string => {
  let frontmatter: string | null = null;
  const parts: string[] = [`<!-- ${brandNotice(ctx.generatedNotice)} -->`, ''];
  for (const name of ctx.manifest.rules) {
    assertSafeRelative(name, 'rules');
    const path = join(ctx.source, 'canon', 'rules', name);
    if (!existsSync(path)) throw new Error(`Manifest rules entry references missing file: ${path}.`);
    assertWithin(join(ctx.source, 'canon', 'rules'), path, 'rules source');
    const [fm, body] = stripFrontmatter(readFileSync(path, 'utf8'));
    if (fm && !frontmatter) frontmatter = fm;
    parts.push(`# Source: ${name}`, '', body.trim(), '');
  }
  const content = `${parts.join('\n').trim()}\n`;
  return frontmatter ? `${frontmatter}\n${content}` : content;
};

// --- Planning ------------------------------------------------------------

const planWrite = (
  ctx: Context,
  file: string,
  content: string,
  opts: { guarded?: boolean; mode?: number }
): PlannedWrite => {
  assertWithin(ctx.root, file, 'destination');
  const guarded = opts.guarded ?? false;
  let existing: string | null = null;
  let existingMode: number | undefined;
  if (existsSync(file)) {
    if (!statSync(file).isFile()) throw new Error(`${file} exists but is not a regular file.`);
    existing = readFileSync(file, 'utf8');
    existingMode = statSync(file).mode & 0o777;
  }
  let status: Status;
  const modeMatches = opts.mode === undefined || process.platform === 'win32' || existingMode === opts.mode;
  if (existing === content && modeMatches) status = 'unchanged';
  else if (existing !== null && guarded && !ctx.force && !isGeneratedContent(existing)) status = 'would-refuse';
  else status = existing === null ? 'would-create' : 'would-update';
  return { file, content, status, guarded, mode: opts.mode };
};

const isGitTracked = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], {
    encoding: 'utf8',
    stdio: 'ignore',
  }).status === 0;
};

const skillDirs: Record<Agent, string> = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  cursor: '.cursor/skills',
  opencode: '.opencode/skills',
};

const planScripts = (ctx: Context, writes: PlannedWrite[], expectedScripts: Set<string>): void => {
  const scriptsBase = join(ctx.source, 'canon', 'scripts');
  const destBase = join(ctx.root, '.ai', 'scripts');
  for (const source of expandPatterns(scriptsBase, ctx.manifest.scripts, 'scripts')) {
    const rel = relative(scriptsBase, source);
    assertSafeRelative(rel, 'script');
    const dest = join(destBase, rel);
    assertWithin(destBase, dest, 'script destination');
    let raw = readFileSync(source, 'utf8');
    // Normalize CRLF shebang scripts so the interpreter line is not `\r`-broken.
    if (raw.startsWith('#!') && raw.includes('\r\n')) raw = raw.replace(/\r\n/g, '\n');
    const content = raw.startsWith('#!')
      ? raw.replace('\n', `\n# ${brandNotice(ctx.generatedNotice)}\n`)
      : `# ${brandNotice(ctx.generatedNotice)}\n${raw}`;
    const mode = process.platform === 'win32' ? undefined : statSync(source).mode & 0o777;
    writes.push(planWrite(ctx, dest, content, { guarded: true, mode }));
    expectedScripts.add(resolve(dest));
  }
};

const planStaleSkills = (ctx: Context, agent: Agent, expected: Set<string>, removals: PlannedRemoval[]): void => {
  const dir = join(ctx.root, skillDirs[agent]);
  if (!existsSync(dir)) return;
  assertWithin(ctx.root, dir, 'skills cleanup root');
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || expected.has(entry.name)) continue;
    const skillFile = join(dir, entry.name, 'SKILL.md');
    assertWithin(ctx.root, skillFile, 'stale skill');
    // Only reclaim directories we demonstrably generated; a hand-authored
    // same-prefix skill has no ownership marker and is left untouched. The new
    // immutable tag also lets cleanup follow a deliberate namespace rename;
    // legacy marker-only files still require the current namespace prefix.
    if (!existsSync(skillFile)) continue;
    const content = readFileSync(skillFile, 'utf8');
    if (!hasOwnershipTag(content) && (!entry.name.startsWith(ctx.prefix) || !isGeneratedContent(content))) continue;
    removals.push({ label: `${agent}: ${entry.name}`, path: join(dir, entry.name) });
  }
};

const planStaleScripts = (ctx: Context, expected: Set<string>, removals: PlannedRemoval[]): void => {
  const destBase = join(ctx.root, '.ai', 'scripts');
  if (!existsSync(destBase)) return;
  assertWithin(ctx.root, destBase, 'scripts cleanup root');
  for (const file of allFiles(destBase)) {
    assertWithin(ctx.root, file, 'stale script');
    if (expected.has(resolve(file))) continue;
    if (!isGeneratedContent(readFileSync(file, 'utf8'))) continue;
    removals.push({ label: `script: ${relative(destBase, file)}`, path: file, pruneUpTo: destBase });
  }
}

const pruneEmptyDirs = (from: string, stopAt: string): void => {
  let dir = dirname(from);
  while (dir !== stopAt && withinLexical(stopAt, dir) && existsSync(dir)) {
    try {
      if (readdirSync(dir).length > 0) break;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      break;
    }
    dir = dirname(dir);
  }
};

const gitRef = (path: string): string | null => tryGit(['-C', path, 'rev-parse', 'HEAD'], path);

const sourceProvenance = (root: string, source: string): string => {
  const cache = resolve(root, '.ai', '.canon');
  if (resolve(source) === cache) {
    const origin = tryGit(['-C', source, 'remote', 'get-url', 'origin'], source);
    if (!origin) throw new Error(`Canon cache has no verified origin: ${source}.`);
    return origin;
  }
  return `local:${realpathSync(source)}`;
};

const contentHash = async (ctx: Context): Promise<string> => {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  const canonJson = join(ctx.source, 'canon.json');
  const files = [
    ...(existsSync(canonJson) ? [canonJson] : []),
    ...allFiles(join(ctx.source, 'canon')),
    ...allFiles(join(ctx.source, 'manifests')),
  ];
  for (const file of files.toSorted()) {
    hash.update(relative(ctx.source, file));
    hash.update(readFileSync(file));
  }
  return hash.digest('hex').slice(0, 12);
};

const lockContent = async (ctx: Context): Promise<string> => {
  const lock = {
    source: redactUrl(ctx.sourceLabel),
    ref: ctx.refLabel,
    resolvedRef: gitRef(ctx.source) ?? 'unknown',
    contentHash: await contentHash(ctx),
    manifest: ctx.repo,
    cliVersion: cliVersion(),
  };
  return `${JSON.stringify(lock, null, 2)}\n`;
};

const buildPlan = async (ctx: Context): Promise<Plan> => {
  const { skills, skipped: skippedSkills } = selectSkills(ctx);
  const writes: PlannedWrite[] = [];
  const removals: PlannedRemoval[] = [];
  const skippedMcps = new Set<string>();
  const expectedScripts = new Set<string>();

  planScripts(ctx, writes, expectedScripts);
  planStaleScripts(ctx, expectedScripts, removals);

  for (const agent of ctx.agents) {
    const expected = new Set(skills.filter((skill) => skill.agents.includes(agent)).map((skill) => skill.name));
    for (const skill of skills) {
      if (!skill.agents.includes(agent)) continue;
      writes.push(
        planWrite(ctx, join(ctx.root, skillDirs[agent], skill.name, 'SKILL.md'), renderSkill(skill, agent, ctx.generatedNotice), { guarded: true })
      );
    }
    planStaleSkills(ctx, agent, expected, removals);
    const { source, skipped } = resolveMcp(ctx, agent);
    skipped.forEach((item) => skippedMcps.add(item));
    if (agent === 'claude') {
      writes.push(planWrite(ctx, join(ctx.root, '.mcp.json'), renderMcpJson(source, ctx.generatedNotice), { guarded: true, mode: SECRET_MODE }));
    }
    if (agent === 'codex') {
      writes.push(planWrite(ctx, join(ctx.root, '.codex', 'config.toml'), renderCodexConfig(source, ctx.generatedNotice), { guarded: true, mode: SECRET_MODE }));
    }
    if (agent === 'cursor') {
      writes.push(planWrite(ctx, join(ctx.root, '.cursor', 'mcp.json'), renderMcpJson(source, ctx.generatedNotice), { guarded: true, mode: SECRET_MODE }));
      writes.push(planWrite(ctx, join(ctx.root, '.cursor', 'rules', `${ctx.canon.namespace}-rules.mdc`), renderRules(ctx), { guarded: true }));
    }
    if (agent === 'opencode') {
      writes.push(planWrite(ctx, join(ctx.root, 'opencode.json'), renderOpencodeConfig(source, ctx.generatedNotice), { guarded: true, mode: SECRET_MODE }));
    }
  }

  writes.push(planWrite(ctx, join(ctx.root, '.ai.lock.json'), await lockContent(ctx), {}));

  const trackedSecrets = writes.filter((write) => write.mode === SECRET_MODE && isGitTracked(ctx.root, write.file));
  if (trackedSecrets.length > 0) {
    const paths = trackedSecrets.map((write) => relative(ctx.root, write.file)).join(', ');
    throw new Error(
      `Refusing to write secret-bearing generated config tracked by Git: ${paths}. ` +
        `Remove it from the index (git rm --cached <path>) and keep the ai-canon ignore block before syncing.`
    );
  }

  return { writes, removals, skippedSkills, skippedMcps: [...skippedMcps] };
};

// --- Apply ---------------------------------------------------------------

let tmpCounter = 0;

const atomicWrite = (file: string, content: string, mode?: number): void => {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.ai-canon.tmp.${process.pid}.${tmpCounter++}.${randomUUID()}`);
  try {
    writeFileSync(tmp, content, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (error) {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    throw error;
  }
};

// Reject up front so a guard conflict leaves the consumer completely unchanged.
const assertNoConflicts = (plan: Plan): void => {
  const conflicts = plan.writes.filter((write) => write.status === 'would-refuse');
  if (conflicts.length === 0) return;
  const files = conflicts.map((write) => write.file).join(', ');
  throw new Error(
    `Refusing to overwrite non-generated file: ${files}. Re-run with --force if safe. No changes were made.`
  );
};

const applyPlan = (ctx: Context, plan: Plan): void => {
  assertNoConflicts(plan);
  const affected = [
    ...plan.writes.filter((write) => write.status !== 'unchanged').map((write) => write.file),
    ...plan.removals.map((removal) => removal.path),
  ].filter((path, index, paths) => paths.indexOf(path) === index);
  const backupRoot = mkdtempSync(join(tmpdir(), 'ai-canon-rollback-'));
  const snapshots: Array<{ path: string; backup: string; existed: boolean; pruneStop: string }> = [];
  try {
    for (const [index, path] of affected.entries()) {
      assertWithin(ctx.root, path, 'transaction path');
      const existed = existsSync(path);
      const backup = join(backupRoot, String(index));
      let pruneStop = ctx.root;
      for (let parent = dirname(path); parent !== ctx.root && withinLexical(ctx.root, parent); parent = dirname(parent)) {
        if (existsSync(parent)) {
          pruneStop = parent;
          break;
        }
      }
      if (existed) cpSync(path, backup, { recursive: true, preserveTimestamps: true });
      snapshots.push({ path, backup, existed, pruneStop });
    }
  } catch (error) {
    rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }

  try {
    for (const write of plan.writes) {
      if (write.status === 'unchanged') continue;
      assertWithin(ctx.root, write.file, 'destination');
      atomicWrite(write.file, write.content, write.mode);
      write.status = write.status === 'would-create' ? 'created' : 'updated';
    }
    for (const removal of plan.removals) {
      assertWithin(ctx.root, removal.path, 'removal');
      rmSync(removal.path, { recursive: true, force: true });
      if (removal.pruneUpTo) pruneEmptyDirs(removal.path, removal.pruneUpTo);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const snapshot of snapshots.toReversed()) {
      try {
        if (existsSync(snapshot.path)) rmSync(snapshot.path, { recursive: true, force: true });
        if (snapshot.existed) {
          mkdirSync(dirname(snapshot.path), { recursive: true });
          cpSync(snapshot.backup, snapshot.path, { recursive: true, preserveTimestamps: true });
        } else {
          pruneEmptyDirs(snapshot.path, snapshot.pruneStop);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${snapshot.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (rollbackErrors.length > 0) {
      throw new Error(`Sync failed (${message}) and rollback was incomplete: ${rollbackErrors.join('; ')}`);
    }
    throw new Error(`Sync failed and all planned changes were rolled back: ${message}`);
  } finally {
    rmSync(backupRoot, { recursive: true, force: true });
  }
};

// --- Reporting -----------------------------------------------------------

const reportPlan = (ctx: Context, plan: Plan, mode: 'apply' | 'check'): number => {
  const changed = plan.writes.filter((write) => write.status !== 'unchanged');
  console.log(chalk.cyan(`ai-canon [${ctx.canon.name}]: ${ctx.repo} -> ${ctx.agents.join(', ')}`));
  if (changed.length === 0 && plan.removals.length === 0) {
    console.log(chalk.green(`✓ All generated files are up-to-date.`));
  } else if (changed.length > 0) {
    console.log(chalk.bold(`Changes (${changed.length})`));
    for (const write of changed) {
      const color = write.status.includes('refuse') ? chalk.red : write.status.includes('updat') ? chalk.yellow : chalk.green;
      console.log(`  ${color(write.status.padEnd(12))} ${relative(ctx.root, write.file)}`);
    }
  }
  if (plan.removals.length > 0) {
    const verb = mode === 'check' ? 'Would remove stale' : 'Removed stale';
    console.log(chalk.yellow(`${verb}:\n  ${plan.removals.map((removal) => removal.label).join('\n  ')}`));
  }
  if (plan.skippedSkills.length > 0) console.log(chalk.yellow(`Skipped skills:\n  ${plan.skippedSkills.join('\n  ')}`));
  if (plan.skippedMcps.length > 0) console.log(chalk.yellow(`Skipped MCP servers:\n  ${plan.skippedMcps.join('\n  ')}`));
  const drift = changed.length + plan.removals.length;
  return mode === 'check' && drift > 0 ? 1 : 0;
};

const install = async (ctx: Context, check: boolean): Promise<number> => {
  const plan = await buildPlan(ctx);
  if (!check) applyPlan(ctx, plan);
  return reportPlan(ctx, plan, check ? 'check' : 'apply');
};

const doctor = async (ctx: Context): Promise<number> => {
  const plan = await buildPlan(ctx);
  const skills = allSkills(ctx);
  const mcp = mergedMcp(ctx);
  console.log(chalk.cyan('ai-canon doctor'));
  console.log(`  root:      ${ctx.root}`);
  console.log(`  source:    ${redactUrl(ctx.source)}`);
  console.log(`  canon:     ${ctx.canon.name} (namespace: ${ctx.canon.namespace})`);
  console.log(`  repo:      ${ctx.repo}`);
  console.log(`  skills:    ${skills.length}`);
  console.log(`  MCPs:      ${Object.keys(mcp.mcpServers).length}`);
  const conflicts = plan.writes.filter((write) => write.status === 'would-refuse');
  const drift = plan.writes.filter((write) => write.status.startsWith('would-') && write.status !== 'would-refuse').length + plan.removals.length;
  if (drift === 0 && conflicts.length === 0) {
    console.log(chalk.green('✓ In sync with canon.'));
  } else {
    console.log(chalk.yellow(`Pending: ${drift} change(s), ${plan.removals.length} removal(s), ${conflicts.length} conflict(s).`));
    console.log(chalk.gray('Run: ai-canon doctor --check for details, or ai-canon sync to apply.'));
  }
  return 0;
};

const listSkills = (ctx: Context): number => {
  for (const skill of allSkills(ctx)) console.log(`${skill.name.padEnd(34)} ${(skill.isDefault ? 'default' : 'opt-in').padEnd(8)} ${skill.description}`);
  return 0;
};

// --- Interactive prompts -------------------------------------------------

const promptSkillSelection = async (
  ctx: ContextBase,
  agents: Agent[]
): Promise<{ includeOptIn: boolean; skills: string[] }> => {
  while (true) {
    const skillMode = await select({
      message: 'Skills',
      options: [
        { value: 'default', label: 'Default skills' },
        { value: 'all', label: 'All skills, including opt-in' },
        { value: 'custom', label: 'Choose skills' },
      ],
    });
    if (isCancel(skillMode)) process.exit(0);
    if (skillMode === 'default') return { skills: [], includeOptIn: false };
    if (skillMode === 'all') return { skills: ['all'], includeOptIn: true };

    const choices = await multiselect({
      message: 'Choose skills',
      options: [
        { value: '__back__', label: '← Back to skill mode' },
        ...allSkills(ctx)
          .filter((skill) => skill.agents.some((agent) => agents.includes(agent)))
          .map((skill) => ({ value: skill.name, label: skill.name, hint: skill.description })),
      ],
      required: true,
    });
    if (isCancel(choices)) process.exit(0);
    const selected = choices as string[];
    if (selected.includes('__back__')) continue;
    return { skills: selected, includeOptIn: true };
  }
};

const promptMcpSelection = async (
  ctx: ContextBase,
  agents: Agent[]
): Promise<{ includeOptIn: boolean; mcps: string[] }> => {
  while (true) {
    const mcpMode = await select({
      message: 'MCP servers',
      options: [
        { value: 'default', label: 'Default MCPs' },
        { value: 'all', label: 'All MCPs, including opt-in' },
        { value: 'custom', label: 'Choose MCPs' },
        { value: 'none', label: 'No MCPs' },
      ],
    });
    if (isCancel(mcpMode)) process.exit(0);
    if (mcpMode === 'default') return { mcps: [], includeOptIn: false };
    if (mcpMode === 'all') return { mcps: ['all'], includeOptIn: true };
    if (mcpMode === 'none') return { mcps: ['none'], includeOptIn: false };

    const source = mergedMcp(ctx);
    const choices = await multiselect({
      message: 'Choose MCP servers',
      options: [
        { value: '__back__', label: '← Back to MCP mode' },
        ...Object.entries(source.mcpServers)
          .filter(([, server]) => (server.agents ?? ALL_AGENTS).some((agent) => agents.includes(agent)))
          .map(([name]) => name)
          .toSorted()
          .map((name) => ({ value: name, label: name })),
      ],
      required: false,
    });
    if (isCancel(choices)) process.exit(0);
    const selected = choices as string[];
    if (selected.includes('__back__')) continue;
    return { mcps: selected, includeOptIn: true };
  }
};

const promptIfNeeded = async (args: Args, ctx: ContextBase): Promise<Selection> => {
  const hasExplicit = args.agents.length > 0 || args.skills.length > 0 || args.mcps.length > 0 || args.includeOptIn || args.force;
  const shouldPrompt =
    args.command !== 'doctor' &&
    !args.check &&
    !args.noInteractive &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
    (args.interactive || !hasExplicit);
  if (!shouldPrompt) {
    return {
      agents: args.agents.length > 0 ? args.agents : ctx.manifest.defaultAgents ?? ['claude', 'codex'],
      skills: args.skills,
      mcps: args.mcps,
      includeOptInSkills: args.includeOptIn,
      includeOptInMcps: args.includeOptIn,
      force: args.force,
    };
  }
  intro(chalk.cyan(`Sync AI agent config from canon '${ctx.canon.name}'`));
  const agents = await multiselect({
    message: 'Which AI coding tools do you use?',
    options: ALL_AGENTS.map((agent) => ({ value: agent, label: agent })),
    initialValues: ctx.manifest.defaultAgents ?? ['claude', 'codex'],
    required: true,
  });
  if (isCancel(agents)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  const skillSelection = await promptSkillSelection(ctx, agents as Agent[]);
  const mcpSelection = await promptMcpSelection(ctx, agents as Agent[]);
  const force = await confirm({ message: 'Allow replacing non-generated files at managed destinations?', initialValue: false });
  if (isCancel(force)) process.exit(0);
  outro(chalk.gray('Syncing...'));
  return {
    agents: agents as Agent[],
    skills: skillSelection.skills,
    mcps: mcpSelection.mcps,
    includeOptInSkills: skillSelection.includeOptIn,
    includeOptInMcps: mcpSelection.includeOptIn,
    force: Boolean(force),
  };
};

const buildContext = async (args: Args): Promise<Context> => {
  const root = resolve(args.root ?? repoRoot());
  const config = loadConsumerConfig(root);
  const repo = detectRepo(root, config, args.repo);
  const source = resolveSource(args, root, config);
  const canon = loadCanonConfig(source);
  const manifest = loadManifest(source, repo);
  const noticeRaw = args.generatedNotice ?? config.generatedNotice ?? canon.generatedNotice ?? GEN_NOTICE_DEFAULT;
  const base: ContextBase = {
    root,
    source,
    sourceLabel: sourceProvenance(root, source),
    refLabel: refLabelFor(args, config),
    repo,
    canon,
    prefix: `${canon.namespace}-`,
    manifest,
    generatedNotice: validateNotice(noticeRaw),
  };
  return { ...base, ...(await promptIfNeeded(args, base)) };
};

// --- Init ----------------------------------------------------------------

const writeIfAbsent = (path: string, content: string): boolean => {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
};

const AI_IGNORE_BLOCK = [
  '# ai-canon generated files (local developer state; may contain resolved secrets)',
  '.ai/',
  '.ai.local/',
  '.ai.lock.json',
  '.claude/skills/',
  '.agents/skills/',
  '.cursor/',
  '.codex/',
  '.opencode/skills/',
  '.mcp.json',
  'opencode.json',
];

const ensureGitignore = (root: string): boolean => {
  const path = join(root, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const missing = AI_IGNORE_BLOCK.filter((line) => !lines.includes(line));
  if (missing.length === 0) return false;
  const prefix = existing.replace(/\n*$/, '');
  const block = [
    ...(existing.includes('# ai-canon generated files') ? [] : [AI_IGNORE_BLOCK[0]!]),
    ...missing.filter((line) => line !== AI_IGNORE_BLOCK[0]),
  ].join('\n');
  writeFileSync(path, `${prefix}${prefix ? '\n\n' : ''}${block}\n`);
  return true;
};

const initConsumer = async (args: Args): Promise<number> => {
  const root = resolve(args.root ?? repoRoot());
  const existing = loadConsumerConfig(root);
  const hasConfig = existsSync(join(root, '.ai.yaml'));
  let canon = args.canonUrl;
  if (!canon && hasConfig && existing.canon) canon = existing.canon;
  if (!canon && !args.noInteractive && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await text({
      message: 'Canon repo (git URL or relative path):',
      placeholder: 'git@github.com:your-org/your-ai-canon.git',
    });
    if (isCancel(answer)) process.exit(0);
    canon = String(answer);
  }
  if (!canon) throw new Error('Pass --canon <git-url-or-path> (or run interactively).');
  const repo = args.repo ?? existing.repo ?? basename(root);
  assertSafeName(repo, 'repo name');

  if (hasConfig) {
    // Do not clobber or falsely claim success when a config already exists.
    const conflicts: string[] = [];
    if (existing.canon && existing.canon !== canon) conflicts.push(`canon: ${existing.canon} (keeping; requested ${canon})`);
    if (existing.repo && args.repo && existing.repo !== args.repo) conflicts.push(`repo: ${existing.repo} (keeping; requested ${args.repo})`);
    if (conflicts.length > 0) {
      console.error(chalk.red(`.ai.yaml already exists with a different configuration:`));
      for (const line of conflicts) console.error(`  ${line}`);
      console.error(`Edit ${join(root, '.ai.yaml')} directly, or remove it and re-run init.`);
      return 1;
    }
    const repairedIgnore = ensureGitignore(root);
    console.log(chalk.green(`Consumer repo '${repo}' already initialized; configuration retained.`));
    if (repairedIgnore) console.log('  updated .gitignore');
    console.log(`\nNext: run ${chalk.cyan('ai-canon sync')}`);
    return 0;
  }

  const created: string[] = [];
  if (writeIfAbsent(join(root, '.ai.yaml'), stringifyYaml({ canon, repo }))) created.push('.ai.yaml');
  if (ensureGitignore(root)) created.push('.gitignore (updated)');
  console.log(chalk.green(`Initialized consumer repo '${repo}'.`));
  for (const file of created) console.log(`  created ${file}`);
  console.log(`\nEnsure the canon has a manifest named ${chalk.cyan(`manifests/${repo}.json`)}, then run ${chalk.cyan('ai-canon sync')}`);
  return 0;
};

const initCanon = (args: Args): number => {
  const root = resolve(args.root ?? process.cwd());
  const name = (args.repo ?? basename(root)).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Canon name must be lowercase alphanumeric/dashes (got: ${name}).`);
  const created: string[] = [];
  const files: Record<string, string> = {
    'canon.json': `${JSON.stringify({ name, namespace: name, sourceLabel: `git:${name}` }, null, 2)}\n`,
    [`canon/skills/common/${name}-hello.md`]: `---\nname: ${name}-hello\ndescription: Example skill. Replace with your own. Use when the user says "hello canon".\n---\n\n# Hello from ${name}\n\nThis is an example skill distributed by ai-canon. Edit or delete it.\n`,
    'canon/mcp/common.json': `${JSON.stringify(
      {
        mcpServers: {
          context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], default: false },
          'example-with-secret': {
            command: 'npx',
            args: ['-y', 'some-mcp-server'],
            env: { API_TOKEN: '${EXAMPLE_API_TOKEN}' },
            default: false,
          },
        },
      },
      null,
      2
    )}\n`,
    'canon/rules/common.md': `# Rules\n\n- Shared rules for every repo consuming this canon go here.\n`,
    'manifests/example.json': `${JSON.stringify(
      {
        version: 1,
        repo: 'example',
        skills: ['common/*.md'],
        rules: ['common.md'],
        mcp: ['common.json'],
        scripts: [],
        defaultAgents: ['claude', 'codex'],
      },
      null,
      2
    )}\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (writeIfAbsent(join(root, rel), content)) created.push(rel);
  }
  console.log(chalk.green(`Initialized canon '${name}' at ${root}.`));
  for (const file of created) console.log(`  created ${file}`);
  console.log(`\nCopy manifests/example.json to manifests/<consumer-repo-name>.json for each repo, then in each consumer repo run:`);
  console.log(chalk.cyan(`  ai-canon init --canon <this repo's git URL>`));
  return 0;
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  if (args.command === 'init') {
    process.exitCode = args.initKind === 'canon' ? initCanon(args) : await initConsumer(args);
    return;
  }
  const ctx = await buildContext(args);
  let code = 0;
  if (args.command === 'sync') code = await install(ctx, args.check);
  else if (args.command === 'doctor') code = args.check ? await install(ctx, true) : await doctor(ctx);
  else code = listSkills(ctx);
  process.exitCode = code;
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
