# Coverage: dsh-jiuwen-adapter vs JiuwenSwarm 0.2.7 Gateway

Audit date: 2026-10-30 (UTC+8). Adapter base: `c76bd61`. Source of truth: `jiuwenswarm/gateway/channel_manager/web/app_web_handlers.py` (`_FORWARD_REQ_METHODS`, `_FORWARD_NO_LOCAL_HANDLER_METHODS`, every `register_method` / `_register_*` / tuple table) + `web/lifecycle_handlers.py`, in `/workspace/jiuwen-0.2.7/.venv`. TUI-only = strings in `channel_manager/tui/` not routed by the web channel.

## Summary

| Bucket | Count |
|---|---|
| Web `/ws` methods (total) | 334 |
| Covered by adapter | 63 |
| Intentionally excluded (irreversible / credentials / host side effects) | 102 |
| Uncovered | 169 |
| TUI-only (not reachable on /ws) | 35 |

- Raw coverage: 63/334 = **18.9%**
- Coverage of the safe surface (total minus excluded): 63/232 = **27.2%**

Adapter calls that 0.2.7 `/ws` does **not** route (live probe → `unknown method`): `command.recap`, `files.list`, `history.list_turns`, `memory.list`, `memory.status`, `models.get`, `session.assets.list`, `team.list`. These are 0.2.5b1-era / TUI-only paths; `/jiuwen recap`, `assets`, `model-info`, `teams` rely on fallbacks or return an error text on 0.2.7.

