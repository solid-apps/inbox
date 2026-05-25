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

// --- inbox discovery (WebID ldp:inbox → fallback pod-relative) ---
async function discoverInbox() {
  const fallback = new URL('../../../inbox/', location.href).href
  const webid = myWebId()
  if (!webid) return fallback
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
  } catch { /* fall back */ }
  return fallback
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
