/**
 * Host-answered Jiuwen interactions.
 *
 *  - chat.ask_user_question (source ask_user_interrupt / plain)  → ctx.userQuestions.ask()  (dsh-user-questions)
 *
 * Returns `{ kind, outcome, answers, note }` in Jiuwen's answer shape
 * (`[{ selected_options: [...], custom_input, card_id? }]`), or null to keep the legacy
 * "print the question and end the turn" behaviour.
 */


/** @param {{ services: () => { userQuestions?: any, approval?: any, agents?: any }, config: () => any, logger?: any }} deps */
export function createInteractor(deps) {
  return async function interact({ eventType, payload, signal, told }, dshSessionId) {
    const cfg = deps.config()
    const { userQuestions, agents } = deps.services() || {}
    const questions = Array.isArray(payload?.questions) ? payload.questions.filter(q => q && typeof q === 'object') : []
    let agent
    try { agent = agents?.get?.(dshSessionId) } catch { agent = undefined }

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
      try {
        const res = await withTimeout(userQuestions.ask({ questions: items, ...(agent ? { agent } : {}), signal }), cfg.questionTimeoutMs, null, signal)
        if (res && Array.isArray(res.answers)) {
          return { kind: 'question', outcome: 'answered', answers: questionAnswers(questions, items, res.answers), note: '• answered via dsh user-questions' }
        }
      } catch (error) {
        deps.logger?.debug?.(`[dsh-jiuwen] user-questions unavailable: ${error?.code || error?.message}`)
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
