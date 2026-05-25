# inbox

A minimal **inbox app** for a Solid pod — read *and send* notifications.

- **List / read / delete** the messages in your pod's inbox.
- **Compose / send** — write an ActivityStreams `Note` and POST it to the
  recipient's inbox (discovered from *their* WebID's `ldp:inbox`). "To" prefills
  with your own WebID, so a send-to-self lands back in your list.
- Discovers your own inbox via your WebID's `ldp:inbox` (falls back to `<pod>/inbox/`).
- The inbox is **owner-only**, so you must be signed in (login pill, bottom-right).

## How it works

Every JSS pod ships an [LDN](https://www.w3.org/TR/ldn/) inbox at `/inbox/`,
seeded with an ACL that grants the **public `acl:Append`** and the **owner
`Read`** — i.e. anyone can drop a message in, only you can read it. That's the
receiving half of "webmail", built into the pod.

Messages are parsed as [ActivityStreams](https://www.w3.org/TR/activitystreams-core/)
(`as:Note` / `as:Create`), the same shape ActivityPub uses, so this reader
already understands fediverse-shaped notifications:

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Note",
  "summary": "Subject line",
  "content": "Message body.",
  "actor": "https://alice.example/profile/card#me",
  "published": "2026-05-25T10:00:00Z"
}
```

## Roadmap

- **v1** — read / delete. ✅
- **v2 (this)** — compose & send: discover the recipient's `ldp:inbox` (from
  their WebID) and POST a message. ✅
- **next** — pick recipients from your contacts (once contacts carry a WebID);
  federation via JSS's ActivityPub support.

## License

AGPL-3.0-only.
