/**
 * Host-answered Jiuwen interactions.
 *
 *  - chat.ask_user_question (source ask_user_interrupt / plain)  → ctx.userQuestions.ask()  (dsh-user-questions)
 *  - permission_interrupt / confirm_interrupt / plan.approval_required → ctx.approval.request() (dsh-user-approval)
 *
 * Returns `{ kind, outcome, answers, note }` in Jiuwen's answer shape
 * (`[{ selected_options: [...], custom_input, card_id? }]`), or null to keep the legacy
 * "print the question and end the turn" behaviour. Approvals never fail open: no UI,
 * no live agent, timeout or error → reject.
 */

const APPROVAL_SOURCES = new Set(['permission_interrupt', 'confirm_interrupt'])
const ALLOW_RE = /^(allow_once|allow|approve|approved|yes|execute|implement|accept)$/i
const REJECT_RE = /^(reject|deny|denied|no|cancel|skip)$/i

/** @param {{ services: () => { userQuestions?: any, approval?: any, agents?: any }, config: () => any, logger?: any }} deps */
export function createInteractor(deps) {
  // dshSessionId -> { agent, ac } for host question cards currently awaiting the user.
  const pendingAsks = new Map()
  /** A normal chat message reached `agent`'s inbox: close its pending Jiuwen question so the turn ends. */
  const noteUserMessage = (agent, message) => {
    try {
      if (message?.source?.kind === 'user-question-reply') return false
      let hit = false
      for (const [sid, p] of pendingAsks) {
        if (p.agent && p.agent === agent) { hit = true; pendingAsks.delete(sid); p.ac.abort() }
      }
      return hit
    } catch { return false }
  }
  let subscribed = false
  const subscribe = () => {
    if (subscribed) return
    subscribed = true
    try {
      deps.onUserMessage?.(({ agent, message } = {}) => {
        if (noteUserMessage(agent, message)) deps.logger?.info?.('[dsh-jiuwen] user message superseded a pending question card')
      })
    } catch { /* host without inbox events: legacy behaviour */ }
  }
  const interact = async function interact({ eventType, payload, signal, told }, dshSessionId) {
    const cfg = deps.config()
    const { userQuestions, approval, agents } = deps.services() || {}
    const questions = Array.isArray(payload?.questions) ? payload.questions.filter(q => q && typeof q === 'object') : []
    let agent
    try { agent = agents?.get?.(dshSessionId) } catch { agent = undefined }

    if (payload?.source === 'swarmflow_human' && payload?.swarmflow_meta?.correlation_id) {
      // SwarmFlow human turn → dsh approval (allowed-once = "approved"); the transport replies with
      // chat.swarmflow_reply. Never fails open: no UI / no agent / timeout → rejected.
      const q = questions[0] || {}
      const meta = payload.swarmflow_meta
      const reason = String(q.question || 'SwarmFlow is waiting for your input').slice(0, 2000)
      let outcome = 'unavailable'
      if (approval?.request && agent) {
        outcome = await withTimeout(
          Promise.resolve(approval.request({ agent, toolName: `swarmflow:${meta.agent_name || meta.agent_id || 'human'}`, reason, signal })).catch(() => 'unavailable'),
          cfg.approvalTimeoutMs, 'timeout', signal)
      } else if (!approval?.request) outcome = 'no-ui'
      const allow = outcome === 'allowed-once'
      const answerText = allow ? 'approved' : `rejected (${outcome})`
      return {
        kind: 'swarmflow', outcome, answerText,
        answers: [{ selected_options: [], custom_input: answerText }],
        note: `• swarmflow ${meta.agent_name || meta.agent_id || 'human'}: ${answerText}`,
      }
    }

    if (eventType === 'plan.approval_required' || APPROVAL_SOURCES.has(payload?.source)) {
      const q = questions[0] || payload || {}
      const toolName = String(q.tool_name || payload?.tool_name || (eventType === 'plan.approval_required' || payload?.source === 'confirm_interrupt' ? 'exit_plan_mode' : 'jiuwen-tool'))
      const reason = String(q.question || q.message || payload?.message || payload?.content || `Jiuwen requests permission: ${toolName}`).slice(0, 2000)
      let outcome = 'unavailable'
      if (approval?.request && agent) {
        outcome = await withTimeout(
          Promise.resolve(approval.request({ agent, toolName, reason, signal })).catch(() => 'unavailable'),
          cfg.approvalTimeoutMs, 'timeout', signal)
      } else if (!approval?.request) outcome = 'no-ui'
      const allow = outcome === 'allowed-once'
      return {
        kind: 'approval', outcome,
        answers: approvalAnswers(questions.length ? questions : [payload || {}], allow, payload?.plan_actions),
        note: `• approval ${toolName}: ${allow ? 'allowed once' : 'denied'} (${outcome})`,
      }
    }

    if (!told || !questions.length) return null
    const items = questions.map((q, i) => ({
      id: String(q.id || q.question_id || `q${i + 1}`),
      question: String(q.question || q.text || q.header || 'Input needed'),
      ...(q.header ? { header: String(q.header).slice(0, 60) } : {}),
      ...(Array.isArray(q.options) && q.options.length ? {
        options: q.options.map(o => typeof o === 'string' ? { label: o } : { label: String(o.label || o.value || '?'), ...(o.description ? { description: String(o.description) } : {}) }),
      } : {}),
      ...((q.multi_select ?? q.multiSelect) ? { multiSelect: true } : {}),
    }))
    if (userQuestions?.ask) {
      // A pending question must not block chat: a typed message supersedes the card (see noteUserMessage);
      // the turn then ends and that message is delivered to Jiuwen as the answer on the next turn.
      const ac = new AbortController()
      const onParent = () => ac.abort()
      signal?.addEventListener?.('abort', onParent, { once: true })
      if (agent) subscribe()
      if (agent) pendingAsks.set(String(dshSessionId), { agent, ac })
      try {
        const ask = Promise.resolve(userQuestions.ask({ questions: items, ...(agent ? { agent } : {}), signal: ac.signal }))
        ask.catch(() => {})
        const res = await withTimeout(ask, cfg.questionTimeoutMs, null, ac.signal)
        if (ac.signal.aborted && !signal?.aborted) {
          return { kind: 'question', outcome: 'superseded', defer: true, note: '• question left open; your next message answers it' }
        }
        if (res && Array.isArray(res.answers)) {
          return { kind: 'question', outcome: 'answered', answers: questionAnswers(questions, items, res.answers), note: '• answered via dsh user-questions' }
        }
      } catch (error) {
        if (ac.signal.aborted && !signal?.aborted) return { kind: 'question', outcome: 'superseded', defer: true, note: '• question left open; your next message answers it' }
        deps.logger?.debug?.(`[dsh-jiuwen] user-questions unavailable: ${error?.code || error?.message}`)
      } finally {
        signal?.removeEventListener?.('abort', onParent)
        if (pendingAsks.get(String(dshSessionId))?.ac === ac) pendingAsks.delete(String(dshSessionId))
      }
    }
    {
      // We told Jiuwen we can answer; never leave it paused. Fall back to a neutral reply.
      return {
        kind: 'question', outcome: 'no-ui',
        answers: questions.map(q => ({ selected_options: [], custom_input: cfg.noUiAnswer, ...(q.card_id ? { card_id: q.card_id } : {}) })),
        note: '• no interactive user available; told Jiuwen to proceed',
      }
    }
    return null
  }
  interact.noteUserMessage = noteUserMessage
  interact.pendingCount = () => pendingAsks.size
  return interact
}

