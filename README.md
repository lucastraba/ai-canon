<p align="center">
  <img src="./assets/ai-canon-logo.svg" alt="ai-canon — one canon, every repo, every agent" width="760">
</p>

**One canonical repo for your team's AI agent customizations — synced into every repo, for every agent, on every OS.**

Define your *canon* once (skills, rules, MCP servers, helper scripts) in a single git repo. Each consumer repo declares which subset it wants via a manifest. Developers run one command and get native config for the agents they actually use:

| Agent | Skills | MCP | Rules |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/` | `.mcp.json` | — |
| Codex CLI | `.agents/skills/` | `.codex/config.toml` | — |
| Cursor | `.cursor/skills/` | `.cursor/mcp.json` | `.cursor/rules/<ns>-rules.mdc` |
| OpenCode | `.opencode/skills/` | `opencode.json` | — |

(For rules, lean on [AGENTS.md](https://agents.md): every major agent reads it now. ai-canon fills the gaps that are still tool-specific.)

## When to use this (and when not to)

Tools like [rulesync](https://github.com/dyoshikawa/rulesync) and [Ruler](https://github.com/intellectronica/ruler) solve **one repo → many agents** and support far more tools than ai-canon does. If your canon lives happily inside a single repository, use them. [Microsoft APM](https://github.com/microsoft/apm) covers multi-repo distribution too, as a full package ecosystem with manifests, lockfiles, and org governance; if you want packages from many sources across many agents, use that.

ai-canon is the small version of that idea, **one canon repo → many repos → many agents**, with a few safety behaviors the bigger tools skip:

- A central, versioned canon repo owned by your platform/AI-enablement folks
- Per-repo manifests: the backend repo gets backend skills, the frontend repo gets frontend skills, everyone gets the common set
- A CI-friendly drift check (`ai-canon doctor --check`) so repos notice when the canon moved
- Ownership safety: generated files carry a marker and are never silently overwritten if hand-authored; stale skills are cleaned up only within your namespace
- Secrets hygiene: `${VAR}` placeholders in MCP config resolve from the developer's environment; servers with missing values are skipped and reported, never written with unresolved placeholders

## Quick start

### 1. Author a canon (once per team)

```sh
mkdir our-ai-canon && cd our-ai-canon && git init
npx ai-canon init canon
git add . && git commit -m "our AI canon" && git push
```

This scaffolds:

```text
canon.json                  name, namespace, defaults
canon/
  skills/common/*.md        skills (SKILL.md format + frontmatter)
  mcp/common.json           MCP server catalog (${VAR} placeholders allowed)
  rules/common.md           rules content (for agents without AGENTS.md support)
  scripts/                  helper scripts installed to .ai/scripts/
manifests/
  <repo-name>.json          one manifest per consumer repo
```

The scaffold includes `manifests/example.json`. Copy it once per consumer repo and edit the selected content:

```sh
cp manifests/example.json manifests/your-app.json
# Edit "repo" to "your-app", then select the skills/rules/MCPs/scripts it needs.
git add manifests/your-app.json && git commit -m "add your-app manifest" && git push
```

The filename must match the consumer's `repo` value (normally its directory name).

### 2. Wire up each consumer repo

```sh
cd your-app
npx ai-canon init --canon git@github.com:your-org/our-ai-canon.git
git add .ai.yaml .gitignore && git commit -m "adopt ai-canon"
```

### 3. Every developer, any machine

```sh
npx ai-canon sync
```

Interactive on a TTY (pick agents, skills, MCPs); fully scriptable otherwise:

```sh
npx ai-canon sync --agent claude,cursor --no-interactive
npx ai-canon sync --agent codex --skill acme-test --mcp context7
```

A successful first sync is explicit about every local file it created:

```text
ai-canon [acme]: your-app -> claude, codex
Changes (5)
  created      .claude/skills/acme-test/SKILL.md
  created      .agents/skills/acme-test/SKILL.md
  created      .mcp.json
  created      .codex/config.toml
  created      .ai.lock.json
```

The canon is cloned/fetched into the repo-local, gitignored `.ai/.canon` on every run, so updating everyone is just `git push` to the canon repo; developers pick it up on their next sync.

### 4. Keep repos honest in CI

```sh
npx ai-canon doctor --check   # exit 1 if generated files drifted from the canon
```

## Concepts

### `canon.json` (canon repo root)

```json
{
  "name": "acme",
  "namespace": "acme",
  "generatedNotice": "GENERATED FILE. Do not edit directly. Run: ai-canon sync"
}
```

`namespace` scopes every canon skill name to `<namespace>-*`. Stale cleanup also requires ai-canon's structured ownership marker, so hand-authored skills are left alone; the marker lets owned cleanup remain correct if a canon deliberately changes namespace.

### Skills

Standard [SKILL.md](https://agentskills.io) files with a little extra frontmatter:

```markdown
---
name: acme-open-pr
description: Open a PR following Acme conventions. Use when the user says "open a PR".
agents: [claude, codex]        # optional, default: all
default: false                 # optional, opt-in skill (default: true)
requires-env: [GITHUB_TOKEN]   # optional, skipped + reported if missing
---

Instructions...
```

### MCP catalog

```json
{
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
    "jira": {
      "command": "uvx",
      "args": ["mcp-atlassian"],
      "env": { "JIRA_API_TOKEN": "${JIRA_API_TOKEN}" },
      "agents": ["claude", "codex"],
      "default": false
    }
  }
}
```

Placeholders resolve from the process environment or the gitignored `.ai.local/env`. Developers can add personal servers in `.ai.local/mcp.json`; they merge on top of the canon.

### Manifests (one per consumer repo)

```json
{
  "version": 1,
  "repo": "backend",
  "skills": ["common/*.md", "common/acme-jira-*.md", "backend/*.md"],
  "rules": ["common.md", "backend.md"],
  "mcp": ["common.json", "backend.json"],
  "scripts": ["open-pr/*"],
  "defaultAgents": ["claude", "codex"]
}
```

### Consumer `.ai.yaml`

```yaml
canon: git@github.com:your-org/our-ai-canon.git   # or a relative path
repo: backend          # manifest name; defaults to the directory name
canonRef: v1.2.0       # optional pin (tag, branch, or commit; default: remote default branch)
```

## Safety rules

- **Treat the canon repository as trusted code.** It distributes agent instructions, MCP commands, and executable helper scripts. Review canon changes like application code and protect who can push to it.
- Generated files are local developer state: keep them gitignored (`init` sets this up). They may contain resolved secrets. Sync refuses secret-bearing generated config that is already tracked by Git; remove it from the index with `git rm --cached <path>` before continuing.
- Every generated file carries a structured `[ai-canon:owned]` marker. Files at managed destinations—including skills, scripts, and root agent configs—are overwritten only when that marker (or a legacy 0.1 marker) proves ownership; otherwise sync refuses before changing anything. Override deliberately with `--force`.
- Stale skills are removed only when ownership is proven (legacy 0.1 files additionally require the current namespace prefix). Stale owned scripts are cleaned only under `.ai/scripts/`.
- Manifest paths are confined to their canon directories, and generated destinations are confined to the consumer repo. Absolute paths, traversal, backslashes, and escaping symlinks are rejected.
- MCP servers with unresolved `${VAR}` placeholders are skipped and reported, never written.
- Secret-bearing root MCP files are mode `0600` on POSIX. Git URLs are redacted in errors and lockfiles, but credentials should come from your Git credential manager rather than being embedded in URLs.
- Sync validates and plans the whole operation before writing. Guard conflicts make no changes; a later filesystem failure rolls the entire plan back, and individual file replacement is atomic.

## Local canon development

```sh
AI_CANON_SOURCE=../our-ai-canon npx ai-canon sync --no-interactive   # use a local checkout
AI_CANON_REF=origin/my-branch npx ai-canon sync                      # test a canon branch
```

`.ai.lock.json` records which canon commit/content generated the current files (audit only).

## Recovery and rollback

- Preview drift without changing files: `npx ai-canon doctor --check`.
- Inspect the configured source, manifest, pending changes, removals, and conflicts: `npx ai-canon doctor`.
- Roll back by setting `canonRef` in `.ai.yaml` to a known tag or commit, then run `npx ai-canon sync --no-interactive`.
- Return to the remote default branch by removing `canonRef` and syncing again.
- If a generated root config was intentionally replaced by hand-authored content, sync stops before modifying anything. Move personal MCP entries to `.ai.local/mcp.json`, or review the replacement and use `--force` once.
- If `.ai/.canon` is damaged, remove only that gitignored cache directory and sync again. ai-canon also replaces it automatically when the configured canon URL changes.

`doctor --check` reports writes, updates, removals, conflicts, and lockfile drift, and exits 1 whenever the next sync would change local state.

## Development

```sh
pnpm install
pnpm check   # typecheck
pnpm test    # e2e CLI tests
pnpm build   # bundle dist/cli.mjs
```

## Releasing

Maintainers configure the repository's `NPM_TOKEN` secret once, bump `package.json`, update `CHANGELOG.md`, and push a matching `v<version>` tag. The release workflow reruns checks, publishes with npm provenance, and creates GitHub release notes. A mismatched tag fails before publishing.

## License

MIT
