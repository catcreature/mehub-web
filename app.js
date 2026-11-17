// MeHub on the web. The browser is a companion of the hub phone, never a chat member: the Worker
// deletes a chat message the moment a phone acks it, and a chat key never leaves the phone, so the
// phone holds the only copy of the history and mirrors it here itself.
//
// What that means while you use it: this page shows what the phone has sent it, and anything typed here
// is carried out by the phone. With the phone off or offline, the chats you already have stay readable
// and what you write waits. The Worker sees sealed envelopes and nothing else.
import * as mirror from './mirror.js';
import {
  formatWebSignIn, fromBase64Url, fingerprint, isPublicKey, newId, newKeys, open, safetyCode, seal,
  sessionKey, toBase64Url,
} from './crypto.js';
import { qrCode } from './qr.js';

const SERVER = 'https://mehub.binhans2closter.workers.dev';
const POLL_MS = 3000;
const IDLE_POLL_MS = 15000;
const WAIT_MS = 2000;
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const STORE = 'mehub.web.session';

const el = (id) => document.getElementById(id);
const show = (id, on) => el(id).toggleAttribute('hidden', !on);

// Everything the page holds. The chats live in memory only: a reload asks the phone again, so a closed
// tab leaves no messages behind on the computer.
const state = {
  session: null,
  key: null,
  chats: new Map(),
  messages: new Map(),
  reactions: new Map(),
  openChat: null,
  synced: false,
  cursor: 0,
  sending: [],
  polling: false,
  stopped: false,
};

