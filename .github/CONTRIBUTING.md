# Contributing

Thanks for using `docgen-mcp-server`. Bugs, feature requests, and documentation gaps all belong in an issue — that's where they get read and picked up.

Open a [bug report](https://github.com/cyanheads/docgen-mcp-server/issues/new?template=bug_report.yml) or [feature request](https://github.com/cyanheads/docgen-mcp-server/issues/new?template=feature_request.yml). Filling in the structured fields is what makes an issue actionable.

Pull requests are welcome. Open an issue first for anything larger than a typo so the approach can be agreed before implementation.

## Server bug or framework bug?

`docgen-mcp-server` is built on [@cyanheads/mcp-ts-core](https://github.com/cyanheads/mcp-ts-core), which handles transports, auth, config, logging, and telemetry.

- **This repo** — a document tool returns the wrong bytes or metadata, a schema does not match the documented contract, or a definition misleads the model.
- **[mcp-ts-core](https://github.com/cyanheads/mcp-ts-core/issues)** — a builder rejects valid input, `createApp()` fails on valid config, a `Context` method behaves contrary to its docs, or transport/auth behavior fails regardless of the definition called.

If you're not sure, file here and it will be routed.

## Before filing

1. Check that you are on the latest release.
2. Search existing issues and add to a matching thread instead of filing a duplicate.
3. Redact API keys, tokens, auth headers, internal URLs, PII, and document contents from logs and reproductions.

## What makes an issue actionable

- Server version, `mcp-ts-core` version, runtime (Bun / Node), and transport (stdio / HTTP).
- The tool or resource involved and the arguments supplied.
- Actual and expected behavior, including the exact error message.
- For features: the use case first, then the API shape you want to call.

## For agents

Do the triage first. Read the relevant workflow before filing on a user's behalf:

- [`skills/report-issue-local/SKILL.md`](../skills/report-issue-local/SKILL.md) — this repository.
- [`skills/report-issue-framework/SKILL.md`](../skills/report-issue-framework/SKILL.md) — `mcp-ts-core` after isolating the bug to the framework.

## Security

Do not open a public issue for a vulnerability. Use GitHub's **Security** tab → **Report a vulnerability**, or email **security@caseyjhand.com**.
