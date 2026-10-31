# Coverage: dsh-jiuwen-adapter vs JiuwenSwarm 0.2.7 Gateway

Audit date: 2026-10-30 (UTC+8). Recounted after Round 5 (channels conf, rsi reads, personal_context reads, skills hub reads, marketplace/extensions toggles, project rename/pin, harness.packages). Round 4 (skills files/retrieval/graph/evolution/experience, template/group files, packages, extensions, vendors, openai_account, health_check, project pinned/cron/git turns, assets.publish reads, mcp.cancel_connect, permissions.tools.set, heartbeat.job.update). Prior: Round 3. Source of truth: `jiuwenswarm/gateway/channel_manager/web/app_web_handlers.py` (`_FORWARD_REQ_METHODS`, `_FORWARD_NO_LOCAL_HANDLER_METHODS`, every `register_method` / `_register_*` / tuple table) + `web/lifecycle_handlers.py`, in `/workspace/jiuwen-0.2.7/.venv`. TUI-only = strings in `channel_manager/tui/` not routed by the web channel.

## Summary

| Bucket | Count |
|---|---|
| Web `/ws` methods (total) | 334 |
| Covered by adapter | 172 |
| Intentionally excluded (irreversible / credentials / host side effects) | 99 |
| Uncovered | 63 |
| TUI-only (not reachable on /ws) | 35 |

- Raw coverage: 172/334 = **51.5%** (was 138/334 = 41.3%; 106/334 = 31.7%; earlier 63/334 = 18.9%)
- Coverage of the safe surface (total minus excluded): 172/235 = **73.2%** (was 138/235 = 58.7%)
- Deletes moved from excluded to covered behind an explicit `confirm` argument: `cron.job.delete`, `heartbeat.job.delete`, `permissions.rules.delete`.
- `schedule.*` (7) are wired but stay uncovered: live 0.2.7 `/ws` answers `unknown method`; the feature-detect cache hides them.

Adapter calls that 0.2.7 `/ws` does **not** route (live probe → `unknown method`): `command.recap`, `files.list`, `history.list_turns`, `memory.list`, `memory.status`, `models.get`, `session.assets.list`, `team.list`. These are 0.2.5b1-era / TUI-only paths; `/jiuwen recap`, `assets`, `model-info`, `teams` rely on fallbacks or return an error text on 0.2.7.

Live probe 2026-10-30 (P1–P3, UTC+8): every newly covered method answered on :19000 except `schedule.*` (unknown method → soft-fail, hidden) — `project.git.*` reach the handler but the default project has git disabled; `models.validate` needs an api_key the adapter never passes; writes were reversed (cron job created disabled → toggled → deleted; permission rule added → updated → deleted; document persisted → `media.discard`; throwaway chat session deleted).


Live probe Round 5 (2026-10-30, UTC+8): full `/jiuwen` regression through Cordis Context + `api.command` + one `ctx.llm.stream` chat turn — 148 checks, 134 clean, 14 Gateway-side errors surfaced as `Jiuwen: …` (unknown method: `command.recap`, `schedule.list`, `issue.*`; not-found ids; default project cannot be renamed/pinned; `models.validate` needs api_key). No secret leaks. Every write reversed; state identical after.

Live probe Round 4 (2026-10-30, UTC+8, Cordis Context + `api.command`): 26 ok + 6 soft-fail (retrieval tree unsupported, graph not built, git disabled on default project, assets.publish AUTH_REQUIRED) + 0 fail; heartbeat create→update→delete reversed; Gateway state identical after (20 sessions, 0 cron, 43 tools, 37 rules, heartbeat conf, empty user_permissions overlay). `vendors.fetch_models` never passes `api_key` (preset fallback). `mcp.wait_auth` not mapped (holds RPC open for minutes). `permissions.tools.set` is bulk user-overlay replace (needs `confirm`); single-tool edits stay on `permissions.tools.update`.

