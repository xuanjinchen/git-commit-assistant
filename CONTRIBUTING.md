# Contributing

## Scope

Contributions should improve the reusable Skill development scaffold, its deterministic Node.js commands, templates, validation, delivery gate, documentation, tests, or repository safety. Product-specific Skill behavior belongs in a repository initialized from this scaffold.

## Development

Use Node.js 22 or later. Install and verify without lifecycle scripts:

```bash
npm ci --ignore-scripts
npm run check
npm run audit
```

The default checks are deterministic and must not call hosted models or incur model costs. Add network or paid evaluation only as an explicit, opt-in workflow.

Write behavior tests before implementation changes. Keep commands cross-platform and use Node.js standard modules unless a dependency has a clear, reviewed benefit.

## Commits And Pull Requests

Use Conventional Commits, for example `feat: add a validation rule` or `docs: clarify initialization`. Keep each change focused and describe its compatibility impact and validation evidence in the pull request.

Before submission, run the checks above and inspect the complete diff for credentials, tokens, private paths, personal email addresses, customer data, and other sensitive information. Use neutral values such as `tester@example.invalid` in fixtures. Never commit real secrets, local state, logs, or evaluation workspaces.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) instead of the public issue tracker.
