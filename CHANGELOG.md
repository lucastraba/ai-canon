# Changelog

All notable changes to ai-canon are documented here.

## [0.2.0] - 2026-07-10

### Added

- Preflighted, atomic generated-file writes with complete `doctor --check` drift reporting.
- Structured ownership markers and safe cleanup for generated skills and scripts.
- Runtime validation for consumer YAML, canon metadata, manifests, skills, and MCP catalogs.
- Exact-minimum Node, Node 24, package-install, and CLI smoke coverage in CI.
- Tag-driven npm publishing with provenance and generated GitHub release notes.

### Fixed

- Confined manifest inputs and generated destinations against traversal and symlink escapes.
- Rebuilt cached canon checkouts when their origin changes and resolved advancing branch refs correctly.
- Prevented guard failures from leaving partial installations.
- Preserved executable helper-script modes and restricted generated MCP configuration to mode `0600` on POSIX.
- Separated interactive skill and MCP opt-in choices.
- Parsed `.ai.yaml` as YAML, repaired incomplete ignore blocks, and made repeated initialization honest.

### Security

- Redacted credentials from Git errors and lockfile source metadata.
- Refused secret-bearing generated configuration that is already tracked by Git.
- Preserved compatibility with legacy 0.1 ownership markers without accepting arbitrary marker substrings.