async function api(path, body, secret) {
  const headers = { 'content-type': 'application/json' };
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(`${SERVER}/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  let answer = {};
  try {
    answer = await res.json();
  } catch (e) {
    // An empty or non-JSON answer is reported by its status alone.
  }
  if (!res.ok) {
    const error = new Error(answer.error || `http_${res.status}`);
    error.status = res.status;
    error.code = answer.error;
    throw error;
  }
  return answer;
}

// ---------------------------------------------------------------- signing in

async function signIn() {
  show('sign-in', true);
  show('chats', false);
  el('sign-in-error').hidden = true;
  el('code').textContent = '········';
  const keys = await newKeys();
  const started = await api('webnew', { pub: toBase64Url(keys.pub), name: browserName() });
  el('code').textContent = `${started.code.slice(0, 4)} ${started.code.slice(4)}`;
  // The code the phone scans, types or is pasted. The checksum formatWebSignIn adds is what lets the
  // phone refuse a misread photograph without asking the server about it.
  const signIn = await formatWebSignIn(started.link, await fingerprint(keys.pub));
  el('link').value = signIn;
  // The characters beside it are a whole way in on their own, so a QR that cannot be drawn takes
  // itself off the page instead of taking the sign-in down with it. ([hidden] is !important here.)
  try {
    drawQr(el('qr'), signIn);
  } catch (e) {
    el('qr').hidden = true;
  }
  // Until the phone claims it, this page is nothing but a waiting room.
  const until = Date.now() + (started.waitMs || 5 * 60 * 1000);
  while (!state.stopped) {
    await sleep(WAIT_MS);
    let waited;
    try {
      waited = await api('webwait', {}, started.secret);
      setStatus(null);
    } catch (e) {
      if (e.status === 401) return fail('This sign-in is gone. Reload for a new code.');
      // Still waiting, just not heard from: the code on screen is good either way.
      setStatus("Can't reach the server — still trying.");
      continue;
    }
    if (waited.state === 'live') {
      const hubPub = fromBase64Url(waited.pub || '');
      if (!isPublicKey(hubPub)) return fail("The phone's key didn't make sense. Reload and try again.");
      state.key = await sessionKey(keys.priv, hubPub, keys.pub, hubPub);
      state.session = { id: waited.id, secret: started.secret };
      save();
      el('safety').textContent = await safetyCode(keys.pub, hubPub);
      show('safety-row', true);
      return live();
    }
    if (waited.state === 'expired' || Date.now() > until) {
      return fail('That code has expired. Reload for a new one.');
    }
  }
}

// The sign-in card is hidden the moment the phone answers, so anything that goes wrong after that has
// to be said in the header, which is always on screen.
function fail(text) {
  el('sign-in-error').textContent = text;
  el('sign-in-error').hidden = false;
  setStatus(text);
}

// The sign-in code drawn for a phone's camera: four modules of quiet zone, as the standard asks, and a
// whole number of pixels a module, so no module comes out a different width from its neighbour. Always
// dark on light, whatever this page's theme, because that is what a camera is looking for.
function drawQr(canvas, text) {
  const modules = qrCode(text);
  const quiet = 4;
  const scale = Math.max(4, Math.floor(300 / (modules.length + quiet * 2)));
  const side = (modules.length + quiet * 2) * scale;
  canvas.width = side;
  canvas.height = side;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, side, side);
  g.fillStyle = '#000000';
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules.length; x++) {
      if (modules[y][x]) g.fillRect((quiet + x) * scale, (quiet + y) * scale, scale, scale);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the phone's list of signed-in browsers will call this one. It is this browser's own word, so the
// phone trims it and never trusts it for anything.
function browserName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const system = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'a Mac' : /Android/.test(ua) ? 'Android'
    : /Linux/.test(ua) ? 'Linux' : /iPhone|iPad/.test(ua) ? 'iOS' : null;
  return system ? `${browser} on ${system}` : browser;
}

// The session, so a reload does not need the phone again. The key is not stored: it is kept in memory
// only, and a reload derives nothing — it signs in again. What is stored is enough to sign out.
function save() {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(state.session));
  } catch (e) {
    // A browser with storage blocked works the same; it just cannot sign itself out after a reload.
  }
}

async function signOut() {
  const session = state.session;
  state.stopped = true;
  try {
    sessionStorage.removeItem(STORE);
  } catch (e) {
    // Nothing to clear.
  }
  if (session) {
    try {
      await api('webrevoke', {}, session.secret);
    } catch (e) {
      // Signed out here regardless; the phone can do the same from its own list.
    }
  }
  location.reload();
}

// ---------------------------------------------------------------- the mirror

async function live() {
  show('sign-in', false);
  show('chats', true);
  state.synced = false;
  renderList();
  // Ask for everything: the phone answers with every chat, its messages and its reactions.
  await post([mirror.record(mirror.R_HELLO)]);
  poll();
}

async function post(records) {
  const envelopes = [];
  for (const plain of mirror.packRecords(records)) {
    envelopes.push({ ct: await seal(state.key, state.session.id, mirror.TO_PHONE, plain) });
  }
  for (let i = 0; i < envelopes.length; i += mirror.MAX_ENVELOPES) {
    await api('webpost', { envelopes: envelopes.slice(i, i + mirror.MAX_ENVELOPES) }, state.session.secret);
  }
}

async function poll() {
  if (state.polling) return;
  state.polling = true;
  while (!state.stopped) {
    let got;
    try {
      got = await api('webpoll', { after: state.cursor }, state.session.secret);
      setStatus(null);
    } catch (e) {
      if (e.status === 401) {
        setStatus('Your phone signed this browser out.');
        state.stopped = true;
        break;
      }
      setStatus("Can't reach the server.");
      await sleep(POLL_MS);
      continue;
    }
    let applied = 0;
    for (const envelope of got.envelopes) {
      const plain = await open(state.key, state.session.id, mirror.TO_BROWSER, envelope.ct);
      if (plain !== null) {
        for (const r of mirror.decodeRecords(plain)) apply(r);
        applied++;
      }
      state.cursor = envelope.seq;
    }
    if (applied) {
      sweep();
      render();
    }
    if (!got.more) await sleep(document.hidden ? IDLE_POLL_MS : POLL_MS);
  }
  state.polling = false;
}

function apply(r) {
  const kind = r[0];
  if (kind === mirror.R_CHAT) {
    const chat = mirror.readChat(r);
    state.chats.set(chat.id, chat);
  } else if (kind === mirror.R_MESSAGE) {
    const m = mirror.readMessage(r);
    state.messages.set(m.id, m);
    // A message of mine the phone has now taken is no longer only waiting here.
    state.sending = state.sending.filter((s) => s.id !== m.id);
  } else if (kind === mirror.R_REACTION) {
    const reaction = mirror.readReaction(r);
    const held = state.reactions.get(reaction.message) || {};
    if (reaction.emoji) held[reaction.mine ? 'mine' : 'theirs'] = reaction.emoji;
    else delete held[reaction.mine ? 'mine' : 'theirs'];
    state.reactions.set(reaction.message, held);
  } else if (kind === mirror.R_DROP_CHAT) {
    const id = r[1];
    state.chats.delete(id);
    for (const [key, m] of state.messages) if (m.chat === id) state.messages.delete(key);
    if (state.openChat === id) state.openChat = null;
  } else if (kind === mirror.R_DROP_MESSAGE) {
    state.messages.delete(r[1]);
  } else if (kind === mirror.R_SYNCED) {
    state.synced = true;
  }
}

// Every message goes 24 hours after it was sent, on the phone and here alike: the page drops its own
// rather than waiting to be told, so a tab left open never shows a message that has already gone.
function sweep() {
  const cutoff = Date.now() - LIFETIME_MS;
  for (const [id, m] of state.messages) if (m.sentAt <= cutoff) state.messages.delete(id);
}

// ---------------------------------------------------------------- the screen

function setStatus(text) {
  el('status').textContent = text || '';
  el('status').hidden = !text;
}

function render() {
  renderList();
  renderChat();
}

const nameOf = (chat) => chat.name || 'Someone';

function chatMessages(id) {
  const out = [...state.messages.values()].filter((m) => m.chat === id);
  for (const s of state.sending) if (s.chat === id) out.push(s);
  return out.sort((a, b) => a.sentAt - b.sentAt);
}

function renderList() {
  const list = el('list');
  const chats = [...state.chats.values()].filter((c) => c.gone === mirror.GONE_NO && c.joined);
  const waiting = [...state.chats.values()].filter((c) => !c.joined && c.gone === mirror.GONE_NO);
  chats.sort((a, b) => {
    const last = (c) => Math.max(c.since, ...chatMessages(c.id).map((m) => m.sentAt), 0);
    return last(b) - last(a);
  });
  list.textContent = '';
  if (!state.synced) {
    list.append(line('Asking your phone…', 'empty'));
  } else if (!chats.length) {
    list.append(line(waiting.length ? 'Nobody has joined yet.' : 'No chats yet. Invite someone from your phone.', 'empty'));
  }
  for (const chat of chats) {
    const messages = chatMessages(chat.id);
    const last = messages[messages.length - 1];
    const row = document.createElement('button');
    row.className = `row${state.openChat === chat.id ? ' on' : ''}`;
    row.append(avatar(chat));
    const body = document.createElement('span');
    body.className = 'row-body';
    body.append(line(nameOf(chat), 'row-name'));
    body.append(line(last ? preview(last) : 'No messages', 'row-last'));
    row.append(body);
    if (chat.unread) row.append(line(String(chat.unread), 'badge'));
    row.onclick = () => openChat(chat.id);
    list.append(row);
  }
}

const preview = (m) => (m.file ? `📎 ${m.file.name}` : m.text).replace(/\s+/g, ' ').slice(0, 60);

function avatar(chat) {
  const span = document.createElement('span');
  span.className = 'avatar';
  span.textContent = initials(chat.name);
  span.style.background = colourOf(chat);
  return span;
}

// The phone's own avatar colours and chat colours, so a chat looks the same in both places.
const AVATARS = ['#FF6B4A', '#4FB3FF', '#34D399', '#A78BFA', '#F472B6', '#FF9F43'];
const CHAT_COLOURS = ['#FF6B4A', '#FF9F43', '#F5C518', '#34D399', '#4FB3FF', '#A78BFA', '#F472B6', '#94A3B8'];

const colourOf = (chat) =>
  chat.colour > 0 && chat.colour < CHAT_COLOURS.length ? CHAT_COLOURS[chat.colour] : AVATARS[hash(chat.id) % AVATARS.length];

const hash = (id) => [...String(id)].reduce((n, c) => n + c.charCodeAt(0), 0);

function initials(name) {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const take = (w, n) => [...w].slice(0, n).join('');
  return (words.length === 1 ? take(words[0], 2) : take(words[0], 1) + take(words[1], 1)).toUpperCase();
}

function line(text, className) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function openChat(id) {
  state.openChat = id;
  const chat = state.chats.get(id);
  if (chat && chat.unread) {
    chat.unread = 0;
    post([mirror.record(mirror.R_READ, id)]).catch(() => {});
  }
  render();
  el('composer-field').focus();
}

function renderChat() {
  const chat = state.chats.get(state.openChat);
  show('composer', Boolean(chat));
  const head = el('chat-head');
  const thread = el('thread');
  head.textContent = '';
  thread.textContent = '';
  if (!chat) {
    thread.append(line(state.synced ? 'Pick a chat.' : '', 'empty'));
    return;
  }
  head.append(avatar(chat), line(nameOf(chat), 'chat-name'));
  const messages = chatMessages(chat.id);
  if (!messages.length) thread.append(line('Nothing here yet. Everything goes 24 hours after it is sent.', 'empty'));
  for (const m of messages) thread.append(bubble(m, chat));
  thread.scrollTop = thread.scrollHeight;
}

function bubble(m, chat) {
  const wrap = document.createElement('div');
  wrap.className = `bubble ${m.mine ? 'mine' : 'theirs'}`;
  if (m.mine && chat.colour > 0) wrap.style.background = CHAT_COLOURS[chat.colour];
  if (m.quote) {
    const quoted = state.messages.get(m.quote);
    wrap.append(line(quoted ? preview(quoted) : 'A message that has gone', 'quote'));
  }
  if (m.file) {
    // A file's bytes never come here: the phone holds them, and that is where it opens.
    wrap.append(line(`📎 ${m.file.name}`, 'file-name'));
    wrap.append(line(`${size(m.file.size)} · open it on your phone`, 'file-note'));
  } else {
    wrap.append(line(m.text, 'text'));
  }
  const held = state.reactions.get(m.id);
  const emojis = held ? [held.theirs, held.mine].filter(Boolean) : [];
  if (emojis.length) wrap.append(line(emojis.join(' '), 'reaction'));
  wrap.append(line(`${clock(m.sentAt)}${m.mine ? ` ${tick(m.state)}` : ''}`, 'meta'));
  return wrap;
}

const size = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const tick = (s) =>
  s === mirror.DELIVERED ? '✓✓' : s === mirror.SENT ? '✓' : s === mirror.FAILED ? 'not sent' : '…';

// ---------------------------------------------------------------- composing

async function send() {
  const field = el('composer-field');
  const text = field.value.trim();
  const chat = state.openChat;
  if (!text || !chat) return;
  if (text.length > mirror.MAX_CHARS) return;
  field.value = '';
  // Shown here at once, with the phone's own id, so when the phone sends it back it is the same message.
  const m = { id: newId(), chat, mine: true, sentAt: Date.now(), state: mirror.SENDING, text, quote: null, file: null };
  state.sending.push(m);
  render();
  try {
    await post([mirror.record(mirror.R_SEND, chat, m.id, text, null)]);
  } catch (e) {
    m.state = mirror.FAILED;
    render();
  }
}

// ---------------------------------------------------------------- start

function start() {
  el('composer-send').onclick = send;
  el('composer-field').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  el('sign-out').onclick = signOut;
  el('copy-link').onclick = () => {
    el('link').select();
    document.execCommand('copy');
  };
  if (!crypto.subtle) {
    fail('This browser has no Web Crypto, which MeHub on the web needs. Try Chrome, Edge, Firefox or Safari over https.');
    show('sign-in', true);
    return;
  }
  // A reload always signs in again: the session key is never written down, so there is nothing to
  // resume from. The old session is signed out first, so it does not hold one of the four places.
  let old = null;
  try {
    old = JSON.parse(sessionStorage.getItem(STORE) || 'null');
  } catch (e) {
    old = null;
  }
  // Whatever went wrong is said plainly: a guess at the cause sent one report down the wrong path.
  const begin = () =>
    signIn().catch((e) => {
      if (e.code === 'busy') return fail('The server is busy. Try again in a minute.');
      if (e.code) return fail(`The server answered "${e.code}" (${e.status}). Reload to try again.`);
      fail(`Sign-in stopped: ${e.message}. Reload to try again.`);
      console.error(e);
    });
  if (old && old.secret) {
    sessionStorage.removeItem(STORE);
    api('webrevoke', {}, old.secret).catch(() => {}).then(begin);
  } else {
    begin();
  }
}

start();
