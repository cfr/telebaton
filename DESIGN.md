# Telebaton design

A Telegram bridge that drives the iteration loop (one agent implements, another reviews and
fixes) from one chat, so sessions no longer need manual renaming, exporting or switching between
tmux windows. Each project configures its own agents, verification gate and commands.
Status: prototype (see README "Status").

## Task ids

Every task has an id `<task-number>-<few-words-description>`, e.g. `0002-trim-names`:
the number is the `PLAN.md` "Next" item and the commit tag (`#0002`), the words are a short
kebab-case slug. The id names everything the task produces:

- agent session titles: `0002-trim-names` (implementation), `0002-trim-names
  feedback` (feedback checks), `0002-trim-names review` (review and fixes)
- logs: `wlog/<id>[-<step>]-<agent-log-name>.md` (see "Logs")
- commits: tagged `#0002` as `AGENTS.md` requires

The id is the PLAN item's heading (`0002-trim-names`); `/next` shows it with the item
text before work starts.

## Agents

Each project carries its own config in `telebaton.toml` at the repo root, next to `AGENTS.md`;
notes for humans are TOML comments. Commands pick an agent by name, or fall back to the role
default.
Legacy `CONDUCTOR.toml` is used when `telebaton.toml` is absent; role edits use the selected file.
`TELEBATON_CONFIG` overrides the local config path, falling back to the legacy `CONDUCTOR_CONFIG`
only when the new variable is unset.

```toml
[gate]
check = "npm run check"
test = "npm test"

[roles]
implement = "glm"
review = "opus"
plan = "opus"

[agents.glm]
harness = "opencode"
model = "zai-coding-plan/glm-5.3"
tag = "glm53"

[agents.ds]
harness = "opencode"
model = "deepseek/deepseek-v4-pro"
variant = "default"
tag = "deepseek4pro"

[agents.opus]
harness = "claude"
model = "claude-opus-5-5"
tag = "opus55"
```

- `harness` picks the adapter: `opencode` (model ids as `opencode models` prints them,
  `provider/model`) `claude` (Claude Code model ids or aliases), or `codex` (Codex CLI model ids).
- `effort` (optional, `claude` or `codex`) sets the harness effort level (`low` to `max`).
- `permission_mode` (optional, `claude` only, default `auto`): the Claude Code permission mode.
  SDK sessions would otherwise start in `default`, which asks for every write command, while
  interactive sessions run in `auto`. `bypassPermissions` is not accepted.
- `variant` (optional, `opencode` only) picks the model variant opencode offers (`default`, or
  e.g. `low`/`high`/`max` thinking); checked against opencode's model list when a session starts.
- `[prompts]` overrides the text sent at each step (`implement`, `review`, `fix`, `fix_notes`,
  `feedback`, `feedback_again`, `feedback_fix`, `continue`, `gate_failed`, `plan`, `plan_done`,
  `plan_read_only`, `plan_moved`, `chat`, `summary`; `example/telebaton.toml` lists the
  defaults); `{id}`, `{num}`, `{base}`, `{notes}`, `{step}`, `{output}`, `{findings}`, `{reply}`,
  `{topic}`, `{message}`, `{log}`, `{role}`, `{task}`, `{state}`, `{running}` and `{commits}` are
  filled in. `[logs] dir` sets the log directory (default `wlog`).
- `tag` names the model everywhere it shows: the suffix in `wlog/` file names (so existing
  names like `glm53` and `opus55` carry on) and the prefix of chat messages (`[glm53 0002]`).
- `[gate]` is the verification the bridge runs after each committing step, in order; a
  non-zero exit fails it.
- Machine-specific settings stay out of the repo, in the bridge's own gitignored
  `../telebaton/config.toml`: the project path, the bot token and the allowed Telegram user id.
- The bridge checks the config at start: unknown harness, an `opencode` model missing from
  `opencode models`, duplicate tags or a role naming an unknown agent are errors.

