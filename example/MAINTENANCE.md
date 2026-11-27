# Maintenance review

Create small, responsibility-based chunks from the current repository. Name explicit paths,
related tests and contracts. Exclude dependencies, generated output and historical logs.

Include this policy in the campaign's shared instructions:

- Find duplication, unclear ownership, unnecessary machinery and costly test setup.
- Prefer deletion, direct control flow and existing capabilities. Preserve behavior.
- Check callers and tests before proposing removal; explain what coverage survives.
- Give each finding evidence, a small useful change, risks and validation for later.
- Keep uncertain ideas as investigations. No findings is a valid result.
- Respect repository instructions. Inspect read-only; do not implement, run tests or schedule work.
