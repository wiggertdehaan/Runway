# Contributing to Runway

Thank you for your interest in contributing to Runway! This document explains how to get involved.

## Code of Conduct

Be kind and respectful. We're all here to build something useful together.

## How to Contribute

### Reporting Bugs

Open an issue using the **Bug Report** template. Include:
- Steps to reproduce
- Expected vs actual behaviour
- Runway version (check the dashboard footer)
- Server OS and any relevant logs

### Suggesting Features

Open an issue using the **Feature Request** template. Describe the problem you're solving, not just the solution.

### Submitting a Pull Request

1. Fork the repository and create your branch from `develop`:
   ```bash
   git checkout -b feature/your-feature-name develop
   ```
2. Make your changes and add tests where applicable.
3. Run the checks locally:
   ```bash
   pnpm install
   pnpm typecheck
   pnpm --filter @runway/control dev
   ```
4. Commit with a clear message (we follow [Conventional Commits](https://www.conventionalcommits.org/)):
   - `feat: add invite flow for users`
   - `fix: correct health check interval`
   - `docs: update MCP setup instructions`
5. Open a pull request **against the `develop` branch** (not `main`). Fill in the PR template.
6. A maintainer will review your PR. All PRs require at least one approval before merging.

### Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Stable, production-ready releases |
| `develop` | Active development — target this for PRs |
| `feature/*` | Individual features branched from `develop` |

## Development Setup

Requirements: Node.js 24+ and pnpm.

```bash
git clone https://github.com/wiggertdehaan/Runway.git
cd Runway
pnpm install
pnpm --filter @runway/control dev   # Dashboard on http://localhost:3000
```

## Security Issues

Please **do not** open public issues for security vulnerabilities. Use GitHub's [private vulnerability reporting](https://github.com/wiggertdehaan/Runway/security/advisories/new) instead.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
