#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cancel, confirm, intro, isCancel, multiselect, outro, select, text } from '@clack/prompts';
import chalk from 'chalk';
import { parse as parseYaml } from 'yaml';

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
  repo: string;
  canon: CanonConfig;
  prefix: string;
  manifest: Record<string, unknown>;
  agents: Agent[];
  skills: string[];
  mcps: string[];
  includeOptIn: boolean;
  force: boolean;
  generatedNotice: string;
}

interface WriteResult {
  file: string;
  status: Status;
}

const ALL_AGENTS: Agent[] = ['claude', 'codex', 'cursor', 'opencode'];
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const PLACEHOLDER_RE = /\$\{([A-Z0-9_]+)}/g;
const GENERATED_MARKER = 'GENERATED FILE. Do not edit directly';
const GEN_NOTICE_DEFAULT = `${GENERATED_MARKER}. Run: ai-canon sync`;
const GIT_URL_RE = /^(git@|ssh:\/\/|https?:\/\/|git:\/\/|file:\/\/)/;

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
  --force                    Allow replacing non-generated root config files
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
      if (!value) throw new Error(`${arg} requires a value`);
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

const parseSimpleYaml = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes(':')) continue;
    const [key, ...rest] = line.split(':');
    result[key!.trim()] = rest.join(':').trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
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
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  return result.stdout ?? '';
};

const detectRepo = (root: string, explicit?: string): string => {
  if (explicit) return explicit;
  const config = parseSimpleYaml(join(root, '.ai.yaml'));
  if (config.repo) return config.repo;
  return basename(root);
};

const isCanonDir = (path: string): boolean => existsSync(join(path, 'canon.json'));

const loadCanonConfig = (source: string): CanonConfig => {
  const path = join(source, 'canon.json');
  if (!existsSync(path)) {
    throw new Error(
      `${source} is not a canon repo (no canon.json). Create one with: ai-canon init canon`
    );
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CanonConfig>;
  if (!parsed.name || typeof parsed.name !== 'string') throw new Error(`${path}: missing "name"`);
  const namespace = parsed.namespace ?? parsed.name;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(namespace)) {
    throw new Error(`${path}: "namespace" must be lowercase alphanumeric/dashes (got: ${namespace})`);
  }
  return { name: parsed.name, namespace, sourceLabel: parsed.sourceLabel, generatedNotice: parsed.generatedNotice };
};

const fetchCanon = (root: string, url: string, ref: string | undefined): string => {
  const checkout = join(root, '.ai', '.canon');
  if (!existsSync(join(checkout, '.git'))) {
    mkdirSync(dirname(checkout), { recursive: true });
    run('git', ['clone', '--quiet', url, checkout], root, true);
  }
  run('git', ['-C', checkout, 'fetch', '--quiet', 'origin'], root, true);
  if (!ref) run('git', ['-C', checkout, 'remote', 'set-head', 'origin', '--auto'], root, true);
  run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', ref ?? 'origin/HEAD'], root, true);
  return checkout;
};

