// inbox — read your Solid pod's inbox (v1, read-only).
//
// Lists, reads and deletes the notifications delivered to your pod's LDN inbox
// (discovered via your WebID's ldp:inbox; falls back to <pod>/inbox/). The
// inbox is owner-only, so you must be signed in. Messages are parsed as
// ActivityStreams (as:Note / as:Create), the same shape ActivityPub uses — so
// today's reader already understands fediverse-shaped notifications.
//
// Sending/composing is intentionally out of scope for v1.

const appEl = document.getElementById('app')
const AS = 'https://www.w3.org/ns/activitystreams#'

const authFetch = (url, opts) => ((window.xlogin && window.xlogin.authFetch) || fetch)(url, opts)
const loggedIn = () => !!(window.xlogin && window.xlogin.id)
const myWebId = () => (window.xlogin && window.xlogin.id) || null

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// --- tolerant JSON-LD / ActivityStreams helpers ---
// AS terms may appear bare ("content"), as:-prefixed, or as full URIs.
function field(obj, term) {
  if (obj == null || typeof obj !== 'object') return undefined
  if (obj[term] !== undefined) return obj[term]
  if (obj['as:' + term] !== undefined) return obj['as:' + term]
  return obj[AS + term]
}
function idOf(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return idOf(v[0])
  return v['@id'] || v.id || ''
}
function valOf(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(valOf).filter(Boolean).join(', ')
  return v['@value'] || valOf(field(v, 'name')) || v['@id'] || ''
}
function typeOf(n) {
  const t = n && (n['@type'] || field(n, 'type'))
  return idOf(Array.isArray(t) ? t[0] : t).replace(/^.*[#/]/, '') || ''
}

// --- inbox discovery (WebID ldp:inbox) ---
// Resolve any WebID's ldp:inbox — used to find your own inbox to read, and a
// recipient's inbox to send to.
async function inboxOf(webid) {
  try {
    const r = await authFetch(webid, { headers: { Accept: 'application/ld+json' } })
    if (r.ok) {
      const doc = await r.json()
      const nodes = Array.isArray(doc) ? doc : (doc['@graph'] || [doc])
      for (const n of nodes) {
        const inbox = n.inbox || n['ldp:inbox'] || n['http://www.w3.org/ns/ldp#inbox']
        if (inbox) return new URL(idOf(inbox), webid).href
      }
    }
  } catch { /* unreachable / cross-origin */ }
  return null
}
async function discoverInbox() {
  const webid = myWebId()
  return (webid && await inboxOf(webid)) || new URL('../../../inbox/', location.href).href
}

// Send an ActivityStreams Create{Note} to a recipient's inbox. acl:Append is
// public, so this works to any pod's inbox (CORS permitting). To yourself = a
// note that lands back in your own list.
async function sendMessage({ to, subject, body }) {
  const inbox = await inboxOf(to)
  if (!inbox) throw new Error('no inbox found for that WebID')
  const me = myWebId()
  const now = new Date().toISOString()
  const msg = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'Create',
    actor: me,
    to,
    published: now,
    object: { type: 'Note', summary: subject, content: body, attributedTo: me, published: now }
  }
  const res = await authFetch(inbox, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(msg)
  })
  if (!res.ok) throw new Error(`send failed (${res.status})`)
}

// --- listing + parsing ---
function ldpContains(doc) {
  const c = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc.contains || []
  return (Array.isArray(c) ? c : [c]).map((x) => (typeof x === 'string' ? x : x['@id'] || x.id)).filter(Boolean)
}

function parseMessage(doc) {
  let node = doc
  if (doc && doc['@graph']) {
    const g = doc['@graph']
    node = g.find((n) => n['@type'] || field(n, 'type')) || g[0] || doc
  }
  // Unwrap a wrapping activity (Create / Announce / Update) to its object.
  const obj = field(node, 'object')
  const inner = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : node
  const actor = field(node, 'actor') ?? field(inner, 'actor') ?? field(node, 'attributedTo') ?? field(inner, 'attributedTo')
  return {
    type: typeOf(inner) || typeOf(node) || 'Note',
    from: idOf(actor) || valOf(actor),
    fromName: (actor && typeof actor === 'object' && !Array.isArray(actor)) ? valOf(field(actor, 'name')) : '',
    subject: valOf(field(inner, 'summary') ?? field(inner, 'name') ?? field(node, 'summary')),
    content: valOf(field(inner, 'content') ?? (typeOf(inner) === 'Note' ? field(inner, 'name') : '')),
    published: valOf(field(node, 'published') ?? field(inner, 'published'))
  }
}

async function listMessages(inboxUrl) {
  const r = await authFetch(inboxUrl, { headers: { Accept: 'application/ld+json' } })
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) { const e = new Error('signin'); e.code = 'signin'; throw e }
    return []
  }
  const urls = ldpContains(await r.json())
    .map((u) => new URL(u, inboxUrl).href)
    .filter((u) => !u.endsWith('/') && !u.split('/').pop().startsWith('.'))
  const out = []
  for (const u of urls) {
    try {
      const mr = await authFetch(u, { headers: { Accept: 'application/ld+json' } })
      if (!mr.ok) continue
      out.push({ url: u, ...parseMessage(await mr.json()) })
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => (b.published || '').localeCompare(a.published || ''))
  return out
}

