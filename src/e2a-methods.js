/**
 * Jiuwen Gateway / E2A method + event vocabulary used by the adapter.
 * Sourced from openjiuwen_protocol.ReqMethod and webClient LEGACY_EVENT_MAP.
 * Tools stay owned by Jiuwen; we only observe / forward unary RPCs for ABI.
 */

/** Chat / control (streaming turns). */
export const CHAT = Object.freeze({
  SEND: 'chat.send',
  CANCEL: 'chat.interrupt',
  RESUME: 'chat.resume',
  ANSWER: 'chat.user_answer',
  SWARMFLOW_REPLY: 'chat.swarmflow_reply',
})

/** Session / history / memory / models / MCP / files (unary). */
export const SESSION = Object.freeze({
  GET_METADATA: 'session.get_metadata',
  LIST: 'session.list',
  CREATE: 'session.create',
  DELETE: 'session.delete',
  UPDATE: 'session.update',
  FORK: 'session.fork',
  SWITCH: 'session.switch',
  RENAME: 'session.rename',
  PIN: 'session.pin',
})

export const SKILLS = Object.freeze({ LIST: 'skills.list', INSTALLED: 'skills.installed', GET: 'skills.get', TOGGLE: 'skills.toggle' })
export const AGENTS = Object.freeze({ LIST: 'agents.list' })
export const TEAM = Object.freeze({ TEMPLATES_LIST: 'team.templates.list', LIST: 'team.list', HISTORY_GET: 'team.history.get' })
export const COMMANDS = Object.freeze({ LIST: 'commands.list', COMPACT: 'command.compact', GOAL: 'command.goal' })

export const HISTORY = Object.freeze({
  GET: 'history.get',
  LIST_TURNS: 'history.list_turns',
  APPEND_RECORD: 'history.append_record',
})

export const MEMORY = Object.freeze({
  LIST: 'memory.list',
  STATUS: 'memory.status',
  OPEN: 'memory.open',
  EDIT: 'memory.edit',
  TOGGLE: 'memory.toggle',
  COMPUTE: 'memory.compute',
})

export const MODELS = Object.freeze({
  LIST: 'models.list',
  GET: 'models.get',
  VALIDATE: 'models.validate',
  UPSERT: 'models.upsert',
})

export const MCP = Object.freeze({
  LIST: 'mcp.list',
  SHOW: 'mcp.show',
  CONNECT: 'mcp.connect',
  DISCONNECT: 'mcp.disconnect',
  INSTALL: 'mcp.install',
  UNINSTALL: 'mcp.uninstall',
})

export const FILES = Object.freeze({
  LIST: 'files.list',
  GET: 'files.get',
  UPLOAD_CHUNK: 'file.upload_chunk',
  IMPORT_URL: 'file.import_url',
})

export const MEDIA = Object.freeze({
  PERSIST: 'media.persist',
  DISCARD: 'media.discard',
})

export const SWARM = Object.freeze({
  PAUSE: 'swarmflow.pause',
  RESUME: 'swarmflow.resume',
  STOP: 'swarmflow.stop',
  WORKFLOWS: 'command.workflows',
})

/** Inbound event names (normalized). */
export const EVENTS = Object.freeze({
  CONNECTION_ACK: 'connection.ack',
  HEARTBEAT: 'connection.heartbeat',
  DELTA: 'chat.delta',
  FINAL: 'chat.final',
  MEDIA: 'chat.media',
  FILE: 'chat.file',
  TOOL_CALL: 'chat.tool_call',
  TOOL_UPDATE: 'chat.tool_update',
  TOOL_RESULT: 'chat.tool_result',
  ERROR: 'chat.error',
  INTERRUPT_RESULT: 'chat.interrupt_result',
  SUBTASK_UPDATE: 'chat.subtask_update',
  ASK_USER: 'chat.ask_user_question',
  PROCESSING: 'chat.processing_status',
  RETRACT: 'chat.retract',
  TODO: 'todo.updated',
  SESSION_UPDATED: 'session.updated',
  SECURITY: 'security.alert',
  STREAM_END: 'stream.end',
  RUNTIME_ACCEPTED: 'runtime.accepted',
  REASONING: 'chat.reasoning',
  USAGE_METADATA: 'chat.usage_metadata',
  USAGE_SUMMARY: 'chat.usage_summary',
  SUBAGENT_ACTIVITY: 'chat.subagent_activity',
  CONTEXT_USAGE: 'context.usage',
  TEAM_TASK: 'team.task',
  TEAM_MEMBER: 'team.member',
  TEAM_MESSAGE: 'team.message',
  OUTPUT_PHASE: 'chat.output_phase',
  PLAN_APPROVAL: 'plan.approval_required',
})

/** Legacy wire name → normalized event. */
export const LEGACY_EVENT_MAP = Object.freeze({
  connection_ack: EVENTS.CONNECTION_ACK,
  content_chunk: EVENTS.DELTA,
  content: EVENTS.FINAL,
  media_content: EVENTS.MEDIA,
  file_content: EVENTS.FILE,
  tool_call: EVENTS.TOOL_CALL,
  tool_update: EVENTS.TOOL_UPDATE,
  tool_result: EVENTS.TOOL_RESULT,
  error: EVENTS.ERROR,
  interrupt_result: EVENTS.INTERRUPT_RESULT,
  subtask_update: EVENTS.SUBTASK_UPDATE,
  ask_user_question: EVENTS.ASK_USER,
  todo_update: EVENTS.TODO,
  session_update: EVENTS.SESSION_UPDATED,
  processing_status: EVENTS.PROCESSING,
  heartbeat: EVENTS.HEARTBEAT,
  security_alert: EVENTS.SECURITY,
  chat_retract: EVENTS.RETRACT,
})

export function normalizeEventName(raw) {
  const name = String(raw || '')
  return LEGACY_EVENT_MAP[name] || name
}
