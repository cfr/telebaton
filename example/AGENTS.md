# Project instructions

- Keep changes small and follow the existing code style. Preserve behavior outside the task.
- For a PLAN task, implement its scope and acceptance checks. Add tests for changed behavior.
- Run `npm run check` and `npm test` before an implementation commit. Telebaton also runs this
  gate after commits; use its recorded result when reviewing an unchanged tree.
- Move a completed task from `PLAN.md` to the top of `CHANGELOG.md` under `## Completed`.
  Keep its ID and summarize the actual change and validation. Never renumber existing tasks.
- Include the task number in implementation commit subjects, for example `#0002 Trim names`.
- Planning starts with discussion. Edit only `PLAN.md` when asked; commit it only when requested.
  Planning-only validation is diff inspection, not the implementation gate.
- Review and maintenance sessions inspect read-only. Report evidence and uncertainty; apply fixes
  only when explicitly asked. Maintenance runs do not execute tests or schedule implementation.