## Flow

The same loop as today, one command per step, with the bridge doing the bookkeeping:

1. `/next [agent] [id]`: the bridge reads the first `PLAN.md` "Next" item (or the given
   id), shows the id, the item text and the agent, and on confirmation starts a session with
   that agent (default `roles.implement`) titled with the id and the prompt `please do <id>`.
2. The agent implements and commits. When the session goes idle the bridge runs the
   verification gate itself (`[gate]` in `telebaton.toml`; here build followed by tests).
   - Gate fails: the bridge sends the failure output back to the same session once ("the gate
     failed, fix it: ..."), then runs the gate again. A second failure is reported and the
     task waits for me.
   - Gate passes: the bridge posts the commit title and body, the diff stat, the gate outcome
     and the agent's final message as text, and goes on to the
     feedback check (when configured) or straight to step 3.
   - Feedback (`roles.feedback`, one agent or a list, up to `[flow] feedback_rounds` times, default
     one per listed agent, 0 to skip): a cheaper agent checks the commits against a checklist (plan
     steps and their evidence, stale or rule-breaking comments, unsupported CHANGELOG claims,
     formatting and tests, provable bugs) and only reports, ending with `VERDICT: clean` or
     `VERDICT: findings`. Findings go to the implementing session, which fixes what holds, rejects
     the rest with a reason and commits; the gate runs and the next round checks the answer in the
     same feedback session, or, when the list names another agent for it, starts a fresh check with
     that agent. A clean verdict or an answer without commits moves on to the next listed agent, and
     to step 3 when none is left; so does the last round. Mechanical misses get fixed before the
     expensive review, and the code stays the implementer's: the checker never edits. `/feedback
     [agent]` runs one more round by hand.
3. Auto-review: when `roles.review` names an agent, the bridge starts a review session with `please review <id>`
   (the same context `AGENTS.md` gives an interactive session) and posts the findings.
   Reviewing does not touch the tree, so it needs no confirmation. `/review [agent]` starts or
   restarts a review by hand, e.g. with a different agent, or after a gate failure I fixed
   myself. An empty `review = ""` or omitted review role disables automatic review: the task
   completes after feedback and successful repair gates. `/review <agent>` remains available;
   `/review` without an agent explains that a manual reviewer must be specified.
4. `/fix` (optionally with notes, e.g. `/fix skip 3, item 1 can be a follow-up`): the reviewer
   applies the fixes in the same session and commits; the bridge runs the gate again (same
   one-retry rule) and posts the result. This step always waits for me, since it commits.

`/next [agent] NNNN..NNNN` confirms an inclusive range once. Every number must resolve to exactly
one item under PLAN.md Next; the bridge persists the remaining IDs and optional implementer
override in `state.taskQueue`. It rereads each queued item and current configuration before
starting it. Only task completion (clean final review, gated review repair, or completed feedback
when automatic review is disabled) advances the queue. Findings, incomplete reports, failed
turns, pending work and failed gates hold it on the current task. Queue advancement is serialized
so nested completion callbacks cannot start the same item twice.
Missing or duplicate queued IDs pause without replacing the saved queue. Diagnostics show the
queued ID, current entries at its number, any matching task name at another number, and commands
to inspect the revised plan, confirm a replacement range, or cancel. A plain `/next` retains the
original IDs; renumbered tasks require a newly confirmed range.

`/stop` pauses the queue before interrupting work; `/next` resumes it once the current task is
complete. Restart preserves the queue paused and does not start agents automatically. `/next
cancel` clears future tasks without interrupting current work. A confirmed explicit single-task
start replaces the queue. `/status` includes the remaining IDs and paused state.

`CHANGELOG.md` stays with the agents, as today: the implementing agent moves its item from
`PLAN.md` "Next" to `CHANGELOG.md` in its commit (`AGENTS.md` asks for that), and the reviewer
updates that entry with its fixes in the `/fix` commit. The bridge does not edit either file.

A turn that ends without a new commit (a question, or findings) is posted and waits; the gate
runs only after turns that committed. While an agent runs, other commands that would start a turn
are refused with the reason; questions from the running agent are still answered. The task-flow
lock also covers notifications and automatic transitions between gate, feedback, and review,
including a manually requested gate, so a new task cannot replace state during a handoff.

Any step can be followed by free text, which goes to the session that step talks to, so a
review can turn into a discussion before `/fix`. Logs are exported throughout (see "Logs").

Outgoing Telegram message calls retry network failures and API error responses up to eight times,
waiting 1, 2, 5, 10, 20, 30, 60 and 60 seconds. Rate-limit `retry_after` values extend the relevant
wait when necessary. The transformer handles raw unsuccessful API responses before grammY
converts them to exceptions. Long polling retains its own retry handling; unrelated errors and
cancelled requests are not retried.
Each request has a 60-second timeout. `sendDocument` retries only explicit 429 rate-limit
rejections: network and server errors leave delivery uncertain and must not cause automatic
duplicate uploads. `Chat.sendFile` catches Telegram delivery failures, archives the content under
`attachments/` beside the state file, and reports the failure to stderr with a best-effort text
warning. It returns without awaiting the warning. Only explicit `/diff` and `/log <path>` call `sendFile`; normal flow,
including gate failures, long reports and planning/config confirmations, never uploads files.
Unrelated programming errors still propagate.

## Commands

- `/next [agent] [id]`: start the next PLAN item (or a given one) with an agent from the
  config; arguments are told apart by shape (an id starts with digits)
- `/review [agent] [id]`, `/fix [notes]`, `/feedback [agent]`: as above, for the current task
  (`/review <id>` also takes a task done outside Telebaton)
- `/continue [role] [notes]`: resume a turn that stopped early (an error, `/stop`, a restart)
- `/skip`: interrupt and skip the current feedback step, then run the next checker or final
  review once pending work settles. The request survives restarts; completed skips are recorded
  in state and subsequent checker prompts. It cannot bypass implementation, pending repair
  dispositions, final review or the pending-work barrier.
- `/gate`: run the gate on the current session's commits by hand, then continue as after a turn
- `/todo [id]`: list the `PLAN.md` "Next" items, or show one in full
- `/plan [agent] [topic]`, `/plan done` (also `/plan stop`): a planning discussion (see below)
- `/maintenance init R01 [agent] [focus]`: generate a maintenance review campaign and chunk inventory.
  `/maintenance R01.01[-R01.05] [agent]` reviews chunks sequentially; `..` and `...` also work.
  `/continue maintenance`, `/stop maintenance`, `/maintenance status`, `/maintenance retry R01.01 [agent]`,
  `/maintenance edit R01 <notes>` and `/maintenance cancel` manage campaign revisions, retries and the queue.
- `/chat [new] [agent] <message>`, `/chat stop`, `/summary [role] [agent]`: see "Chat"
- `/agents`: list configured agent aliases and models
- `/usage`: read live account quota windows, reset times, and API balances independently of task
  work. Group aliases by harness/provider and query each account once. Codex uses an account-only
  app-server handshake with the managed CLI login; OpenCode provider readers reuse active exported
  keys and query the provider directly. Bound subprocess and HTTP waits; concurrent commands share
  a request, with fresh data on the next command. Omit missing periods, missing reset times, and
  Claude Code agents. Show other unsupported/error states explicitly, isolate provider failures,
  and never forward credentials or raw error payloads. No inference,
  session mutation, persisted quota cache, or task-log entry is involved.
- `/roles [role agents...]`: show defaults and current assignments, or edit one default in the
  tracked `telebaton.toml` when no task or session is in progress. Show the diff and offer
  commit / keep / discard; commits include only that config file. Scalar roles take one alias,
  feedback takes an ordered list. `/roles review ""` disables automatic review.
  Kept role-only edits accumulate across commands and restarts;
  committing a later edit commits the whole batch, while discard undoes only the latest request.
  Reject unrelated config changes. Preserve unrelated config, comments and explicit flow settings.
- `/agent <alias>`: hand off the current task's focused role without changing defaults. Stop the
  old session and its owned work; preserve task/finding/gate metadata and the working tree. Wait
  for live or queued work, but transfer terminal child results with their failure status. Persist
  the pending handoff across restarts, archive the old session, and prepare context for the next
  `/continue`. No model turn starts at swap time. Unexpected retired-session resumes are stopped
  and require a fresh verification gate. Current assignments show `old -> new`; feedback defaults
  remain space-separated.
- `/swap <agent1> <agent2>`: exchange exactly one assignment for each alias, including individual
  feedback positions. Count effective inherited roles when checking uniqueness; reject unknown,
  missing or multiply assigned aliases. Use the same idle checks and single diff/confirmation as
  `/roles`, preserving unrelated configuration and accumulated kept role changes.
- `/status`: current task, step, which agent is running, last gate result
- `/stop [chat|plan]`: interrupt the running agent (or the chat, or the planner)
- `/abort [task|maintenance]`: stop owned work, abandon the session and clear its queue. Tasks
  restore the checkpoint captured before `/next`; maintenance retains completed campaign reports.
  `/abort cancel` cancels only before rollback begins.
- `/log [path]`: export/list the current sessions, or attach a saved file from project logs,
  command logs or attachment backups. Resolve canonical paths to reject traversal and escaping symlinks.
- `/<name> [args]`, `/<name> stop`: project commands from `[commands]` (see README)
- plain text: goes to the agent of the current step; a Telegram reply to an agent's message goes
  to that message's session, whatever the current step is

## Abort and rollback

`state.taskCheckpoint` records the starting branch/HEAD, index tree, working tree (including
non-ignored untracked files), protected log/state directories and commits observed during task
turns. A temporary Git index captures working files without changing the user's staging area.
Checkpoint commits are reachable through `refs/telebaton/checkpoints/`. Commits made outside task
turns remain distinguishable, so abort can refuse a rollback that would remove unrelated work.

`state.abort` persists the stopping, resetting and discarding phases. New task/planning work and
automatic transitions are blocked until abort finishes or is cancelled before resetting. Agent
turns, descendant jobs and the managed `_gate` process group must settle first; unknown status
holds the barrier. Gates run through `Jobs` so abort and shutdown reach their descendants.

Before rollback, export/archive task evidence and save a recovery snapshot under
`refs/telebaton/aborts/`. Reset HEAD, restore working files and then restore the original index;
remove only new non-ignored untracked files. Keep logs, ignored output and side sessions. Save the
expected HEAD so restarting a partial rollback cannot silently remove later manual commits.
Provider/session cleanup is idempotent and resumes without another model turn. Remember discarded
session IDs to interrupt unexpected resumes; canonical findings are cleared for a fresh task run.

Maintenance abort stops and discards its current session/queue. Its source snapshot, campaign and
successful reports remain available. No implementation rollback runs in that path.

## Maintenance discovery

`MaintenanceFlow` owns one read-only campaign-generation/review session at a time, sharing the
task-flow busy lock without replacing task state. Campaign manifests live at `<logs>/R01.md`;
chunk headings such as `R01.01` identify independent scopes. The first review freezes the
manifest and HEAD, prepares a detached worktree beside the state file, and saves a tracked-file
inventory. All reviewers reuse that snapshot; discovery prompts never include peer reports.
Generation runs before that freeze and supports conversational revisions saved by the orchestrator.
When present, project-root `MAINTENANCE.md` supplies the default generation template. Its text
is captured in the generation attempt and appended independently of configurable prompts, along
with command focus. Edits and resumed generation reuse that captured text. The generator adapts
reviewer policy inline into the campaign; later discovery sessions need no live-template access.

`state.maintenance` stores campaigns, selected baseline/scope, resolved agent configurations, a
sequential range queue, the active attempt, and archived attempts. Each attempt records session,
cwd, timing, pending work, outcome, reply and artifact paths. This is separate from task queues,
gates and the feedback ledger. Agent sessions remain read-only; the orchestrator publishes a
report only after successful completion, owned work settling, and validation of the required
sections/completion marker. Original replies, transcripts, usage and completed attempts remain
available when a review is retried. Provider failures are never silently substituted or retried.
Telegram receives deterministic previews extracted from Markdown: campaign overview, range and
chunk titles, or review summary and finding titles. Detailed evidence and scopes stay in the
artifacts; no additional model call is needed for a preview. New prompts request a short Summary
section and stable item headings, with fallbacks for older reports. Maintenance prompts are kept
in transcripts rather than echoed to Telegram. The queue preserves its original selected IDs
alongside remaining IDs so notices retain the full range and current position after resume.

Stop and failures pause the queue. Startup pauses it too, recovers the active turn through the
adapter, and captures a missed completion without another model call. Unknown status holds the
work barrier. `/continue maintenance` resumes the current attempt; `/maintenance retry` creates a fresh
attempt; `/maintenance` resumes the queue. The normal planner reads resulting reports, reconciles
them with current code, and schedules only at the user's explicit request.

## Logs

Export is automatic: the bridge rewrites the session's log file every time the session goes
idle, so `wlog/` is always current, even for a task that is abandoned halfway. The file name:

    wlog/<task-id>[-<step>]-<tag>.md

- `<step>` is empty for the implementation session, `feedback` for the feedback checks,
  `review` for review and fixes, and
  `review-plan` when the review session also edited `PLAN.md` (a `/plan` discussion inside
  the review, which is what `-review-plan-` means in today's names). A `/plan` session
  writes `wlog/<task-id>-plan-<tag>.md`, or `wlog/plan-<date>-<topic>-<tag>.md` when there is no
  current task; `/chat` writes `wlog/<task-id>-chat-<tag>.md` (`chat-<date>-<tag>.md`). A new
  chat or planning session whose name is taken gets a `-2`, `-3`, ... suffix.
- `<tag>` is the agent's `tag` from the config.
- A second session for the same step (a review restarted with another agent) gets its own file
  through its different suffix; a restart with the same agent overwrites the file, and the
  bridge says so.

All harness transcripts are rendered by the bridge into one common Markdown shape:

    # <session title>
    **Session ID:** ... **Created:** ... **Updated:** ... **Tokens:** ...
    ## User / ## Assistant blocks, _Thinking:_, **Tool: <name>** with **Input:** (json)
    and the tool output; each ## User starts with its turn's **Turn tokens:**

- opencode: `opencode session export <id>` (or the server's export endpoint) gives the full
  session as JSON; the renderer turns it into the format above, so GLM logs look as they do now.
- Claude Code: the session transcript `~/.claude/projects/<project>/<session-id>.jsonl` has the
  same content (user and assistant messages, thinking, tool use and results, timestamps,
  custom title). The renderer reads it into the same format.

This changes how Opus logs look: today's are Claude Code's `/export`, a plain-text screen
render with collapsed tool calls ("Searched for 4 patterns ..."). The new ones are markdown
with every tool call and its input expanded, like the GLM logs: larger files, but greppable and
the same layout for every agent. Long tool outputs are cut to a configurable number of lines
(full output stays in the agent's own session store). Not implemented yet: the prototype keeps
full outputs, as opencode's export does.

The review step becomes `review-plan` when `PLAN.md` differs from the commit the review session
started at (committed or not); the file is renamed on the next export.

## Finding ledger and verification evidence

The bridge appends validation guidance, prior finding dispositions and gate evidence even to
project-overridden prompts. `src/feedback.ts` owns these contracts and the handoff context;
`src/findings.ts` validates reports and keeps one atomic JSON ledger per task beside bridge state.
Reports use fenced `telebaton-feedback` JSON; repair replies use `telebaton-dispositions` JSON.
The parser also accepts legacy `conductor-feedback` and `conductor-dispositions` fences, counting
both naming schemes together when enforcing a single block. Review handoffs recognize either
name so existing threads can finish after an upgrade; new prompts use Telebaton names.
Malformed replies remain pending and get one automatic correction turn, then the flow waits.

Stable finding IDs, category, source agent/model/role/session/SHA, evidence, related/duplicate links,
repair dispositions and actual fixing commits survive session replacement. Claimed fixes and
checker verification are distinct; a verifier must use another session and a SHA containing the
fixes. New checkers see rejection reasons so they can assess them rather than repeat paperwork.
Prompts list required pending fix IDs separately from duplicate-to-original mappings. Only
`duplicateOf` chains are followed; `relatedTo` fixes keep independent verification requirements.
Duplicate IDs are omitted from verification entries, and the parser rejects any such entry with
the original ID and correction instructions. Exported summaries say verification follows the
original ID without changing the duplicate's stored verification state or transferring evidence.
When configured, final review also verifies the last feedback repair. With automatic review
disabled, a repeated final feedback agent can verify its preceding repair; repairs after the last
configured round remain verification-pending. Findings fixed by `/fix` remain unverified until
another review assesses them. Ledger receipts are retained and replayed reports are
idempotent. `wlog/<task>-findings.md` exports the ledger and links to the original session logs.

The bridge records gate commands, SHA, time, result and full output in `wlog/<task>-gate.log`.
Checkers use focused experiments and the bridge's evidence, avoiding redundant full runs on an
unchanged tree. Regression-test sensitivity, real caller paths and maximum supported bounds are
explicit prompt requirements; the bridge cannot establish their adequacy from a green gate alone.

Each session export has a `.usage.json` companion with exact totals and turn indices. Codex CLI
usage is turn-aggregate data: it cannot establish model-step counts or maximum single-request
context, so those measurements are marked unavailable rather than inferred from aggregate input.
Old saved Codex sessions are normalized on resume; raw CLI usage is retained when available.

## Pending work barrier

`AgentSession.pendingWork()` covers background shell jobs, subagents and undelivered work. The
opencode adapter discovers background `subagent` tool results through paginated assistant messages,
using their structured session metadata. Inline results acknowledge foreground children without
requiring a synthetic notification. It recursively checks descendants, durable synthetic completion
metadata and inbox entries. Completion is acknowledged only after a new parent assistant
request follows the notification and the parent becomes idle. Final active-session/inbox/time
checks catch resumes racing the transcript reads.
Assistant-message errors are cached with the scan cursors so failed children retain their provider
error, status and message across restarts. Turn failures are announced before the pending-work
return path, with a persisted notice to avoid duplicate polling alerts. Failure reporting does
not release the barrier or automatically retry quota-limited sessions.
Explicit parent prompts include unhandled descendant failures and persist a receipt only after
OpenCode accepts the prompt. A later successful, idle parent response acknowledges those exact
failed executions without requiring a missing synthetic completion. Receipts bind the child idle
timestamp and error message ID to the delivered parent message ID, survive restarts, and cannot
acknowledge a reused child's new failure. Active sessions, inboxes, shell jobs and racing resumes
still hold the barrier. Rejected prompts and failed parent turns do not acknowledge failures.

OpenCode interruption also removes shell jobs owned by the parent and discovered descendants in
the project location, then interrupts the parent again to catch cleanup-triggered resumes.
`/stop` targets a waiting session even without an active model turn. Polling pauses during stop
cleanup, and interrupted waits cannot automatically advance after the jobs exit. Subagent and
inbox checks still apply; cleanup does not infer completion from missing shell jobs alone.

Discovered child IDs, tool IDs, notification receipts and scan cursors persist with the session.
Telebaton retains a waiting turn and its gate retry budget, serializes wakeups, and rechecks every
two seconds without prompting the model. Status errors hold the barrier instead of implying idle.
Startup rediscovers pending work even if the previous process missed the resume event. New tasks,
checkers and gates cannot replace or advance a waiting session; explicit continuation of that same
session is still possible. Read-only chat remains independent.

Unexpected overlapping task phases set a persistent verification conflict. Their outcomes cannot
advance the automatic flow until pending work clears and an explicit successful gate verifies the
current tree, then starts the feedback sequence afresh. Shell/subagent inspection is implemented
for opencode; adapters without detached-work notifications currently report no additional work.

## Agent questions

Agents block in two ways and both must reach the chat:

- **Structured questions and permission prompts.** Opencode's server streams permission
  requests as events; Claude Code (through the Agent SDK) calls back on `AskUserQuestion` and
  on tool permissions. The bridge posts these with inline buttons (the offered options, or
  allow/deny) plus "answer in text"; the agent waits until I answer. No timeout: a forgotten
  question just keeps the task in a waiting state, which `/status` shows.
- **A question at the end of a turn** ("should I also ...?"). The session goes idle with a text
  reply; the bridge posts it marked as a question-or-done message and my next plain text (or a
  reply to it) continues that session. A question at the end of the implementation turn holds
  the gate and auto-review until I answer or send `/review`.

Every agent message is prefixed with the agent tag and task (`[glm53 0002]`, `[opus55 0002]`) so
one chat stays readable.

## Chat

`/chat [new] [agent] <message>` opens or continues a read-only session for questions about the
project while a task runs: Claude agents run it in plan mode (with `ExitPlanMode` and the edit
tools refused; the refusal asks for the plan in the reply, since nobody sees it), opencode agents
with its read-only `plan` agent, and its first message says another agent may be changing the
tree. It has its own busy flag, so it never waits for or blocks the task flow, and it is not reset
by `/next`. Replies to its messages reach it; plain text keeps going to the task.

`/summary [role] [agent]` asks how a session is going without disturbing it: Telebaton exports
that session's log as it stands (the running one by default, else the focused one), and a fresh
read-only session of `roles.summary` (default: the chat agent) reads it from the end and answers
in a few bullets. The summary session is one-off: not kept in state, not logged, not resumed.

## Planning discussion

`/plan [agent] [topic]` opens a session (default `roles.plan`) that may read the repo and edit
only `PLAN.md` (no code). It commits on `/plan done`, or when asked to in plain text; the bridge
handles both the same way. The conversation runs in the chat like any other session.
Every planning turn carries explicit PLAN.md-only validation guidance, including continuations and
custom prompts: format/check the Markdown and inspect its diff; builds, test suites and the full
gate require an explicit user request. General end-of-iteration gate rules do not apply.
`/plan done` asks the agent to write the agreed items into `PLAN.md` and commit it (the agent
knows what changed and follows the project's commit rules); the bridge posts the commit message
and diff, warns if the commit touches more than `PLAN.md`, and offers keep / undo commit (`git
reset --keep`, only while HEAD is still that commit).

The session runs beside the task flow and survives `/next`. While a task runs (any turn, the gate,
the steps between them, or a session waiting on its background jobs), a planning turn is read-only
(Claude plan mode with edit tools refused, opencode's `plan` agent), its message starts with
`plan_read_only`, and `/plan done` is refused: the implementer moves its item out of `PLAN.md`
and commits the tree, so the two must not edit it at once. A planning turn after other commits
landed starts with `plan_moved` (their list), so the agent re-reads `PLAN.md` before going on.

## Shape

- A small, deterministic bridge process (not an LLM session): Telegram long-polling, the agents
  config, a state file (current task, step, session ids, agent per session), and one adapter per
  harness. It relays and runs commands; it never paraphrases agent output.
- Telegram credentials (`[telegram] token`, `allowed_user_id`) live in the bridge's
  `config.toml`. Telegram allows one `getUpdates` poller per token (a second gets `409
  Conflict`). Stop other processes polling the same token before starting Telebaton.
  Independently running bots need separate tokens.
- `opencode` adapter (v2 HTTP API): turn end is `session.execution.{succeeded,failed,
  interrupted}` on `/api/event`, with a `GET /api/session/{id}` poll as fallback; questions are
  `permission.asked` and `form.created`. It talks to the shared background service (`opencode service start`,
  `http://127.0.0.1:49374`, password from `opencode service get password`), not a private
  `opencode serve`, so bridge sessions also show up in the TUI.
- `claude` adapter: Claude Code via the Agent SDK, one `query()` per turn (`sessionId` on the
  first, `resume` after), with the `claude_code` system prompt preset and the agent's
  `permission_mode` (`plan` for read-only turns). `canUseTool` receives permission prompts and
  `AskUserQuestion`, whose answers go back as `updatedInput.answers`.
- tmux stays useful for watching: the bridge runs in a pane, and sessions can still be resumed
  locally from their ids.

## Rules the bridge enforces

- Only `telegram.allowed_user_id` is accepted; everything else is ignored.
- One agent writes to the tree at a time (the "no edits during parallel agent" rule as a lock);
  a step that would overlap is refused with the reason. Auto-review starts only after the
  implementation session is idle and its gate run is done.
- Agents never push or deploy from the bridge. Project commands (`[commands]` in `telebaton.toml`,
  e.g. `/deploy`, `/serve`) run only when I send them, with a confirmation button where
  `confirm` is set, and a one-shot command never overlaps an agent turn or the gate.
  Both command types retain process-group ownership through stop cleanup, escalating to SIGKILL
  for surviving descendants. One-shot commands are tracked for shutdown and crash recovery too.
  Background starts reserve their name before confirmation or notification awaits; job cleanup
  removes only the matching job. Telegram routing preserves the configured letter/digit/underscore
  command names and aliases. Explicit `/stop plan` and `/stop chat` never target another role.
- The bridge's own gate run is the result it reports, not the agent's claim.
- Long messages keep the first two chunks and the ending, including the verdict, with a hint to
  `/log` for full local session logs. Gate and command output is posted as a code block cut to its
  newest lines; messages stay under Telegram's 4096-character limit. `/diff [hash]` explicitly
  requests the task's committed changes (implementation/review start to a captured HEAD), or one
  commit patch when a hash is supplied. Without a task it defaults to HEAD's patch. It does not
  mutate task state or require an idle agent; hashes are validated and resolved before upload.

## Open questions

None right now.

Codex usage is the delta between successive raw cumulative thread counters, including across
resume and Telebaton restarts. Exports normalize legacy records idempotently, retain raw snapshots
and their provenance, and mark counter resets as new epochs. The historical rebuild tool updates
idle saved sessions and matching log usage without changing transcript content.

Codex uses `codex exec --json`, persists its thread id and event transcript beside Telebaton state,
and uses `exec resume` for follow-up turns. Sandbox policy is set on every turn (read-only or
workspace-write). Writable turns route on-request approvals through Codex auto-review so Git
operations can be approved; read-only turns deny escalations. Exec cannot relay approvals to Telegram.
The adapter owns every created or resumed session and stops its process groups on shutdown.
Each running group is persisted with its PID and process birth identity. A live recovered group
counts as running and pending work, preventing a second writer; interruption checks ownership
before signalling it. An unverifiable identity fails closed. Once stopped, follow-up turns resume
the saved thread. OpenCode prompt submission failures cancel their completion waiter and poller;
an older completion poll cannot remove a newer waiter for the same session.
See README "Codex" for setup and lifecycle limits.
