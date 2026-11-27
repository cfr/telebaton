# Telebaton starter project

A small Node project with no dependencies. Copy this directory to your own repository, or use
its documents as templates for an existing project. Requires Node 24 or newer.

| File | Purpose |
| --- | --- |
| `PLAN.md` | Small pending tasks with IDs, scope and acceptance checks. |
| `CHANGELOG.md` | Completed work, using the same task IDs. |
| `AGENTS.md` | Agent instructions for implementation, planning and review. |
| `MAINTENANCE.md` | Default policy for `/maintenance init`. |
| `telebaton.toml` | All three harnesses, role defaults, gate, commands and prompt overrides. |
| `.gitignore` | Keep generated logs and dependencies out of commits. |

Initialize the copied directory as a Git repository and commit its initial contents. Set
`agents.codex.model` in `telebaton.toml` to a model available to your account. In Telebaton's
separate `config.toml`, set `project` to this directory and enter your Telegram credentials.
See `config.example.toml` in the Telebaton repository for those settings.

The configuration defines Codex, OpenCode and Claude agents. Role defaults use Codex; change
them to mix harnesses, or select an alias directly, such as `/next glm` or `/review opus`.
Install and authenticate each harness you choose, and adjust its model ID to your account.
The optional `[prompts]` section lists every default; remove it to inherit Telebaton's defaults.

Run the gate locally:

```sh
npm run check
npm test
```

Then start Telebaton and try:

```text
/todo
/next 0002
/next 0003
/plan Discuss another small improvement
/maintenance init R01
/maintenance R01.01
```

Replace the sample tasks, gate commands and project rules when adapting this to your codebase.
Each pending task starts with `- NNNN-kebab-case-slug:` under `## Next`; indent its details by
two spaces. Keep IDs unique across the plan and changelog. Agents move completed entries to the
changelog and record actual validation there. `/plan done` writes and commits agreed new tasks.

`/verify` (also `/checks`) runs this project's gate as an explicit command. Deployment and
background-server command examples are commented out until you provide the corresponding scripts.
