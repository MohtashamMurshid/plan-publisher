# AGENTS.md

## Product boundary

Plan Publisher turns one self-contained HTML file into a public static review URL. V0 has no accounts: creation is anonymous and each draft has a private edit token held by the CLI.

## Non-negotiable rules

- Public reads are intentional; never add private content to fixtures or examples.
- Never expose, log, return from metadata endpoints, or commit draft edit tokens.
- Updates must fail closed without the matching draft edit token.
- Preserve byte-for-byte HTML serving and immutable numbered versions.
- Keep browser CSP at least as restrictive as the current policy.
- Reject active content before storage: forms, frames/embeds, external scripts, event handlers, unsafe URL protocols, and redirects.
- Maintain the 512 KiB default limit and non-root container runtime.

## Verification

Run before delivery:

```bash
npm install
npm run check
sudo docker build -t plan-publisher:test .
```

For behavior changes, add an integration assertion in `test/server.test.js` covering the real HTTP path.
