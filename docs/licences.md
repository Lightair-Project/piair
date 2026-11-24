# Licences of PiAir's dependencies

PiAir is MIT-licensed (`LICENSE`). Every npm package it bundles is under a permissive licence:
no GPL, LGPL or AGPL code. Checked 23 November 2026 over `node_modules` (`bun install`,
`bun.lock`), 90 packages:

| Licence | Packages |
|---|---|
| MIT | 41 (Pi: `@earendil-works/pi-ai`, `pi-agent-core`, `pi-schema`, `pi-telemetry`; …) |
| Apache-2.0 | 36 (provider SDKs: `@anthropic-ai/sdk`, `openai`, `@google/genai`, the AWS SDK pieces Pi's Bedrock support pulls in, …) |
| BSD-3-Clause | 11 |
| 0BSD | 1 (`tslib`) |
| Unlicense | 1 (`fast-sha256`) |

`node-datachannel` (MPL-2.0, weak file-scope copyleft) and its native `libdatachannel` carry the
realtime voice path's WebRTC; `opusscript` (MIT) bundles libopus (Xiph BSD) for the Opus codec.
MPL-2.0 is compatible with PiAir's MIT: it is not GPL/LGPL/AGPL and keeps PiAir's tree free of
strong copyleft.

`src/oauth-page.ts` (the page a subscription's sign-in comes back to) carries the Lightair logo,
the Lightair project's own mark: it's there so the page looks like Lightair, and the MIT licence
doesn't grant use of the mark elsewhere.

Lightair (GPL-3.0) and PiAir are separate programs that talk over a pipe; the desktop's PiAir
module speaks the documented protocol (design.md §2).

To check again: `python3` over `node_modules/**/package.json` (the `license` field), or
`bunx license-checker --summary`.