export function approvalAnswers(questions, allow, planActions) {
  return questions.map((q) => {
    const opts = [...(Array.isArray(q.options) ? q.options : []), ...(Array.isArray(planActions) ? planActions : [])]
      .map(o => typeof o === 'string' ? { value: o, label: o } : o).filter(Boolean)
    const re = allow ? ALLOW_RE : REJECT_RE
    const hit = opts.find(o => re.test(String(o.value ?? ''))) || opts.find(o => re.test(String(o.label ?? '')))
    const selected = String(hit?.value ?? hit?.label ?? (allow ? 'allow_once' : 'reject'))
    return { selected_options: [selected], custom_input: allow ? '' : 'Denied by dsh host', ...(q.card_id ? { card_id: q.card_id } : {}) }
  })
}

export function questionAnswers(questions, items, answers) {
  return questions.map((q, i) => {
    const a = answers.find(x => x?.id === items[i].id) || answers[i] || { selected: [] }
    const opts = Array.isArray(q.options) ? q.options : []
    const selected = (a.selected || []).map(label => {
      const o = opts.find(x => (typeof x === 'string' ? x : x.label) === label)
      return String(o && typeof o === 'object' ? (o.value ?? o.label) : label)
    })
    return { selected_options: selected, custom_input: a.custom || selected.join(', '), ...(q.card_id ? { card_id: q.card_id } : {}) }
  })
}

function withTimeout(promise, ms, fallback, signal) {
  if (!(ms > 0)) return promise
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(fallback), ms)
    const onAbort = () => { clearTimeout(t); resolve(fallback) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    promise.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}