Live probe (ws://127.0.0.1:19000/ws, empty params, read-only): routed ok: `models.list`, `permissions.tools.get`, `permissions.rules.get`, `session.archived.list`, `config.get`; `permissions.rules.update` and `tts.synthesize` reach validation (routed). Unknown on /ws: the 8 above plus `command.context`, `command.status`, `session.preview`, `memory.open`, `session.color_set`.

## Uncovered by area

| Area | Methods | Usefulness |
|---|---|---|
| skills | 30: `skills.clawhub.download`, `skills.clawhub.search`, `skills.create_from_knowledge`, `skills.evolution.get`, `skills.evolution.save`, `skills.evolution.status`, `skills.experience.list`, `skills.experience.request`, `skills.files.get`, `skills.files.list`, `skills.graph.build`, `skills.graph.cancel`, `skills.graph.get`, `skills.graph.status`, `skills.marketplace.toggle`, `skills.online_search.search`, `skills.rebuild`, `skills.retrieval.index_build`, `skills.retrieval.index_cancel`, `skills.retrieval.search`, `skills.retrieval.status`, `skills.retrieval.tree`, `skills.skillnet.evaluate`, `skills.skillnet.install_status`, `skills.skillnet.search`, `skills.swarmskillshub.detail`, `skills.swarmskillshub.recommend`, `skills.teamskillshub.info`, `skills.teamskillshub.search`, `skills.teamskillshub.validate` | skill discovery/search/retrieval/graph/evolution reads; useful for /jiuwen skills search|files |
| personal_context | 21: `personal_context.context.get_node`, `personal_context.context.get_source`, `personal_context.context.search_pages`, `personal_context.context.stream_graph`, `personal_context.context.stream_tree`, `personal_context.fetch.create_service`, `personal_context.fetch.get_authorization_status`, `personal_context.fetch.get_run_status`, `personal_context.fetch.list_services`, `personal_context.fetch.patch_service`, `personal_context.fetch.run_one`, `personal_context.fetch.start_service`, `personal_context.fetch.stop_run`, `personal_context.fetch.stop_service`, `personal_context.runtime.get_config`, `personal_context.runtime.select_model`, `personal_context.runtime.start_agent_use`, `personal_context.runtime.start_collection`, `personal_context.runtime.status`, `personal_context.runtime.stop_agent_use`, `personal_context.runtime.stop_collection` | personal-context runtime & fetch services; niche, mostly UI-driven |
| project | 12: `project.create`, `project.get_cron_sessions`, `project.git.diff_status`, `project.git.probe`, `project.git.status`, `project.git.turn_diff`, `project.git.turn_diff_list`, `project.pin`, `project.pinned_sessions`, `project.rename`, `project.restore`, `project.sessions.archive` | project CRUD-lite, pinning, git status/diff (read parts useful: git.status, git.diff_status, turn_diff) |
| channel | 10: `channel.dingtalk.get_conf`, `channel.discord.get_conf`, `channel.feishu.get_conf`, `channel.get`, `channel.slack.get_conf`, `channel.telegram.get_conf`, `channel.wechat.get_conf`, `channel.wecom.get_conf`, `channel.whatsapp.get_conf`, `channel.xiaoyi.get_conf` | IM channel conf reads (get_conf); low value inside DSH |
| rsi | 10: `rsi.artifact.download`, `rsi.artifact.files.get`, `rsi.artifact.files.list`, `rsi.harness.rollback`, `rsi.harness.versions.list`, `rsi.report.get`, `rsi.task.get`, `rsi.task.list`, `rsi.tree.get`, `rsi.usage.get` | RSI dataset/task/report reads; research-only |
| heartbeat | 8: `heartbeat.job.cancel`, `heartbeat.job.create`, `heartbeat.job.get`, `heartbeat.job.meta`, `heartbeat.job.preview`, `heartbeat.job.run_now`, `heartbeat.job.toggle`, `heartbeat.job.update` | heartbeat job get/meta/preview/toggle/run_now — moderately useful |
| schedule | 8: `schedule.cancel`, `schedule.check_config`, `schedule.create`, `schedule.list`, `schedule.logs`, `schedule.run`, `schedule.status`, `schedule.update_config` | schedule list/status/logs — useful read-only |
| cron | 7: `cron.job.create`, `cron.job.get`, `cron.job.meta`, `cron.job.preview`, `cron.job.run_now`, `cron.job.toggle`, `cron.job.update` | cron job get/meta/preview/toggle — get/preview useful |
| agent_groups | 5: `agent_groups.create`, `agent_groups.file.list`, `agent_groups.file.read`, `agent_groups.list`, `agent_groups.show` | agent group list/show/file reads |
| agent_templates | 5: `agent_templates.create`, `agent_templates.file.list`, `agent_templates.file.read`, `agent_templates.show`, `agent_templates.update` | template show/file reads |
| permissions | 5: `permissions.approval_overrides.get`, `permissions.owner_scopes.get`, `permissions.rules.create`, `permissions.rules.update`, `permissions.tools.set` | rules create/update, approval_overrides, owner_scopes.get — rule editing would complete /jiuwen permissions |
| team | 5: `team.binding.create`, `team.binding.generate`, `team.history.get`, `team.session.bind`, `team.snapshot` | team.history.get, snapshot, bindings generate — history useful |
| agents | 4: `agents.create`, `agents.disable`, `agents.enable`, `agents.update` | agent create/update/enable/disable — config mutations |
| assets | 4: `assets.publish.describe`, `assets.publish.local_status`, `assets.publish.records`, `assets.publish.status` | assets.publish describe/status/records reads |
| harness | 4: `harness.activate`, `harness.deactivate`, `harness.packages`, `harness.packages.scan` | harness / rsi forwarders |
| issue | 3: `issue.matrix`, `issue.state.list`, `issue.watch_once` | issue matrix/state/watch — niche |
| mcp | 3: `mcp.cancel_connect`, `mcp.show`, `mcp.wait_auth` | mcp.show / cancel_connect / wait_auth — show is useful for /jiuwen mcp <name> |
| plugin_packages | 3: `plugin_packages.create`, `plugin_packages.list`, `plugin_packages.show` | plugin package list/show/create |
| config | 2: `config.get`, `config.validate_model` | config.get/validate_model — read config, useful for /jiuwen config |
| document | 2: `document.formats`, `document.persist` | document.formats/persist — doc upload path |
| extensions | 2: `extensions.list`, `extensions.toggle` | extensions list/toggle |
| memory | 2: `memory.compute`, `memory.forbidden.get` | memory.forbidden.get read |
| models | 2: `models.replace_all`, `models.validate` | models.validate/defaults — validate useful |
| openai_account | 2: `openai_account.auth.status`, `openai_account.models.list` | auth status + models list reads |
| vendors | 2: `vendors.fetch_models`, `vendors.list` | vendor list / fetch models |
| chat | 1: `chat.swarmflow_reply` | chat.swarmflow_reply — needed for swarmflow approval UX |
| health_check | 1: `health_check.get_conf` | health_check.get_conf read |
| media | 1: `media.discard` | media.discard — cleanup of persisted uploads |
| proactive | 1: `proactive.feedback` | proactive.feedback |
| session | 1: `session.message.continue_queued` | session.message.continue_queued, project.sessions.* — queue continuation is useful |
| swarmflow | 1: `swarmflow.stop` | swarmflow.stop — useful hard stop |
| task | 1: `task.asr.transcribe` | task.asr.transcribe — voice input |
| tts | 1: `tts.synthesize` | tts.synthesize — voice output |

## DSH-side features not yet bridged

- DSH tools → Jiuwen: only opt-in MCP passthrough (`toolPassthrough: mcp`, experimental); no native Cordis tool-registry bridge.
- Jiuwen events without a DSH surface: `todo.updated`, `team.task/member/message`, `plan.approval_required` (no approve/reject UI; `chat.swarmflow_reply` unwired), `security.alert`, `context.usage` (only logged/streamed as text).
- DSH host hooks: adapter only uses `llm.registerAdapter`, `commands.register`, `ctx.effect`/dispose and service exposure; no DSH session-lifecycle hooks (new/clear/compact) mapped to Jiuwen `session.*` beyond title sync; DSH permission prompts are not mirrored to Jiuwen permissions; DSH attachments beyond multimodal `media.persist` (documents → `document.persist`) not bridged; no voice (tts/asr).

## TUI-only methods

`command.add_dir`, `command.chrome`, `command.compact_partial`, `command.context`, `command.diff`, `command.mcp`, `command.model`, `command.model.switch`, `command.recap`, `command.resume`, `command.rewind_compact`, `command.sandbox`, `command.session`, `command.simplify`, `command.status`, `config.cache_clear`, `harmonyos.dev_init`, `harmonyos.dev_init_cancel`, `harmonyos.project_init`, `history.list_turns`, `memory.edit`, `memory.list`, `memory.open`, `memory.status`, `memory.toggle`, `model.add`, `model.delete`, `model.update`, `session.color_set`, `session.preview`, `session.rebind_project`, `session.restore_files`, `session.rewind`, `session.rewind_and_restore`, `tui.disconnect`

## Full table

| Method | Status | Via / reason |
|---|---|---|
| `acp.tool_response` | excluded | irreversible / credentials / host-side effect |
| `agent_groups.create` | uncovered |  |
| `agent_groups.file.list` | uncovered |  |
| `agent_groups.file.read` | uncovered |  |
| `agent_groups.import_local` | excluded | irreversible / credentials / host-side effect |
| `agent_groups.install` | excluded | irreversible / credentials / host-side effect |
| `agent_groups.list` | uncovered |  |
| `agent_groups.show` | uncovered |  |
| `agent_groups.uninstall` | excluded | irreversible / credentials / host-side effect |
| `agent_templates.create` | uncovered |  |
| `agent_templates.delete` | excluded | irreversible / credentials / host-side effect |
| `agent_templates.file.list` | uncovered |  |
| `agent_templates.file.read` | uncovered |  |
| `agent_templates.import_local` | excluded | irreversible / credentials / host-side effect |
| `agent_templates.install` | excluded | irreversible / credentials / host-side effect |
| `agent_templates.list` | covered | /jiuwen templates |
| `agent_templates.show` | uncovered |  |
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
| `assets.publish.describe` | uncovered |  |
| `assets.publish.local_status` | uncovered |  |
| `assets.publish.prepare` | excluded | irreversible / credentials / host-side effect |
| `assets.publish.records` | uncovered |  |
| `assets.publish.status` | uncovered |  |
| `channel.dingtalk.get_conf` | uncovered |  |
| `channel.dingtalk.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.discord.get_conf` | uncovered |  |
| `channel.discord.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.feishu.get_conf` | uncovered |  |
| `channel.feishu.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.get` | uncovered |  |
| `channel.slack.get_conf` | uncovered |  |
| `channel.slack.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.telegram.get_conf` | uncovered |  |
| `channel.telegram.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.wechat.get_conf` | uncovered |  |
| `channel.wechat.get_login_ui` | excluded | irreversible / credentials / host-side effect |
| `channel.wechat.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.wechat.unbind` | excluded | irreversible / credentials / host-side effect |
| `channel.wecom.get_conf` | uncovered |  |
| `channel.wecom.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.whatsapp.get_conf` | uncovered |  |
| `channel.whatsapp.set_conf` | excluded | irreversible / credentials / host-side effect |
| `channel.xiaoyi.get_conf` | uncovered |  |
| `channel.xiaoyi.set_conf` | excluded | irreversible / credentials / host-side effect |
| `chat.interrupt` | covered | /jiuwen interrupt + DSH abort |
| `chat.resume` | covered | /jiuwen resume |
| `chat.send` | covered | core turn (doStream) |
| `chat.swarmflow_reply` | uncovered |  |
| `chat.user_answer` | covered | ask_user bridge (interaction.js) |
| `command.btw` | covered | /jiuwen btw |
| `command.compact` | covered | /jiuwen compact |
| `command.goal` | covered | /jiuwen goal |
| `command.workflows` | covered | /jiuwen workflows |
| `commands.list` | covered | /jiuwen commands |
| `config.get` | uncovered |  |
| `config.save_all` | excluded | irreversible / credentials / host-side effect |
| `config.set` | excluded | irreversible / credentials / host-side effect |
| `config.validate_model` | uncovered |  |
| `cron.job.create` | uncovered |  |
| `cron.job.delete` | excluded | irreversible / credentials / host-side effect |
| `cron.job.get` | uncovered |  |
| `cron.job.list` | covered | /jiuwen cron |
| `cron.job.meta` | uncovered |  |
| `cron.job.preview` | uncovered |  |
| `cron.job.run_now` | uncovered |  |
| `cron.job.toggle` | uncovered |  |
| `cron.job.update` | uncovered |  |
| `document.formats` | uncovered |  |
| `document.persist` | uncovered |  |
| `extensions.delete` | excluded | irreversible / credentials / host-side effect |
| `extensions.import` | excluded | irreversible / credentials / host-side effect |
| `extensions.list` | uncovered |  |
| `extensions.toggle` | uncovered |  |
| `external_cli.codex_install_status` | excluded | irreversible / credentials / host-side effect |
| `external_cli.detect` | excluded | irreversible / credentials / host-side effect |
| `external_cli.install_status` | excluded | irreversible / credentials / host-side effect |
| `harness.activate` | uncovered |  |
| `harness.deactivate` | uncovered |  |
| `harness.delete` | excluded | irreversible / credentials / host-side effect |
| `harness.export` | excluded | irreversible / credentials / host-side effect |
| `harness.import` | excluded | irreversible / credentials / host-side effect |
| `harness.packages` | uncovered |  |
| `harness.packages.scan` | uncovered |  |
| `health_check.get_conf` | uncovered |  |
| `health_check.set_conf` | excluded | irreversible / credentials / host-side effect |
| `heartbeat.get_conf` | covered | /jiuwen heartbeat |
| `heartbeat.job.cancel` | uncovered |  |
| `heartbeat.job.create` | uncovered |  |
| `heartbeat.job.delete` | excluded | irreversible / credentials / host-side effect |
| `heartbeat.job.get` | uncovered |  |
| `heartbeat.job.list` | covered | /jiuwen heartbeat jobs |
| `heartbeat.job.meta` | uncovered |  |
| `heartbeat.job.preview` | uncovered |  |
| `heartbeat.job.run_now` | uncovered |  |
| `heartbeat.job.toggle` | uncovered |  |
| `heartbeat.job.update` | uncovered |  |
| `heartbeat.set_conf` | covered | /jiuwen heartbeat set |
| `history.get` | covered | /jiuwen history |
| `hooks.list` | covered | /jiuwen hooks |
| `initialize` | excluded | irreversible / credentials / host-side effect |
| `issue.delete` | excluded | irreversible / credentials / host-side effect |
| `issue.matrix` | uncovered |  |
| `issue.state.list` | uncovered |  |
| `issue.watch_once` | uncovered |  |
| `locale.get_conf` | covered | /jiuwen locale |
| `locale.set_conf` | excluded | irreversible / credentials / host-side effect |
| `mcp.cancel_connect` | uncovered |  |
| `mcp.connect` | covered | MCP passthrough bridge |
| `mcp.delete_custom` | covered | /jiuwen mcp-reset (own entries only) |
| `mcp.disconnect` | covered | MCP bridge / mcp-reset |
| `mcp.install` | excluded | irreversible / credentials / host-side effect |
| `mcp.list` | covered | /jiuwen mcp |
| `mcp.register_custom` | covered | MCP passthrough bridge |
| `mcp.save_credentials` | excluded | irreversible / credentials / host-side effect |
| `mcp.show` | uncovered |  |
| `mcp.uninstall` | excluded | irreversible / credentials / host-side effect |
| `mcp.wait_auth` | uncovered |  |
| `media.discard` | uncovered |  |
| `media.persist` | covered | multimodal upload |
| `memory.compute` | uncovered |  |
| `memory.forbidden.get` | uncovered |  |
| `memory.forbidden.set` | excluded | irreversible / credentials / host-side effect |
| `models.list` | covered | /jiuwen models, model |
| `models.replace_all` | uncovered |  |
| `models.validate` | uncovered |  |
| `openai_account.auth.logout` | excluded | irreversible / credentials / host-side effect |
| `openai_account.auth.pending_login` | excluded | irreversible / credentials / host-side effect |
| `openai_account.auth.poll_login` | excluded | irreversible / credentials / host-side effect |
| `openai_account.auth.start_login` | excluded | irreversible / credentials / host-side effect |
| `openai_account.auth.status` | uncovered |  |
| `openai_account.models.list` | uncovered |  |
| `path.get` | covered | /jiuwen path |
| `path.select_directory` | excluded | irreversible / credentials / host-side effect |
| `path.select_file` | excluded | irreversible / credentials / host-side effect |
| `path.select_files` | excluded | irreversible / credentials / host-side effect |
| `path.set` | excluded | irreversible / credentials / host-side effect |
| `permissions.approval_overrides.delete` | excluded | irreversible / credentials / host-side effect |
| `permissions.approval_overrides.get` | uncovered |  |
| `permissions.owner_scopes.get` | uncovered |  |
| `permissions.owner_scopes.set` | excluded | irreversible / credentials / host-side effect |
| `permissions.rules.create` | uncovered |  |
| `permissions.rules.delete` | excluded | irreversible / credentials / host-side effect |
| `permissions.rules.get` | covered | /jiuwen permissions |
| `permissions.rules.update` | uncovered |  |
| `permissions.tools.delete` | covered | /jiuwen permissions unset |
| `permissions.tools.get` | covered | /jiuwen permissions |
| `permissions.tools.set` | uncovered |  |
| `permissions.tools.update` | covered | /jiuwen permissions set |
| `personal_context.context.get_node` | uncovered |  |
| `personal_context.context.get_source` | uncovered |  |
| `personal_context.context.search_pages` | uncovered |  |
| `personal_context.context.stream_graph` | uncovered |  |
| `personal_context.context.stream_tree` | uncovered |  |
| `personal_context.fetch.authorize_provider` | excluded | irreversible / credentials / host-side effect |
| `personal_context.fetch.create_service` | uncovered |  |
| `personal_context.fetch.delete_service` | excluded | irreversible / credentials / host-side effect |
| `personal_context.fetch.get_authorization_status` | uncovered |  |
| `personal_context.fetch.get_run_status` | uncovered |  |
| `personal_context.fetch.list_services` | uncovered |  |
| `personal_context.fetch.patch_service` | uncovered |  |
| `personal_context.fetch.run_all` | excluded | irreversible / credentials / host-side effect |
| `personal_context.fetch.run_one` | uncovered |  |
| `personal_context.fetch.start_service` | uncovered |  |
| `personal_context.fetch.stop_run` | uncovered |  |
| `personal_context.fetch.stop_service` | uncovered |  |
| `personal_context.runtime.get_config` | uncovered |  |
| `personal_context.runtime.patch_config` | excluded | irreversible / credentials / host-side effect |
| `personal_context.runtime.select_model` | uncovered |  |
| `personal_context.runtime.set_master_enabled` | excluded | irreversible / credentials / host-side effect |
| `personal_context.runtime.start_agent_use` | uncovered |  |
| `personal_context.runtime.start_collection` | uncovered |  |
| `personal_context.runtime.status` | uncovered |  |
| `personal_context.runtime.stop_agent_use` | uncovered |  |
| `personal_context.runtime.stop_collection` | uncovered |  |
| `plugin_packages.create` | uncovered |  |
| `plugin_packages.import_local` | excluded | irreversible / credentials / host-side effect |
| `plugin_packages.install` | excluded | irreversible / credentials / host-side effect |
| `plugin_packages.list` | uncovered |  |
| `plugin_packages.show` | uncovered |  |
| `plugin_packages.uninstall` | excluded | irreversible / credentials / host-side effect |
| `plugins.disable` | covered | /jiuwen plugins disable |
| `plugins.enable` | covered | /jiuwen plugins enable |
| `plugins.install` | excluded | irreversible / credentials / host-side effect |
| `plugins.list` | covered | /jiuwen plugins |
| `plugins.reload` | excluded | irreversible / credentials / host-side effect |
| `plugins.uninstall` | excluded | irreversible / credentials / host-side effect |
| `proactive.feedback` | uncovered |  |
| `project.create` | uncovered |  |
| `project.get_cron_sessions` | uncovered |  |
| `project.get_sessions` | covered | /jiuwen projects sessions |
| `project.git.commit` | excluded | irreversible / credentials / host-side effect |
| `project.git.create_branch` | excluded | irreversible / credentials / host-side effect |
| `project.git.diff_status` | uncovered |  |
| `project.git.init` | excluded | irreversible / credentials / host-side effect |
| `project.git.probe` | uncovered |  |
| `project.git.push` | excluded | irreversible / credentials / host-side effect |
| `project.git.status` | uncovered |  |
| `project.git.switch_branch` | excluded | irreversible / credentials / host-side effect |
| `project.git.turn_diff` | uncovered |  |
| `project.git.turn_diff_list` | uncovered |  |
| `project.info` | covered | /jiuwen projects info |
| `project.list` | covered | /jiuwen projects |
| `project.pin` | uncovered |  |
| `project.pinned_sessions` | uncovered |  |
| `project.remove` | excluded | irreversible / credentials / host-side effect |
| `project.rename` | uncovered |  |
| `project.restore` | uncovered |  |
| `project.sessions.archive` | uncovered |  |
| `project.sessions.delete_archived` | excluded | irreversible / credentials / host-side effect |
| `rsi.artifact.download` | uncovered |  |
| `rsi.artifact.files.get` | uncovered |  |
| `rsi.artifact.files.list` | uncovered |  |
| `rsi.dataset.validate` | excluded | irreversible / credentials / host-side effect |
| `rsi.harness.install` | excluded | irreversible / credentials / host-side effect |
| `rsi.harness.rollback` | uncovered |  |
| `rsi.harness.versions.list` | uncovered |  |
| `rsi.report.get` | uncovered |  |
| `rsi.task.create` | excluded | irreversible / credentials / host-side effect |
| `rsi.task.delete` | excluded | irreversible / credentials / host-side effect |
| `rsi.task.get` | uncovered |  |
| `rsi.task.list` | uncovered |  |
| `rsi.training.pause` | excluded | irreversible / credentials / host-side effect |
| `rsi.training.resume` | excluded | irreversible / credentials / host-side effect |
| `rsi.training.start` | excluded | irreversible / credentials / host-side effect |
| `rsi.training.terminate` | excluded | irreversible / credentials / host-side effect |
| `rsi.tree.get` | uncovered |  |
| `rsi.usage.get` | uncovered |  |
| `schedule.cancel` | uncovered |  |
| `schedule.check_config` | uncovered |  |
| `schedule.create` | uncovered |  |
| `schedule.delete` | excluded | irreversible / credentials / host-side effect |
| `schedule.list` | uncovered |  |
| `schedule.logs` | uncovered |  |
| `schedule.run` | uncovered |  |
| `schedule.status` | uncovered |  |
| `schedule.update_config` | uncovered |  |
| `session.archive` | covered | /jiuwen archive |
| `session.archived.list` | covered | /jiuwen archived |
| `session.create` | covered | session mapping |
| `session.delete` | covered | /jiuwen delete |
| `session.fork` | covered | /jiuwen fork |
| `session.get_metadata` | covered | /jiuwen status |
| `session.list` | covered | /jiuwen sessions |
| `session.message.continue_queued` | uncovered |  |
| `session.pin` | covered | /jiuwen pin |
| `session.plan_status` | covered | /jiuwen plan-status |
| `session.rename` | covered | /jiuwen rename + title sync |
| `session.switch` | covered | /jiuwen switch |
| `session.unarchive` | covered | /jiuwen unarchive |
| `skills.clawhub.download` | uncovered |  |
| `skills.clawhub.get_token` | excluded | irreversible / credentials / host-side effect |
| `skills.clawhub.search` | uncovered |  |
| `skills.clawhub.set_token` | excluded | irreversible / credentials / host-side effect |
| `skills.create_from_knowledge` | uncovered |  |
| `skills.evolution.get` | uncovered |  |
| `skills.evolution.save` | uncovered |  |
| `skills.evolution.status` | uncovered |  |
| `skills.experience.list` | uncovered |  |
| `skills.experience.request` | uncovered |  |
| `skills.files.get` | uncovered |  |
| `skills.files.list` | uncovered |  |
| `skills.get` | covered | /jiuwen skill-info |
| `skills.graph.build` | uncovered |  |
| `skills.graph.cancel` | uncovered |  |
| `skills.graph.get` | uncovered |  |
| `skills.graph.status` | uncovered |  |
| `skills.import_local` | excluded | irreversible / credentials / host-side effect |
| `skills.import_upload` | excluded | irreversible / credentials / host-side effect |
| `skills.install` | excluded | irreversible / credentials / host-side effect |
| `skills.installed` | covered | /jiuwen skills installed |
| `skills.list` | covered | /jiuwen skills |
| `skills.marketplace.add` | excluded | irreversible / credentials / host-side effect |
| `skills.marketplace.list` | covered | /jiuwen marketplaces |
| `skills.marketplace.remove` | excluded | irreversible / credentials / host-side effect |
| `skills.marketplace.toggle` | uncovered |  |
| `skills.online_search.install` | excluded | irreversible / credentials / host-side effect |
| `skills.online_search.search` | uncovered |  |
| `skills.pack_member.install` | excluded | irreversible / credentials / host-side effect |
| `skills.rebuild` | uncovered |  |
| `skills.retrieval.index_build` | uncovered |  |
| `skills.retrieval.index_cancel` | uncovered |  |
| `skills.retrieval.search` | uncovered |  |
| `skills.retrieval.status` | uncovered |  |
| `skills.retrieval.tree` | uncovered |  |
| `skills.skillnet.evaluate` | uncovered |  |
| `skills.skillnet.install` | excluded | irreversible / credentials / host-side effect |
| `skills.skillnet.install_status` | uncovered |  |
| `skills.skillnet.search` | uncovered |  |
| `skills.swarmskillshub.detail` | uncovered |  |
| `skills.swarmskillshub.recommend` | uncovered |  |
| `skills.teamskillshub.delete` | excluded | irreversible / credentials / host-side effect |
| `skills.teamskillshub.info` | uncovered |  |
| `skills.teamskillshub.init` | excluded | irreversible / credentials / host-side effect |
| `skills.teamskillshub.install` | excluded | irreversible / credentials / host-side effect |
| `skills.teamskillshub.pack` | excluded | irreversible / credentials / host-side effect |
| `skills.teamskillshub.publish` | excluded | irreversible / credentials / host-side effect |
| `skills.teamskillshub.search` | uncovered |  |
| `skills.teamskillshub.validate` | uncovered |  |
| `skills.toggle` | covered | /jiuwen skill-toggle |
| `skills.uninstall` | excluded | irreversible / credentials / host-side effect |
| `skills.versions.list` | covered | /jiuwen skill-info |
| `swarmflow.pause` | covered | /jiuwen pause |
| `swarmflow.resume` | covered | /jiuwen resume |
| `swarmflow.stop` | uncovered |  |
| `task.asr.transcribe` | uncovered |  |
| `team.binding.create` | uncovered |  |
| `team.binding.generate` | uncovered |  |
| `team.bindings.list` | covered | /jiuwen bindings |
| `team.delete` | excluded | irreversible / credentials / host-side effect |
| `team.history.get` | uncovered |  |
| `team.mq.publish` | excluded | irreversible / credentials / host-side effect |
| `team.session.bind` | uncovered |  |
| `team.snapshot` | uncovered |  |
| `team.templates.list` | covered | /jiuwen teams |
| `tts.synthesize` | uncovered |  |
| `updater.check` | covered | /jiuwen updater check |
| `updater.download` | excluded | irreversible / credentials / host-side effect |
| `updater.get_conf` | covered | /jiuwen updater conf |
| `updater.get_status` | covered | /jiuwen version |
| `updater.reset_source` | excluded | irreversible / credentials / host-side effect |
| `updater.set_conf` | excluded | irreversible / credentials / host-side effect |
| `updater.upgrade` | excluded | irreversible / credentials / host-side effect |
| `vendors.fetch_models` | uncovered |  |
| `vendors.list` | uncovered |  |
