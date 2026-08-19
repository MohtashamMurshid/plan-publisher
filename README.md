# Plan Publisher

A no-login, static visual-plan publisher for `plan.mohtasham.dev`.

## Upload

```bash
npx --yes github:MohtashamMurshid/plan-publisher upload ./plan.html
```

The CLI validates locally, uploads the HTML, and stores a draft-scoped edit secret in `~/.planpub/drafts.json` (mode `0600`). Uploading the same absolute file path creates a new immutable version. There are no accounts in V0.

Override the service:

```bash
PLANPUB_API_URL=http://localhost:3000 node bin/planpub.js upload ./plan.html
```

## Security boundary

Published documents are served byte-for-byte with a restrictive CSP:

- scripts and network requests cannot execute
- forms, iframes, embeds, external scripts, event handlers, unsafe URL schemes, and meta refresh are rejected
- inline CSS and HTTPS/data images are allowed
- HTML is capped at 512 KiB
- updates require a random draft-scoped edit token; the public draft URL alone cannot update a draft

Do not publish private company information. Public links are intentionally readable without authentication.

## Local development

```bash
npm install
npm test
PUBLIC_BASE_URL=http://localhost:3000 npm start
```

Persistent data defaults to `.data/`; production uses `/data`.

## Provenance

The HTML policy and wire shape are compatible with ideas in the MIT-licensed `postplan@0.0.4` package. This implementation is independently branded and adds draft-scoped edit secrets for safe anonymous updates. See `NOTICE`.
