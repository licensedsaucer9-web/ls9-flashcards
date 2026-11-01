import { buildInfo } from './build-info.ts'
import { $, esc } from './dom.ts'
import { feedbackProblem, MAX_FEEDBACK_MESSAGE } from './feedback.ts'
import { sendFeedback } from './sync-backend.ts'

// Settings re-renders on account and sync changes; the draft lives here so an
// open form, typed text and the last result survive that and a failed send.
const draft = { open: false, message: '', email: '', status: '', sending: false }

export function feedbackPanelHtml(): string {
  return `
      <div class="setting" id="feedback-setting">
        <p class="kicker" style="margin:0">Feedback</p>
        <p class="note">Tell us what works, what does not, or what you would like next.</p>
        <button type="button" class="secondary" id="feedback-open" aria-expanded="${draft.open}" aria-controls="feedback-form" ${draft.open ? 'hidden' : ''}>Send feedback</button>
        <form class="feedback-form" id="feedback-form" novalidate ${draft.open ? '' : 'hidden'}>
          <label for="feedback-message">Message
            <textarea id="feedback-message" rows="5" aria-describedby="feedback-count">${esc(draft.message)}</textarea>
          </label>
          <p class="note feedback-count" id="feedback-count"></p>
          <label for="feedback-email">Email (optional)
            <input type="email" id="feedback-email" autocomplete="email" inputmode="email" spellcheck="false" aria-describedby="feedback-email-note" value="${esc(draft.email)}" />
          </label>
          <p class="note" id="feedback-email-note">Only if you would like a reply.</p>
          <p class="note feedback-problem" id="feedback-problem" aria-live="polite"></p>
          <div class="feedback-actions">
            <button type="button" class="ghost" id="feedback-cancel">Cancel</button>
            <button type="submit" class="primary" id="feedback-send">Send</button>
          </div>
        </form>
        <p class="note" id="feedback-status" role="status" aria-live="polite">${esc(draft.status)}</p>
      </div>`
}

export function bindFeedbackPanel(): void {
  const open = $('#feedback-open') as HTMLButtonElement
  const form = $('#feedback-form') as HTMLFormElement
  const message = $('#feedback-message') as HTMLTextAreaElement
  const email = $('#feedback-email') as HTMLInputElement
  const count = $('#feedback-count')
  const problemEl = $('#feedback-problem')
  const send = $('#feedback-send') as HTMLButtonElement
  const cancel = $('#feedback-cancel') as HTMLButtonElement
  const status = $('#feedback-status')

  const refresh = () => {
    const length = message.value.trim().length
    count.textContent = `${length} / ${MAX_FEEDBACK_MESSAGE}`
    count.classList.toggle('is-over', length > MAX_FEEDBACK_MESSAGE)
    const problem = feedbackProblem(message.value, email.value)
    // An untouched form just disables Send; explain once the user has typed something.
    problemEl.textContent = problem && (message.value.trim() || email.value.trim()) ? problem : ''
    send.disabled = draft.sending || problem !== null
    send.textContent = draft.sending ? 'Sending…' : 'Send'
    message.disabled = draft.sending
    email.disabled = draft.sending
    cancel.disabled = draft.sending
  }
  const show = (next: boolean) => {
    draft.open = next
    form.hidden = !next
    open.hidden = next
    open.setAttribute('aria-expanded', String(next))
  }

  open.addEventListener('click', () => {
    draft.status = ''
    status.textContent = ''
    show(true)
    refresh()
    message.focus()
  })
  cancel.addEventListener('click', () => {
    show(false)
    open.focus()
  })
  message.addEventListener('input', () => { draft.message = message.value; refresh() })
  email.addEventListener('input', () => { draft.email = email.value; refresh() })
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (draft.sending || feedbackProblem(message.value, email.value)) return
    // Sync from the live fields: autofill can change a value without an input event.
    draft.message = message.value
    draft.email = email.value
    draft.sending = true
    draft.status = 'Sending…'
    status.textContent = draft.status
    refresh()
    // The form stays locked until the write settles: a slow send is still queued and
    // will arrive, so unlocking it would let a retry create a second document.
    const result = await sendFeedback({ message: draft.message, email: draft.email, appVersion: buildInfo.version }, () => {
      draft.status = 'Still sending… Waiting for the server; your message will go out when the connection returns. Keep the app open.'
      const current = document.querySelector('#feedback-status')
      if (current) current.textContent = draft.status
    })
    draft.sending = false
    if (result.ok) {
      draft.message = ''
      draft.email = ''
      draft.open = false
      draft.status = 'Thanks! Your feedback was sent.'
    } else {
      draft.status = `Not sent: ${result.message}`
    }
    // Settings may have re-rendered while waiting, so redraw whichever copy is on screen.
    renderPanel()
    const next = document.querySelector<HTMLElement>(result.ok ? '#feedback-open' : '#feedback-send')
    next?.focus()
  })
  refresh()
}

function renderPanel(): void {
  const setting = document.querySelector('#feedback-setting')
  if (!setting) return
  setting.outerHTML = feedbackPanelHtml()
  bindFeedbackPanel()
}
