// The record stream, the browser's side. A port of the phone's Mirror.kt: the first line of a record is
// how many fields follow, and every field is escaped to exactly one line. Not JSON, because the phone's
// half has to stay pure so it can be unit-tested there.

export const TO_BROWSER = 'h2w';
export const TO_PHONE = 'w2h';

// What the phone tells this browser.
export const R_CHAT = 'c';
export const R_MESSAGE = 'm';
export const R_REACTION = 'r';
export const R_DROP_CHAT = 'dc';
export const R_DROP_MESSAGE = 'dm';
export const R_SYNCED = 'ok';
export const R_BYE = 'bye';

// What this browser asks the phone for.
export const R_HELLO = 'hi';
export const R_SEND = 's';
export const R_REACT = 're';
export const R_READ = 'rd';
export const R_RENAME = 'nm';

export const MAX_CHARS = 900;
const ENVELOPE_CHARS = 7000;
export const MAX_ENVELOPES = 8;
const MAX_FIELDS = 16;

const escape = (s) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

function unescape(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i === s.length - 1) {
      out += s[i];
      continue;
    }
    const next = s[i + 1];
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === '\\') out += '\\';
    // Anything else was never written by escape(): keep both characters rather than lose them.
    else out += s[i] + next;
    i++;
  }
  return out;
}

const field = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

export const record = (...fields) => fields.map(field);

export function encodeRecords(records) {
  let out = '';
  for (const r of records) {
    out += `${r.length}\n`;
    for (const f of r) out += `${escape(f)}\n`;
  }
  return out;
}

// Anything malformed ends the reading: what came before it is still good, and the rest is treated as
// not having arrived.
export function decodeRecords(text) {
  if (!text) return [];
  const whole = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  if (!whole) return [];
  const lines = whole.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === '') break;
    const count = /^\d+$/.test(lines[i]) ? Number(lines[i]) : NaN;
    if (!(count >= 1) || count > MAX_FIELDS || i + count >= lines.length) break;
    out.push(lines.slice(i + 1, i + 1 + count).map(unescape));
    i += count + 1;
  }
  return out;
}

export function packRecords(records) {
  const out = [];
  let batch = [];
  let size = 0;
  for (const r of records) {
    const n = encodeRecords([r]).length;
    if (batch.length && size + n > ENVELOPE_CHARS) {
      out.push(encodeRecords(batch));
      batch = [];
      size = 0;
    }
    batch.push(r);
    size += n;
  }
  if (batch.length) out.push(encodeRecords(batch));
  return out;
}

const str = (r, i) => r[i] ?? '';
const num = (r, i) => {
  const n = Number(str(r, i));
  return Number.isFinite(n) ? n : 0;
};
const flag = (r, i) => str(r, i) === '1';
const text = (r, i) => str(r, i) || null;

export const SENDING = 0;
export const SENT = 1;
export const FAILED = 2;
export const DELIVERED = 3;
export const GONE_NO = 0;

// The phone's word about one chat, read back into the shape this page renders. Nothing the phone sends
// is a secret: the chat keys stay on the phone, so there is nothing here to protect but the text.
export const readChat = (r) => ({
  id: str(r, 1),
  name: text(r, 2),
  colour: num(r, 3),
  joined: flag(r, 4),
  gone: num(r, 5),
  since: num(r, 6),
  unread: num(r, 7),
  code: text(r, 8),
  muted: flag(r, 9),
});

export const readMessage = (r) => ({
  id: str(r, 1),
  chat: str(r, 2),
  mine: flag(r, 3),
  sentAt: num(r, 4),
  state: num(r, 5),
  text: str(r, 6),
  quote: text(r, 7),
  file: flag(r, 11) ? { name: str(r, 8), size: num(r, 9), mime: str(r, 10) } : null,
});

export const readReaction = (r) => ({
  chat: str(r, 1),
  message: str(r, 2),
  mine: flag(r, 3),
  emoji: str(r, 4),
  at: num(r, 5),
});