const resolveSource = (args: Args, root: string, config: Record<string, string>): string => {
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

const globToRe = (glob: string): RegExp =>
  new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

const expandPatterns = (base: string, patterns: string[]): string[] => {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const candidates = pattern.includes('*')
      ? allFiles(join(base, dirname(pattern))).filter((file) => globToRe(basename(pattern)).test(basename(file)))
      : [join(base, pattern)];
    for (const file of candidates.toSorted()) {
      if (!existsSync(file)) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  return files;
};

const allFiles = (base: string): string[] => {
  if (!existsSync(base)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const path = join(base, entry.name);
    if (entry.isDirectory()) result.push(...allFiles(path));
    else result.push(path);
  }
  return result;
};

const loadManifest = (source: string, repo: string): Record<string, unknown> => {
  const path = join(source, 'manifests', `${repo}.json`);
  if (!existsSync(path)) {
    const available = existsSync(join(source, 'manifests'))
      ? readdirSync(join(source, 'manifests'))
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.replace(/\.json$/, ''))
          .join(', ')
      : '(none)';
    throw new Error(`No manifest for repo '${repo}' at ${path}. Available manifests: ${available}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
};

const parseSkillFile = (file: string, prefix: string): Skill => {
  const name = basename(file).replace(/\.md$/, '');
  const content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  const frontmatterRaw = match[1]!;
  const body = match[2]!.replace(/^\n+/, '');
  const fm = (parseYaml(frontmatterRaw) ?? {}) as Record<string, unknown>;
  if (fm.name !== name) throw new Error(`${file}: frontmatter name must match filename`);
  if (typeof fm.description !== 'string') throw new Error(`${file}: missing description`);
  const agents = Array.isArray(fm.agents) ? fm.agents : ALL_AGENTS;
  for (const agent of agents) if (typeof agent !== 'string' || !isAgent(agent)) throw new Error(`${file}: unknown agent ${String(agent)}`);
  const requiresEnv = Array.isArray(fm['requires-env'])
    ? fm['requires-env'].filter((item): item is string => typeof item === 'string')
    : typeof fm['requires-env'] === 'string'
      ? parseList(fm['requires-env'])
      : [];
  if (!name.startsWith(prefix)) {
    throw new Error(`${file}: skill names must start with the canon namespace prefix '${prefix}' (stale-cleanup safety)`);
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

const allSkills = (ctx: Context): Skill[] => {
  const patterns = (ctx.manifest.skills as string[] | undefined) ?? [];
  return expandPatterns(join(ctx.source, 'canon', 'skills'), patterns)
    .map((file) => parseSkillFile(file, ctx.prefix))
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

const envMap = (root: string): Record<string, string> => {
  const result: Record<string, string> = { ...process.env } as Record<string, string>;
  const envPath = join(root, '.ai.local', 'env');
  if (!existsSync(envPath)) return result;
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
      : skills.filter((skill) => ctx.includeOptIn || skill.isDefault);
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

const readMcpFile = (path: string): McpSource => {
  if (!existsSync(path)) return { mcpServers: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<McpSource & { mcp: McpSource['mcpServers'] }>;
  return { mcpServers: parsed.mcpServers ?? parsed.mcp ?? {} };
};

const mergedMcp = (ctx: Context): McpSource => {
  const servers: Record<string, McpServer> = {};
  for (const name of ((ctx.manifest.mcp as string[] | undefined) ?? [])) {
    Object.assign(servers, readMcpFile(join(ctx.source, 'canon', 'mcp', name)).mcpServers);
  }
  Object.assign(servers, readMcpFile(join(ctx.root, '.ai.local', 'mcp.json')).mcpServers);
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
    if (selected.size === 0 && !ctx.includeOptIn && server.default === false) continue;
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

const generatedMarker = (content: string, notice: string): boolean => content.includes(notice) || content.includes(GENERATED_MARKER);

const writeGenerated = (ctx: Context, file: string, content: string, results: WriteResult[], guarded = false, check = false): void => {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (existing === content) {
    results.push({ file, status: 'unchanged' });
    return;
  }
  if (existing !== null && guarded && !ctx.force && !generatedMarker(existing, ctx.generatedNotice)) {
    results.push({ file, status: 'would-refuse' });
    if (!check) throw new Error(`Refusing to overwrite non-generated file: ${file}. Re-run with --force if safe.`);
    return;
  }
  if (check) {
    results.push({ file, status: existing === null ? 'would-create' : 'would-update' });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  results.push({ file, status: existing === null ? 'created' : 'updated' });
};

const renderSkill = (skill: Skill, agent: Agent, notice: string): string => {
  const header = `<!-- ${notice} -->`;
  if (agent === 'opencode') return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${header}\n\n${skill.body}`;
  return `---\n${skill.frontmatterRaw}\n---\n${header}\n\n${skill.body}`;
};

const renderMcpJson = (src: McpSource, notice: string): string => `${JSON.stringify({ _generated: notice, ...src }, null, 2)}\n`;

const renderCodexConfig = (src: McpSource, notice: string): string => {
  const lines = [`# ${notice}`, ''];
  for (const [name, server] of Object.entries(src.mcpServers).toSorted(([a], [b]) => a.localeCompare(b))) {
    lines.push(`[mcp_servers.${JSON.stringify(name)}]`);
    if (server.command) lines.push(`command = ${JSON.stringify(server.command)}`);
    if (server.args) lines.push(`args = ${JSON.stringify(server.args)}`);
    if (server.env) {
      lines.push('', `[mcp_servers.${JSON.stringify(name)}.env]`);
      for (const [key, value] of Object.entries(server.env).toSorted(([a], [b]) => a.localeCompare(b))) lines.push(`${key} = ${JSON.stringify(value)}`);
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
  return `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', _generated: notice, mcp }, null, 2)}\n`;
};

const stripFrontmatter = (content: string): [string | null, string] => {
  const match = content.replace(/\r\n/g, '\n').match(/^(---\n[\s\S]*?\n---)\n?([\s\S]*)$/);
  return match ? [match[1]!, match[2]!.replace(/^\n+/, '')] : [null, content];
};

const renderRules = (ctx: Context): string => {
  let frontmatter: string | null = null;
  const parts: string[] = [`<!-- ${ctx.generatedNotice} -->`, ''];
  for (const name of ((ctx.manifest.rules as string[] | undefined) ?? [])) {
    const path = join(ctx.source, 'canon', 'rules', name);
    if (!existsSync(path)) continue;
    const [fm, body] = stripFrontmatter(readFileSync(path, 'utf8'));
    if (fm && !frontmatter) frontmatter = fm;
    parts.push(`# Source: ${name}`, '', body.trim(), '');
  }
  const content = `${parts.join('\n').trim()}\n`;
  return frontmatter ? `${frontmatter}\n${content}` : content;
};

const installScripts = (ctx: Context, results: WriteResult[], check: boolean): void => {
  const patterns = (ctx.manifest.scripts as string[] | undefined) ?? [];
  for (const source of expandPatterns(join(ctx.source, 'canon', 'scripts'), patterns)) {
    const rel = relative(join(ctx.source, 'canon', 'scripts'), source);
    const raw = readFileSync(source, 'utf8');
    const content = raw.startsWith('#!') ? raw.replace('\n', `\n# ${ctx.generatedNotice}\n`) : `# ${ctx.generatedNotice}\n${raw}`;
    writeGenerated(ctx, join(ctx.root, '.ai', 'scripts', rel), content, results, false, check);
  }
};

const gitRef = (path: string): string | null => {
  try {
    return run('git', ['-C', path, 'rev-parse', 'HEAD'], path, true).trim();
  } catch {
    return null;
  }
};

const contentHash = async (ctx: Context): Promise<string> => {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  const files = [...allFiles(join(ctx.source, 'canon')), ...allFiles(join(ctx.source, 'manifests'))];
  for (const file of files.toSorted()) {
    hash.update(relative(ctx.source, file));
    hash.update(readFileSync(file));
  }
  return hash.digest('hex').slice(0, 12);
};

const writeLock = async (ctx: Context): Promise<void> => {
  const lock = {
    source: ctx.sourceLabel,
    resolvedRef: gitRef(ctx.source) ?? 'unknown',
    contentHash: await contentHash(ctx),
    manifest: ctx.repo,
    cliVersion: cliVersion(),
  };
  writeGenerated(ctx, join(ctx.root, '.ai.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, [], false, false);
};

const skillDirs: Record<Agent, string> = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  cursor: '.cursor/skills',
  opencode: '.opencode/skills',
};

const removeStale = (ctx: Context, agent: Agent, expected: Set<string>, removed: string[], check: boolean): void => {
  if (check) return;
  const dir = join(ctx.root, skillDirs[agent]);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(ctx.prefix) || expected.has(entry.name)) continue;
    rmSync(join(dir, entry.name), { recursive: true, force: true });
    removed.push(`${agent}: ${entry.name}`);
  }
};

const install = async (ctx: Context, check: boolean): Promise<number> => {
  const { skills, skipped: skippedSkills } = selectSkills(ctx);
  const results: WriteResult[] = [];
  const skippedMcps = new Set<string>();
  const removed: string[] = [];
  installScripts(ctx, results, check);
  for (const agent of ctx.agents) {
    const expected = new Set(skills.filter((skill) => skill.agents.includes(agent)).map((skill) => skill.name));
    for (const skill of skills) {
      if (!skill.agents.includes(agent)) continue;
      writeGenerated(ctx, join(ctx.root, skillDirs[agent], skill.name, 'SKILL.md'), renderSkill(skill, agent, ctx.generatedNotice), results, false, check);
    }
    removeStale(ctx, agent, expected, removed, check);
    const { source, skipped } = resolveMcp(ctx, agent);
    skipped.forEach((item) => skippedMcps.add(item));
    if (agent === 'claude') writeGenerated(ctx, join(ctx.root, '.mcp.json'), renderMcpJson(source, ctx.generatedNotice), results, true, check);
    if (agent === 'codex') writeGenerated(ctx, join(ctx.root, '.codex', 'config.toml'), renderCodexConfig(source, ctx.generatedNotice), results, true, check);
    if (agent === 'cursor') {
      writeGenerated(ctx, join(ctx.root, '.cursor', 'mcp.json'), renderMcpJson(source, ctx.generatedNotice), results, true, check);
      writeGenerated(ctx, join(ctx.root, '.cursor', 'rules', `${ctx.canon.namespace}-rules.mdc`), renderRules(ctx), results, true, check);
    }
    if (agent === 'opencode') writeGenerated(ctx, join(ctx.root, 'opencode.json'), renderOpencodeConfig(source, ctx.generatedNotice), results, true, check);
  }
  if (!check) await writeLock(ctx);
  const changed = results.filter((result) => result.status !== 'unchanged');
  console.log(chalk.cyan(`ai-canon [${ctx.canon.name}]: ${ctx.repo} -> ${ctx.agents.join(', ')}`));
  if (changed.length === 0) console.log(chalk.green(`✓ All generated files are up-to-date.`));
  else {
    console.log(chalk.bold(`Changes (${changed.length})`));
    for (const result of changed) {
      const colorStatus = result.status.includes('refuse')
        ? chalk.red
        : result.status.includes('updat')
          ? chalk.yellow
          : chalk.green;
      console.log(`  ${colorStatus(result.status.padEnd(12))} ${relative(ctx.root, result.file)}`);
    }
  }
  if (removed.length > 0) console.log(chalk.yellow(`Removed stale skills:\n  ${removed.join('\n  ')}`));
  if (skippedSkills.length > 0) console.log(chalk.yellow(`Skipped skills:\n  ${skippedSkills.join('\n  ')}`));
  if (skippedMcps.size > 0) console.log(chalk.yellow(`Skipped MCP servers:\n  ${[...skippedMcps].join('\n  ')}`));
  return check && changed.length > 0 ? 1 : 0;
};

const promptIfNeeded = async (args: Args, ctx: Omit<Context, 'agents' | 'skills' | 'mcps' | 'includeOptIn' | 'force'>): Promise<Pick<Context, 'agents' | 'skills' | 'mcps' | 'includeOptIn' | 'force'>> => {
  const hasExplicit = args.agents.length > 0 || args.skills.length > 0 || args.mcps.length > 0 || args.includeOptIn || args.force;
  const shouldPrompt = args.command !== 'doctor' && !args.check && !args.noInteractive && Boolean(process.stdin.isTTY && process.stdout.isTTY) && (args.interactive || !hasExplicit);
  if (!shouldPrompt) {
    return {
      agents: args.agents.length > 0 ? args.agents : ((ctx.manifest.defaultAgents as Agent[] | undefined) ?? ['claude', 'codex']),
      skills: args.skills,
      mcps: args.mcps,
      includeOptIn: args.includeOptIn,
      force: args.force,
    };
  }
  intro(chalk.cyan(`Sync AI agent config from canon '${ctx.canon.name}'`));
  const agents = await multiselect({
    message: 'Which AI coding tools do you use?',
    options: ALL_AGENTS.map((agent) => ({ value: agent, label: agent })),
    initialValues: ((ctx.manifest.defaultAgents as Agent[] | undefined) ?? ['claude', 'codex']),
    required: true,
  });
  if (isCancel(agents)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  const skillSelection = await promptSkillSelection(ctx, agents as Agent[]);
  const mcpSelection = await promptMcpSelection(ctx, agents as Agent[], skillSelection.skills);
  const includeOptIn = skillSelection.includeOptIn || mcpSelection.includeOptIn;
  const force = await confirm({ message: 'Allow replacing non-generated root config files?', initialValue: false });
  if (isCancel(force)) process.exit(0);
  outro(chalk.gray('Syncing...'));
  return {
    agents: agents as Agent[],
    skills: skillSelection.skills,
    mcps: mcpSelection.mcps,
    includeOptIn,
    force: Boolean(force),
  };
};

const buildContext = async (args: Args): Promise<Context> => {
  const root = resolve(args.root ?? repoRoot());
  const repo = detectRepo(root, args.repo);
  const config = parseSimpleYaml(join(root, '.ai.yaml'));
  const source = resolveSource(args, root, config);
  const canon = loadCanonConfig(source);
  const manifest = loadManifest(source, repo);
  const base = {
    root,
    source,
    sourceLabel: config.canonSource ?? canon.sourceLabel ?? config.canon ?? source,
    repo,
    canon,
    prefix: `${canon.namespace}-`,
    manifest,
    generatedNotice: args.generatedNotice ?? config.generatedNotice ?? canon.generatedNotice ?? GEN_NOTICE_DEFAULT,
  };
  return { ...base, ...(await promptIfNeeded(args, base)) };
};

const doctor = (ctx: Context): number => {
  const skills = allSkills(ctx);
  const mcp = mergedMcp(ctx);
  console.log(chalk.cyan('ai-canon doctor'));
  console.log(`  root:      ${ctx.root}`);
  console.log(`  source:    ${ctx.source}`);
  console.log(`  canon:     ${ctx.canon.name} (namespace: ${ctx.canon.namespace})`);
  console.log(`  repo:      ${ctx.repo}`);
  console.log(`  skills:    ${skills.length}`);
  console.log(`  MCPs:      ${Object.keys(mcp.mcpServers).length}`);
  return 0;
};

const listSkills = (ctx: Context): number => {
  for (const skill of allSkills(ctx)) console.log(`${skill.name.padEnd(34)} ${(skill.isDefault ? 'default' : 'opt-in').padEnd(8)} ${skill.description}`);
  return 0;
};

const promptSkillSelection = async (
  ctx: Omit<Context, 'agents' | 'skills' | 'mcps' | 'includeOptIn' | 'force'>,
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
        ...allSkills({
          ...ctx,
          agents,
          skills: [],
          mcps: [],
          includeOptIn: true,
          force: false,
        }).map((skill) => ({
          value: skill.name,
          label: skill.name,
          hint: skill.description,
        })),
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
  ctx: Omit<Context, 'agents' | 'skills' | 'mcps' | 'includeOptIn' | 'force'>,
  agents: Agent[],
  skills: string[]
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

    const source = mergedMcp({
      ...ctx,
      agents,
      skills,
      mcps: [],
      includeOptIn: true,
      force: false,
    });
    const choices = await multiselect({
      message: 'Choose MCP servers',
      options: [
        { value: '__back__', label: '← Back to MCP mode' },
        ...Object.keys(source.mcpServers)
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

const writeIfAbsent = (path: string, content: string): boolean => {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
};

const initConsumer = async (args: Args): Promise<number> => {
  const root = resolve(args.root ?? repoRoot());
  let canon = args.canonUrl;
  if (!canon && !args.noInteractive && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await text({
      message: 'Canon repo (git URL or relative path):',
      placeholder: 'git@github.com:your-org/your-ai-canon.git',
    });
    if (isCancel(answer)) process.exit(0);
    canon = String(answer);
  }
  if (!canon) throw new Error('Pass --canon <git-url-or-path> (or run interactively).');
  const repo = args.repo ?? basename(root);
  const created: string[] = [];
  if (writeIfAbsent(join(root, '.ai.yaml'), `canon: ${canon}\nrepo: ${repo}\n`)) created.push('.ai.yaml');
  const gitignorePath = join(root, '.gitignore');
  const ignoreBlock = [
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
  ].join('\n');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!existing.includes('# ai-canon generated files')) {
    writeFileSync(gitignorePath, `${existing.replace(/\n*$/, '\n\n')}${ignoreBlock}\n`);
    created.push('.gitignore (appended)');
  }
  console.log(chalk.green(`Initialized consumer repo '${repo}'.`));
  for (const file of created) console.log(`  created ${file}`);
  console.log(`\nNext: run ${chalk.cyan('ai-canon sync')}`);
  return 0;
};

const initCanon = (args: Args): number => {
  const root = resolve(args.root ?? process.cwd());
  const name = args.repo ?? basename(root).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
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
  console.log(`\nRename manifests/example.json after your consumer repos, then in each consumer repo run:`);
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
  else if (args.command === 'doctor') code = args.check ? await install(ctx, true) : doctor(ctx);
  else code = listSkills(ctx);
  process.exitCode = code;
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
