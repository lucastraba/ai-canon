# ai-canon

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
  "sourceLabel": "github:acme/our-ai-canon",
  "generatedNotice": "GENERATED FILE. Do not edit directly. Run: ai-canon sync"
}
```

`namespace` is the safety boundary: every canon skill must be named `<namespace>-*`, and stale-skill cleanup only ever deletes directories with that prefix. Developer-owned skills are never touched.

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

- Generated files are local developer state: keep them gitignored (`init` sets this up). They may contain resolved secrets.
- Root agent config files (`.mcp.json`, `opencode.json`, …) are only overwritten when they contain the generated marker; otherwise sync refuses (override with `--force`).
- Stale generated skills are removed only inside the canon's namespace prefix.
- MCP servers with unresolved `${VAR}` placeholders are skipped and reported, never written.

## Local canon development

```sh
AI_CANON_SOURCE=../our-ai-canon npx ai-canon sync --no-interactive   # use a local checkout
AI_CANON_REF=origin/my-branch npx ai-canon sync                      # test a canon branch
```

`.ai.lock.json` records which canon commit/content generated the current files (audit only).

## Development

```sh
pnpm install
pnpm check   # typecheck
pnpm test    # e2e CLI tests
pnpm build   # bundle dist/cli.mjs
```

## License

MIT
