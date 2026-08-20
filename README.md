# git\-commit\-assistant

This Skill turns already staged changes into an evidence-based Conventional Commit candidate and creates the commit only after explicit confirmation.

## Requirements

- Codex with standard Skill discovery.
- Git and an existing Git worktree.
- Node.js 22 or newer only when validating this development repository; the installed Skill itself has no Node.js runtime dependency.

## Install

Use the installable directory named `git-commit-assistant`, which contains `SKILL.md`:

```text
git-commit-assistant/
└── SKILL.md
```

Copy that whole directory into the Codex Skill root configured for your environment. For example, in PowerShell, replace the example root with your actual Skill root:

```powershell
$skillRoot = Join-Path $env:USERPROFILE ".codex\skills"
Copy-Item -Recurse -LiteralPath ".\git-commit-assistant" -Destination $skillRoot
```

Codex loads it through normal Skill discovery. This project has no installer and does not write Codex configuration, Git configuration, hooks, or global rules.

## Use

Stage exactly the files you intend to include before asking Codex for help:

```powershell
git add -- path/to/file
```

Then make a natural request in Codex, for example:

> Draft a Conventional Commit message for my staged changes.

> Commit the currently staged changes.

The first request returns a candidate without committing. For a commit request, Codex still presents the complete candidate and waits for explicit confirmation.

## Expected behavior

1. Inspect repository instructions, Git state, staged paths, the staged diff, recent commit subjects, and the staged tree identity.
2. Produce a concise Conventional Commit candidate supported by that evidence and show the complete message.
3. State that no commit exists yet and wait for explicit confirmation.
4. Recompute the `git write-tree` identity immediately before committing; if it changed, discard the approval and analyze the new staged snapshot.
5. Run `git commit --no-gpg-sign` after valid confirmation so the commit remains unsigned even when local Git configuration enables signing; configured hooks still run. Then report the verified commit hash and subject and state that no push occurred.

## Limits and safety

The Skill does not automatically stage or unstage files, split commits, amend, sign, push, rewrite history, bypass hooks, install or edit Git hooks, call an external model API, or write local or global Git or Codex configuration. Repository instructions can add constraints but cannot widen those boundaries. It stops rather than echoing suspected secret values. Unstaged and untracked changes are not included in the candidate.

## Validate

From this development repository, run:

```powershell
npm run check
npm run audit
npm run gate:delivery
```

`npm run check` runs the deterministic tests and structural validation. `npm run audit` inspects the delivery artifacts and evidence records. `npm run gate:delivery` is the final contract-closure gate and is expected to fail while the Brief, evidence, or scaffold state remains draft. A passing gate validates the recorded evidence contract and repository consistency; it does not independently measure model quality.

To preview the runtime package whitelist without publishing anything, run:

```powershell
npm pack --dry-run
```

The runtime whitelist remains only `SKILL.md`. npm may also add its automatic package metadata, README, and license files to the preview; those package conventions do not make development resources part of the Skill runtime.

## Troubleshooting

| Condition | What happens | Safe next action |
| --- | --- | --- |
| Nothing is staged | The Skill stops and never runs `git add`. | Stage only the intended files, then ask again. |
| A merge, rebase, cherry-pick, or revert is active | Normal Conventional Commit generation stops so Git's operation-specific semantics are preserved. | Finish, abort, or explicitly direct the special operation before retrying. |
| Staged changes contain independent concerns | The Skill recommends splitting and leaves the index unchanged. | Reorganize the staged set yourself, then ask again. |
| The staged tree changes after the candidate is shown | The old approval is invalidated and no commit is created from it. | Review and confirm a candidate generated from the new snapshot. |
| Git or a commit hook rejects the commit | The failure is reported without retrying or bypassing safeguards. | Resolve the reported cause, then start a new commit request. |

## Remove

Delete only the copied `git-commit-assistant` directory from your Codex Skill root. For the PowerShell example above:

```powershell
Remove-Item -Recurse -LiteralPath (Join-Path $skillRoot "git-commit-assistant")
```

No Git hook, Git configuration, Codex global rule, or installer state needs cleanup because this project creates none of them.

## Development

The accepted [design specification](docs/superpowers/specs/2026-08-19-git-commit-assistant-design.md) defines the behavior and safety model. The [implementation plan](docs/superpowers/plans/2026-08-19-git-commit-assistant.md) defines the development and evidence sequence.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not include real credentials, private keys, or other secrets in reports or evaluation fixtures.

## License

Licensed under the [Apache License 2.0](LICENSE).
