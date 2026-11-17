# MeHub on the web

The browser half of [MeHub](https://github.com/catcreature) — a companion to the hub phone, not a
client of its own.

Live at **https://catcreature.github.io/mehub-web/**

## Why it is a companion

MeHub's Worker deletes a chat message the moment a phone acknowledges it, and a chat key never leaves
the phone. So the phone holds the only copy of the history, and it mirrors that history to this page
itself. In practice:

- **The phone does the sending.** It has to be on and online for this page to catch up, or for a
  message typed here to go anywhere. Chats already mirrored stay readable; what you write waits.
- **The server reads nothing.** At sign-in the phone and this page agree a key by ECDH over P-256 that
  the Worker never sees, and every envelope between them is sealed with AES-256-GCM under it. The
  Worker stores ciphertext, exactly as it does for a chat message.
- **Messages still go after 24 hours**, here as on the phone. Nothing is written to disk in the
  browser: the session key is kept in memory only, so closing the tab ends the session.
- **Photos, files and voice messages** show as a card naming the file. Their bytes stay on the phone.

## Signing in

1. Open this page. It shows an eight-character code, good once, for five minutes.
2. On the phone: MeHub → ⋮ → **MeHub on the web** → **Type the code**.
3. Both sides then show six digits. They are derived from the two public keys, so if they match,
   nobody is in the middle. If they differ, sign out from the phone at once.

The page also offers a `mehubweb1:…` sign-in link, which carries the phone a fingerprint of this
browser's public key so the check happens automatically. Reading it with the phone's camera is coming.

## Running it

There is no build step. It is ES modules, served as files:

```sh
python -m http.server 5173     # http://localhost:5173 is allowed by the Worker's CORS
```

The Worker it talks to is set by `SERVER` at the top of `app.js`.

## Layout

| File | What it is |
|---|---|
| `index.html` | the page |
| `app.js` | sign-in, the mirror poll, and the screen |
| `crypto.js` | ECDH over P-256, the session KDF and AES-GCM — matched to the phone's `KeyExchange.kt` and `Crypto.kt` |
| `mirror.js` | the record stream — a port of the phone's `Mirror.kt` |
| `style.css` | the app's own colours |