Earlier live probe (ws://127.0.0.1:19000/ws, empty params, read-only): routed ok: `models.list`, `permissions.tools.get`, `permissions.rules.get`, `session.archived.list`, `config.get`; `permissions.rules.update` and `tts.synthesize` reach validation (routed). Unknown on /ws: the 8 above plus `command.context`, `command.status`, `session.preview`, `memory.open`, `session.color_set`.

## Uncovered by area

| Area | Methods | Usefulness |
|---|---|---|
| skills | 12: `skills.clawhub.download`, `skills.create_from_knowledge`, `skills.evolution.save`, `skills.experience.request`, `skills.graph.build`, `skills.graph.cancel`, `skills.rebuild`, `skills.retrieval.index_build`, `skills.retrieval.index_cancel`, `skills.skillnet.evaluate`, `skills.skillnet.install_status`, `skills.teamskillshub.validate` | hub search/detail/recommend/info + marketplace toggle covered; builds/downloads remain |
| personal_context | 13: `personal_context.context.stream_graph`, `personal_context.context.stream_tree`, fetch create/patch/start/stop/run_one/stop_run, runtime select_model/start_*/stop_* | search/node/source/auth/run-status reads covered; service & runtime mutations remain |
| project | 3: `project.create`, `project.restore`, `project.sessions.archive` | pin/rename covered (default project refuses both) |
| channel | 0 | conf reads covered (secrets masked); set_conf excluded |
| rsi | 2: `rsi.artifact.download`, `rsi.harness.rollback` | task/report/tree/usage/versions/artifact file reads covered; download + rollback remain |
| heartbeat | 0 | create/toggle/run/cancel/delete/update covered |
| schedule | 8: `schedule.cancel`, `schedule.check_config`, `schedule.create`, `schedule.list`, `schedule.logs`, `schedule.run`, `schedule.status`, `schedule.update_config` | schedule list/status/logs — useful read-only |
| cron | 0 | create/toggle/run/update/delete covered |
| agent_groups | 1: `agent_groups.create` | list/show/file reads covered; create remains |
| agent_templates | 2: `agent_templates.create`, `agent_templates.update` | list/show/file reads covered; create/update remain |
| permissions | 0 | tools get/update/delete/set + rules + overrides/scopes covered |
| team | 3: `team.binding.create`, `team.binding.generate`, `team.session.bind` | team.history.get, snapshot, bindings generate — history useful |
| agents | 4: `agents.create`, `agents.disable`, `agents.enable`, `agents.update` | agent create/update/enable/disable — config mutations |
| assets | 0 | publish describe/status/records/local_status covered (Hub AUTH soft-fails) |
| harness | 3: `harness.activate`, `harness.deactivate`, `harness.packages.scan` | packages read covered |
| issue | 3: `issue.matrix`, `issue.state.list`, `issue.watch_once` | matrix/state wired but unknown on 0.2.7; watch_once not mapped |
| mcp | 1: `mcp.wait_auth` | show + cancel_connect covered; wait_auth holds RPC open (not mapped) |
| plugin_packages | 1: `plugin_packages.create` | list/show covered; create remains |
| config | 1: `config.validate_model` | config.get/validate_model — read config, useful for /jiuwen config |
| extensions | 0 | list + toggle covered |
| memory | 1: `memory.compute` | memory.forbidden.get read |
| models | 1: `models.replace_all` | models.validate/defaults — validate useful |
| openai_account | 0 | auth.status + models.list covered |
| vendors | 0 | list + fetch_models covered (never passes api_key) |
| health_check | 0 | get_conf covered |
| proactive | 1: `proactive.feedback` | proactive.feedback |
| task | 1: `task.asr.transcribe` | task.asr.transcribe — voice input |
| tts | 1: `tts.synthesize` | tts.synthesize — voice output |

## DSH-side features not yet bridged

- DSH tools → Jiuwen: only opt-in MCP passthrough (`toolPassthrough: mcp`, experimental); no native Cordis tool-registry bridge.
- Jiuwen events without a DSH surface: `todo.updated`, `team.task/member/message`, `security.alert`, `context.usage` (only logged/streamed as text; with `typedEvents` they are re-emitted as `jiuwen/swarm` / `jiuwen/plan`). `plan.approval_required` → ctx.approval; SwarmFlow human turns → ctx.approval + `chat.swarmflow_reply`.
- DSH host hooks: `llm.registerAdapter`, `commands.register`, `ctx.effect`/dispose, `ctx.provide`; opt-in `llm.registerModelDiscovery` (modelDiscovery); default-on `hostSync` (skills/MCP/model/plan/workDir/title/delete/goal/pause/permissions/fork/schedule — see host-sync.md), `sessionSync`, `planBridge`. Hard gaps: memory write-through, schedule.* on 0.2.7, arbitrary skill install, plugins catalog mismatch. Attachments beyond multimodal/`document.persist` not bridged; no voice (tts/asr).

## TUI-only methods

`command.add_dir`, `command.chrome`, `command.compact_partial`, `command.context`, `command.diff`, `command.mcp`, `command.model`, `command.model.switch`, `command.recap`, `command.resume`, `command.rewind_compact`, `command.sandbox`, `command.session`, `command.simplify`, `command.status`, `config.cache_clear`, `harmonyos.dev_init`, `harmonyos.dev_init_cancel`, `harmonyos.project_init`, `history.list_turns`, `memory.edit`, `memory.list`, `memory.open`, `memory.status`, `memory.toggle`, `model.add`, `model.delete`, `model.update`, `session.color_set`, `session.preview`, `session.rebind_project`, `session.restore_files`, `session.rewind`, `session.rewind_and_restore`, `tui.disconnect`

## Full table

| Method | Status | Via / reason |
|---|---|---|
| `acp.tool_response` | excluded | irreversible / credentials / host-side effect |
| `agent_groups.create` | uncovered |  |
| `agent_groups.file.list` | covered | /jiuwen group files <id> |
| `agent_groups.file.read` | covered | /jiuwen group files <id> <path> |
| `agent_groups.import_local` | excluded | irreversible / credentials / host-side effect |
| `agent_groups.install` | excluded | irreversible / credentials / host-side effect |
| `agent_groups.list` | covered | /jiuwen group list |
| `agent_groups.show` | covered | /jiuwen group show <id> |
| `agent_groups.uninstall` | excluded | irreversible / credentials / host-side effect |
| `agent_templates.create` | uncovered |  |
| `agent_templates.delete` | excluded | irreversible / credentials / host-side effect |
| `agent_templates.file.list` | covered | /jiuwen template files <id> |
| `agent_templates.file.read` | covered | /jiuwen template files <id> <path> |
| `agent_templates.import_local` | excluded | irreversible / credentials / host-side effect |
| `agent_templates.install` | excluded | irreversible / credentials / host-side effect |
| `agent_templates.list` | covered | /jiuwen templates |
| `agent_templates.show` | covered | /jiuwen template show <id|name> |
| `agent_templates.uninstall` | excluded | irreversible / credentials / host-side effect |
| `agent_templates.update` | uncovered |  |
| `agents.create` | uncovered |  |
| `agents.delete` | excluded | irreversible / credentials / host-side effect |
| `agents.disable` | uncovered |  |
| `agents.enable` | uncovered |  |
| `agents.get` | covered | /jiuwen agent |
| `agents.list` | covered | /jiuwen agents |
| `agents.tools_list` | covered | /jiuwen tools |
| `agents.update` | uncovered |  |
| `assets.publish.commit` | excluded | irreversible / credentials / host-side effect |
| `assets.publish.describe` | covered | /jiuwen publish describe (soft-fail AUTH) |
| `assets.publish.local_status` | covered | /jiuwen publish local (soft-fail) |
| `assets.publish.prepare` | excluded | irreversible / credentials / host-side effect |
| `assets.publish.records` | covered | /jiuwen publish records (soft-fail AUTH) |
| `assets.publish.status` | covered | /jiuwen publish status (soft-fail AUTH) |
| `channel.dingtalk.get_conf` | covered | /jiuwen channels conf dingtalk (secrets masked) |
| `channel.dingtalk.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.discord.get_conf` | covered | /jiuwen channels conf discord (secrets masked) |
| `channel.discord.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.feishu.get_conf` | covered | /jiuwen channels conf feishu (secrets masked) |
| `channel.feishu.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.get` | covered | /jiuwen channels |
| `channel.slack.get_conf` | covered | /jiuwen channels conf slack (secrets masked) |
| `channel.slack.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.telegram.get_conf` | covered | /jiuwen channels conf telegram (secrets masked) |
| `channel.telegram.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.wechat.get_conf` | covered | /jiuwen channels conf wechat (secrets masked) |
| `channel.wechat.get_login_ui` | excluded | irreversible / credentials / host-side effect |
| `channel.wechat.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.wechat.unbind` | excluded | irreversible / credentials / host-side effect |
| `channel.wecom.get_conf` | covered | /jiuwen channels conf wecom (secrets masked) |
| `channel.wecom.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.whatsapp.get_conf` | covered | /jiuwen channels conf whatsapp (secrets masked) |
| `channel.whatsapp.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.xiaoyi.get_conf` | covered | /jiuwen channels conf xiaoyi (secrets masked) |
| `channel.xiaoyi.set_conf` | excluded | irreversible / credentials / host-side effect |
| `chat.interrupt` | covered | /jiuwen interrupt + DSH abort |
| `chat.resume` | covered | /jiuwen resume |
| `chat.send` | covered | core turn (doStream) |
| `chat.swarmflow_reply` | covered | SwarmFlow human turns via ctx.approval (swarmflowReply) |
| `chat.user_answer` | covered | ask_user bridge (interaction.js) |
| `command.btw` | covered | /jiuwen btw |
| `command.compact` | covered | /jiuwen compact |
| `command.goal` | covered | /jiuwen goal |
| `command.workflows` | covered | /jiuwen workflows |
| `commands.list` | covered | /jiuwen commands |
| `config.get` | covered | /jiuwen config [get] [path] (secrets masked) |
| `config.save_all` | excluded | irreversible / credentials / host-side effect |
| `config.set` | excluded | irreversible / credentials / host-side effect |
| `config.validate_model` | uncovered |  |
| `cron.job.create` | covered | /jiuwen cron create (disabled by default) |
| `cron.job.delete` | covered | /jiuwen cron delete <id> confirm |
| `cron.job.get` | covered | /jiuwen cron get <id> |
| `cron.job.list` | covered | /jiuwen cron |
| `cron.job.meta` | covered | /jiuwen cron meta |
| `cron.job.preview` | covered | /jiuwen cron preview <id> |
| `cron.job.run_now` | covered | /jiuwen cron run |
| `cron.job.toggle` | covered | /jiuwen cron toggle |
| `cron.job.update` | covered | /jiuwen cron update <id> (Round 3) |
| `document.formats` | covered | /jiuwen document formats |
| `document.persist` | covered | /jiuwen doc persist + opt-in documentPersist |
| `extensions.delete` | excluded | irreversible / credentials / host-side effect |
| `extensions.import` | excluded | irreversible / credentials / host-side effect |
| `extensions.list` | covered | /jiuwen extensions |
| `extensions.toggle` | covered | /jiuwen extensions toggle <name> on|off |
| `external_cli.codex_install_status` | excluded | irreversible / credentials / host-side effect |
| `external_cli.detect` | excluded | irreversible / credentials / host-side effect |
| `external_cli.install_status` | excluded | irreversible / credentials / host-side effect |
| `harness.activate` | uncovered |  |
| `harness.deactivate` | uncovered |  |
| `harness.delete` | excluded | irreversible / credentials / host-side effect |
| `harness.export` | excluded | irreversible / credentials / host-side effect |
| `harness.import` | excluded | irreversible / credentials / host-side effect |
| `harness.packages` | covered | /jiuwen harness packages (soft-fail w/o GitCode token) |
| `harness.packages.scan` | uncovered |  |
| `health_check.get_conf` | covered | /jiuwen health |
| `health_check.set_conf` | excluded | irreversible / credentials / host-side effect |
| `heartbeat.get_conf` | covered | /jiuwen heartbeat |
| `heartbeat.job.cancel` | covered | /jiuwen heartbeat cancel |
| `heartbeat.job.create` | uncovered |  |
| `heartbeat.job.delete` | covered | /jiuwen heartbeat delete <id> confirm |
| `heartbeat.job.get` | covered | /jiuwen heartbeat job <id> |
| `heartbeat.job.list` | covered | /jiuwen heartbeat jobs |
| `heartbeat.job.meta` | covered | /jiuwen heartbeat meta |
| `heartbeat.job.preview` | covered | /jiuwen heartbeat preview <id> |
| `heartbeat.job.run_now` | covered | /jiuwen heartbeat run |
| `heartbeat.job.toggle` | covered | /jiuwen heartbeat toggle |
| `heartbeat.job.update` | covered | /jiuwen heartbeat update <id> |
| `heartbeat.set_conf` | covered | /jiuwen heartbeat set |
| `history.get` | covered | /jiuwen history |
| `hooks.list` | covered | /jiuwen hooks |
| `initialize` | excluded | irreversible / credentials / host-side effect |
| `issue.delete` | excluded | irreversible / credentials / host-side effect |
| `issue.matrix` | uncovered | wired (`/jiuwen issues matrix`); 0.2.7 /ws answers unknown method |
| `issue.state.list` | uncovered | wired (`/jiuwen issues`); 0.2.7 /ws answers unknown method |
| `issue.watch_once` | uncovered |  |
| `locale.get_conf` | covered | /jiuwen locale |
| `locale.set_conf` | excluded | irreversible / credentials / host-side effect |
| `mcp.cancel_connect` | covered | /jiuwen mcp cancel <name> |
| `mcp.connect` | covered | MCP passthrough bridge |
| `mcp.delete_custom` | covered | /jiuwen mcp-reset confirm (own entries only) |
| `mcp.disconnect` | covered | MCP bridge / mcp-reset |
| `mcp.install` | excluded | irreversible / credentials / host-side effect |
| `mcp.list` | covered | /jiuwen mcp |
| `mcp.register_custom` | covered | MCP passthrough bridge |
| `mcp.save_credentials` | excluded | irreversible / credentials / host-side effect |
| `mcp.show` | covered | /jiuwen mcp show <name|id> |
| `mcp.uninstall` | excluded | irreversible / credentials / host-side effect |
| `mcp.wait_auth` | uncovered |  |
| `media.discard` | covered | /jiuwen media discard <path> confirm |
| `media.persist` | covered | multimodal upload |
| `memory.compute` | uncovered |  |
| `memory.forbidden.get` | covered | /jiuwen memory forbidden |
| `memory.forbidden.set` | excluded | irreversible / credentials / host-side effect |
| `models.list` | covered | /jiuwen models, model |
| `models.replace_all` | uncovered |  |
| `models.validate` | covered | /jiuwen models validate (never passes keys) |
| `openai_account.auth.logout` | excluded | irreversible / credentials / host-side effect |
| `openai_account.auth.pending_login` | excluded | irreversible / credentials / host-side effect |
| `openai_account.auth.poll_login` | excluded | irreversible / credentials / host-side effect |
| `openai_account.auth.start_login` | excluded | irreversible / credentials / host-side effect |
| `openai_account.auth.status` | covered | /jiuwen openai [auth] |
| `openai_account.models.list` | covered | /jiuwen openai models |
| `path.get` | covered | /jiuwen path |
| `path.select_directory` | excluded | irreversible / credentials / host-side effect |
| `path.select_file` | excluded | irreversible / credentials / host-side effect |
| `path.select_files` | excluded | irreversible / credentials / host-side effect |
| `path.set` | excluded | irreversible / credentials / host-side effect |
| `permissions.approval_overrides.delete` | excluded | irreversible / credentials / host-side effect |
| `permissions.approval_overrides.get` | covered | /jiuwen permissions overrides |
| `permissions.owner_scopes.get` | covered | /jiuwen permissions scopes |
| `permissions.owner_scopes.set` | excluded | irreversible / credentials / host-side effect |
| `permissions.rules.create` | covered | /jiuwen permissions rule add |
| `permissions.rules.delete` | covered | /jiuwen permissions rule delete <id> confirm |
| `permissions.rules.get` | covered | /jiuwen permissions |
| `permissions.rules.update` | covered | /jiuwen permissions rule update |
| `permissions.tools.delete` | covered | /jiuwen permissions unset |
| `permissions.tools.get` | covered | /jiuwen permissions |
| `permissions.tools.set` | covered | /jiuwen permissions set-all … confirm |
| `permissions.tools.update` | covered | /jiuwen permissions set |
| `personal_context.context.get_node` | covered | /jiuwen context node <id> |
| `personal_context.context.get_source` | covered | /jiuwen context source <id> |
| `personal_context.context.search_pages` | covered | /jiuwen context search <q> |
| `personal_context.context.stream_graph` | uncovered |  |
| `personal_context.context.stream_tree` | uncovered |  |
| `personal_context.fetch.authorize_provider` | excluded | irreversible / credentials / host-side effect |
| `personal_context.fetch.create_service` | uncovered |  |
| `personal_context.fetch.delete_service` | excluded | irreversible / credentials / host-side effect |
| `personal_context.fetch.get_authorization_status` | covered | /jiuwen context auth <provider> |
| `personal_context.fetch.get_run_status` | covered | /jiuwen context runs |
| `personal_context.fetch.list_services` | covered | /jiuwen memory context services |
| `personal_context.fetch.patch_service` | uncovered |  |
| `personal_context.fetch.run_all` | excluded | irreversible / credentials / host-side effect |
| `personal_context.fetch.run_one` | uncovered |  |
| `personal_context.fetch.start_service` | uncovered |  |
| `personal_context.fetch.stop_run` | uncovered |  |
| `personal_context.fetch.stop_service` | uncovered |  |
| `personal_context.runtime.get_config` | covered | /jiuwen memory context config |
| `personal_context.runtime.patch_config` | excluded | irreversible / credentials / host-side effect |
| `personal_context.runtime.select_model` | uncovered |  |
| `personal_context.runtime.set_master_enabled` | excluded | irreversible / credentials / host-side effect |
| `personal_context.runtime.start_agent_use` | uncovered |  |
| `personal_context.runtime.start_collection` | uncovered |  |
| `personal_context.runtime.status` | covered | /jiuwen memory context |
| `personal_context.runtime.stop_agent_use` | uncovered |  |
| `personal_context.runtime.stop_collection` | uncovered |  |
| `plugin_packages.create` | uncovered |  |
| `plugin_packages.import_local` | excluded | irreversible / credentials / host-side effect |
| `plugin_packages.install` | excluded | irreversible / credentials / host-side effect |
| `plugin_packages.list` | covered | /jiuwen packages |
| `plugin_packages.show` | covered | /jiuwen packages show <id> |
| `plugin_packages.uninstall` | excluded | irreversible / credentials / host-side effect |
| `plugins.disable` | covered | /jiuwen plugins disable |
| `plugins.enable` | covered | /jiuwen plugins enable |
| `plugins.install` | excluded | irreversible / credentials / host-side effect |
| `plugins.list` | covered | /jiuwen plugins |
| `plugins.reload` | excluded | irreversible / credentials / host-side effect |
| `plugins.uninstall` | excluded | irreversible / credentials / host-side effect |
| `proactive.feedback` | uncovered |  |
| `project.create` | uncovered |  |
| `project.get_cron_sessions` | covered | /jiuwen projects cron |
| `project.get_sessions` | covered | /jiuwen projects sessions |
| `project.git.commit` | excluded | irreversible / credentials / host-side effect |
| `project.git.create_branch` | excluded | irreversible / credentials / host-side effect |
| `project.git.diff_status` | covered | /jiuwen git diff [project] |
| `project.git.init` | excluded | irreversible / credentials / host-side effect |
| `project.git.probe` | covered | /jiuwen git probe (soft-fail if disabled) |
| `project.git.push` | excluded | irreversible / credentials / host-side effect |
| `project.git.status` | covered | /jiuwen git status [project] |
| `project.git.switch_branch` | excluded | irreversible / credentials / host-side effect |
| `project.git.turn_diff` | covered | /jiuwen git turn <id> (soft-fail if disabled) |
| `project.git.turn_diff_list` | covered | /jiuwen git turns (soft-fail if disabled) |
| `project.info` | covered | /jiuwen projects info |
| `project.list` | covered | /jiuwen projects |
| `project.pin` | covered | /jiuwen projects pin <id> [on|off] |
| `project.pinned_sessions` | covered | /jiuwen projects pinned |
| `project.remove` | excluded | irreversible / credentials / host-side effect |
| `project.rename` | covered | /jiuwen projects rename <id> <name> |
| `project.restore` | uncovered |  |
| `project.sessions.archive` | uncovered |  |
| `project.sessions.delete_archived` | excluded | irreversible / credentials / host-side effect |
| `rsi.artifact.download` | uncovered |  |
| `rsi.artifact.files.get` | covered | /jiuwen rsi files <id> <path> |
| `rsi.artifact.files.list` | covered | /jiuwen rsi files <id> |
| `rsi.dataset.validate` | excluded | irreversible / credentials / host-side effect |
| `rsi.harness.install` | excluded | irreversible / credentials / host-side effect |
| `rsi.harness.rollback` | uncovered |  |
| `rsi.harness.versions.list` | covered | /jiuwen rsi versions |
| `rsi.report.get` | covered | /jiuwen rsi report <id> |
| `rsi.task.create` | excluded | irreversible / credentials / host-side effect |
| `rsi.task.delete` | excluded | irreversible / credentials / host-side effect |
| `rsi.task.get` | covered | /jiuwen rsi task <id> |
| `rsi.task.list` | covered | /jiuwen rsi [tasks] |
| `rsi.training.pause` | excluded | irreversible / credentials / host-side effect |
| `rsi.training.resume` | excluded | irreversible / credentials / host-side effect |
| `rsi.training.start` | excluded | irreversible / credentials / host-side effect |
| `rsi.training.terminate` | excluded | irreversible / credentials / host-side effect |
| `rsi.tree.get` | covered | /jiuwen rsi tree <id> |
| `rsi.usage.get` | covered | /jiuwen rsi usage <id> |
| `schedule.cancel` | uncovered | wired as /jiuwen schedule …, feature-detected; live 0.2.7 /ws → unknown method (hidden) |
| `schedule.check_config` | uncovered | wired as /jiuwen schedule …, feature-detected; live 0.2.7 /ws → unknown method (hidden) |
| `schedule.create` | uncovered | wired as /jiuwen schedule …, feature-detected; live 0.2.7 /ws → unknown method (hidden) |
| `schedule.delete` | excluded | irreversible / credentials / host-side effect |
| `schedule.list` | uncovered | wired as /jiuwen schedule …, feature-detected; live 0.2.7 /ws → unknown method (hidden) |
| `schedule.logs` | uncovered | wired as /jiuwen schedule …, feature-detected; live 0.2.7 /ws → unknown method (hidden) |
| `schedule.run` | uncovered | wired as /jiuwen schedule …, feature-detected; live 0.2.7 /ws → unknown method (hidden) |
| `schedule.status` | uncovered | wired as /jiuwen schedule …, feature-detected; live 0.2.7 /ws → unknown method (hidden) |
| `schedule.update_config` | uncovered |  |
| `session.archive` | covered | /jiuwen archive |
| `session.archived.list` | covered | /jiuwen archived |
| `session.create` | covered | session mapping |
| `session.delete` | covered | /jiuwen delete confirm |
| `session.fork` | covered | /jiuwen fork |
| `session.get_metadata` | covered | /jiuwen status |
| `session.list` | covered | /jiuwen sessions |
| `session.message.continue_queued` | covered | /jiuwen continue-queued |
| `session.pin` | covered | /jiuwen pin |
| `session.plan_status` | covered | /jiuwen plan-status |
| `session.rename` | covered | /jiuwen rename + title sync |
| `session.switch` | covered | /jiuwen switch |
| `session.unarchive` | covered | /jiuwen unarchive |
| `skills.clawhub.download` | uncovered |  |
| `skills.clawhub.get_token` | excluded | irreversible / credentials / host-side effect |
| `skills.clawhub.search` | covered | /jiuwen skills hub clawhub <q> (search only) |
| `skills.clawhub.set_token` | excluded | irreversible / credentials / host-side effect |
| `skills.create_from_knowledge` | uncovered |  |
| `skills.evolution.get` | covered | /jiuwen skills evolution <name> get |
| `skills.evolution.save` | uncovered |  |
| `skills.evolution.status` | covered | /jiuwen skills evolution <name> |
| `skills.experience.list` | covered | /jiuwen skills experience |
| `skills.experience.request` | uncovered |  |
| `skills.files.get` | covered | /jiuwen skills files <name> <path> |
| `skills.files.list` | covered | /jiuwen skills files <name> |
| `skills.get` | covered | /jiuwen skill-info |
| `skills.graph.build` | uncovered |  |
| `skills.graph.cancel` | uncovered |  |
| `skills.graph.get` | covered | /jiuwen skills graph get |
| `skills.graph.status` | covered | /jiuwen skills graph |
| `skills.import_local` | excluded | irreversible / credentials / host-side effect |
| `skills.import_upload` | excluded | irreversible / credentials / host-side effect |
| `skills.install` | excluded | irreversible / credentials / host-side effect |
| `skills.installed` | covered | /jiuwen skills installed |
| `skills.list` | covered | /jiuwen skills |
| `skills.marketplace.add` | excluded | irreversible / credentials / host-side effect |
| `skills.marketplace.list` | covered | /jiuwen marketplaces |
| `skills.marketplace.remove` | excluded | irreversible / credentials / host-side effect |
| `skills.marketplace.toggle` | covered | /jiuwen marketplace toggle <name> on|off |
| `skills.online_search.install` | excluded | irreversible / credentials / host-side effect |
| `skills.online_search.search` | covered | /jiuwen skills online <q> (read-only) |
| `skills.pack_member.install` | excluded | irreversible / credentials / host-side effect |
| `skills.rebuild` | uncovered |  |
| `skills.retrieval.index_build` | uncovered |  |
| `skills.retrieval.index_cancel` | uncovered |  |
| `skills.retrieval.search` | covered | /jiuwen skills search <q> |
| `skills.retrieval.status` | covered | /jiuwen skills retrieval |
| `skills.retrieval.tree` | covered | /jiuwen skills retrieval tree |
| `skills.skillnet.evaluate` | uncovered |  |
| `skills.skillnet.install` | excluded | irreversible / credentials / host-side effect |
| `skills.skillnet.install_status` | uncovered |  |
| `skills.skillnet.search` | covered | /jiuwen skills hub skillnet <q> |
| `skills.swarmskillshub.detail` | covered | /jiuwen skills hub swarm <asset_id> |
| `skills.swarmskillshub.recommend` | covered | /jiuwen skills hub recommend <asset_id> |
| `skills.teamskillshub.delete` | excluded | irreversible / credentials / host-side effect |
| `skills.teamskillshub.info` | covered | /jiuwen skills hub team-info |
| `skills.teamskillshub.init` | excluded | irreversible / credentials / host-side effect |
| `skills.teamskillshub.install` | excluded | irreversible / credentials / host-side effect |
| `skills.teamskillshub.pack` | excluded | irreversible / credentials / host-side effect |
| `skills.teamskillshub.publish` | excluded | irreversible / credentials / host-side effect |
| `skills.teamskillshub.search` | covered | /jiuwen skills hub team [q] |
| `skills.teamskillshub.validate` | uncovered |  |
| `skills.toggle` | covered | /jiuwen skill-toggle |
| `skills.uninstall` | excluded | irreversible / credentials / host-side effect |
| `skills.versions.list` | covered | /jiuwen skill-info |
| `swarmflow.pause` | covered | /jiuwen pause |
| `swarmflow.resume` | covered | /jiuwen resume |
| `swarmflow.stop` | covered | /jiuwen swarm-stop + auto on host abort (swarmflowStopOnAbort) |
| `task.asr.transcribe` | uncovered |  |
| `team.binding.create` | uncovered |  |
| `team.binding.generate` | uncovered |  |
| `team.bindings.list` | covered | /jiuwen bindings |
| `team.delete` | excluded | irreversible / credentials / host-side effect |
| `team.history.get` | covered | /jiuwen team history |
| `team.mq.publish` | excluded | irreversible / credentials / host-side effect |
| `team.session.bind` | uncovered |  |
| `team.snapshot` | covered | /jiuwen team snapshot |
| `team.templates.list` | covered | /jiuwen teams |
| `tts.synthesize` | uncovered |  |
| `updater.check` | covered | /jiuwen updater check |
| `updater.download` | excluded | irreversible / credentials / host-side effect |
| `updater.get_conf` | covered | /jiuwen updater conf |
| `updater.get_status` | covered | /jiuwen version |
| `updater.reset_source` | excluded | irreversible / credentials / host-side effect |
| `updater.set_conf` | excluded | irreversible / credentials / host-side effect |
| `updater.upgrade` | excluded | irreversible / credentials / host-side effect |
| `vendors.fetch_models` | covered | /jiuwen vendors models <key> <plan> |
| `vendors.list` | covered | /jiuwen vendors |