async function removeMessage(url) {
  const res = await authFetch(url, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(`delete failed (${res.status})`)
}

// --- UI ---
function toast(msg) {
  let t = document.querySelector('.toast')
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t) }
  t.textContent = msg; t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 2400)
}

// Compose form. "To" prefills with your own WebID, so the first send is a
// note-to-self that appears in the list below — the simplest way to prove
// the round-trip.
function composer() {
  const me = myWebId() || ''
  const wrap = document.createElement('div')
  wrap.className = 'composer'
  wrap.innerHTML = `
    <input class="c-to" placeholder="To (WebID)" value="${esc(me)}">
    <input class="c-subj" placeholder="Subject">
    <textarea class="c-body" placeholder="Message" rows="4"></textarea>
    <div class="form-actions">
      <button class="c-send">Send</button>
      <button class="c-cancel ghost">Cancel</button>
    </div>
    <p class="hint muted">Delivered to the recipient's inbox (their WebID's <code>ldp:inbox</code>).</p>`
  wrap.querySelector('.c-cancel').onclick = () => render()
  wrap.querySelector('.c-send').onclick = async (e) => {
    const to = wrap.querySelector('.c-to').value.trim()
    const subject = wrap.querySelector('.c-subj').value.trim()
    const body = wrap.querySelector('.c-body').value.trim()
    if (!to) { toast('Add a recipient WebID'); return }
    if (!subject && !body) { toast('Add a subject or message'); return }
    e.currentTarget.disabled = true
    try { await sendMessage({ to, subject, body }); toast('sent'); await render() }
    catch (err) { toast(String(err.message || err)); e.currentTarget.disabled = false }
  }
  return wrap
}

const shortFrom = (m) => m.fromName || (m.from ? m.from.replace(/#.*$/, '').replace(/\/$/, '').split('/').slice(-2).join('/') : 'unknown')
const when = (iso) => { const d = iso && new Date(iso); return (d && !isNaN(d)) ? d.toLocaleString() : '' }

let MESSAGES = []

function messageCard(m) {
  const row = document.createElement('div')
  row.className = 'msg'
  row.innerHTML = `
    <div class="msg-head">
      <span class="from">${esc(shortFrom(m))}</span>
      <span class="badge">${esc(m.type)}</span>
      <span class="time">${esc(when(m.published))}</span>
    </div>
    <div class="subject">${esc(m.subject || '(no subject)')}</div>
    <div class="snippet">${esc((m.content || '').slice(0, 140))}${(m.content || '').length > 140 ? '…' : ''}</div>
    <div class="body" hidden></div>
    <div class="msg-actions">
      <button class="open ghost">Open</button>
      <button class="del ghost danger">Delete</button>
    </div>`
  const body = row.querySelector('.body')
  const snippet = row.querySelector('.snippet')
  const openBtn = row.querySelector('.open')
  openBtn.onclick = () => {
    const showing = !body.hidden
    body.hidden = showing
    snippet.hidden = !showing
    if (!showing) { body.textContent = m.content || '(no content)'; openBtn.textContent = 'Close' }
    else openBtn.textContent = 'Open'
  }
  row.querySelector('.del').onclick = async () => {
    if (!confirm('Delete this message?')) return
    try { await removeMessage(m.url); toast('deleted'); await render() } catch (e) { toast(String(e.message || e)) }
  }
  return row
}

async function render() {
  appEl.innerHTML = '<h1>Inbox</h1>'

  if (!loggedIn()) {
    appEl.insertAdjacentHTML('beforeend',
      '<p class="sub">Notifications delivered to your pod.</p>' +
      '<div class="signin-note">Your inbox is private — sign in (login pill, bottom-right) to read it.</div>')
    return
  }

  appEl.insertAdjacentHTML('beforeend', '<p class="sub muted">Loading…</p>')
  let err = null
  try {
    const inboxUrl = await discoverInbox()
    MESSAGES = await listMessages(inboxUrl)
  } catch (e) { err = e }

  appEl.innerHTML = `<h1>Inbox</h1>
    <p class="sub">${err ? '' : MESSAGES.length + ' ' + (MESSAGES.length === 1 ? 'message' : 'messages')}</p>`

  if (err) {
    appEl.insertAdjacentHTML('beforeend', err.code === 'signin'
      ? '<div class="signin-note">Your inbox is private — sign in to read it.</div>'
      : `<div class="signin-note">Couldn't read your inbox: ${esc(String(err.message || err))}</div>`)
    return
  }

  const bar = document.createElement('div')
  bar.className = 'toolbar'
  bar.innerHTML = '<button class="compose">Compose</button>'
  appEl.appendChild(bar)
  bar.querySelector('.compose').onclick = () => {
    const next = bar.nextElementSibling
    if (next && next.classList.contains('composer')) next.remove()
    else bar.after(composer())
  }

  if (!MESSAGES.length) {
    appEl.insertAdjacentHTML('beforeend', '<p class="muted">Your inbox is empty.</p>')
    return
  }
  const list = document.createElement('div')
  list.className = 'list'
  MESSAGES.forEach((m) => list.appendChild(messageCard(m)))
  appEl.appendChild(list)
}

render()
document.addEventListener('xlogin', render)
document.addEventListener('xlogout', render)
