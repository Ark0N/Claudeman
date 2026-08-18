# Versioning

Codeman follows [semantic versioning](https://semver.org/). This page says what the version
number actually promises, which matters if you are building anything against Codeman.

## Covered by the version number

Breaking any of these after 1.0 requires a **major** bump:

1. **The CLI.** Command names, documented flags, and their behaviour. The npm package is
   `aicodeman` and installs both the `aicodeman` and `codeman` commands; renaming either is
   breaking.
2. **The HTTP API and SSE channel**, served under `/api/v1` with the uniform envelope and
   conventional status codes. Endpoint paths, the envelope, `errorCode` values, and SSE event
   names are all stable.
3. **Documented deployment environment variables**: `CODEMAN_PASSWORD`, `CODEMAN_USERNAME`,
   `CODEMAN_HOST`, `CODEMAN_PORT`, `CODEMAN_INSTANCE`, `CODEMAN_ALLOWED_HOSTS`,
   `CODEMAN_DATA_DIR`, `CODEMAN_TMUX_SOCKET`, plus the `--host`, `--port`, and `--https`
   flags.
4. **The published `xterm-zerolag-input` library**, on its own independent version line.
   Codeman reaching 1.0 says nothing about that package's version.

Additive changes are **not** breaking: new endpoints, new optional fields, new error codes,
new SSE events. Genuinely breaking API changes would ship under a new prefix rather than
changing `/api/v1`.

## Not covered

These can change in a minor or even patch release:

1. **The `~/.codeman/` state file formats.** Migrations are made on a best-effort basis and
   have been done across renames, but the on-disk shape is not a contract. Do not write
   tooling against it.
2. **Internal TypeScript modules.** The npm package is CLI-only. There is no stable library
   entry point, and importing it programmatically is unsupported.
3. **Experimental and opt-in features**, whatever the app's version: gesture control, agent
   teams, and anything labelled experimental in the UI or docs.

## Deprecation

- Additive changes are preferred over breaking ones.
- A covered surface slated for removal is deprecated first: it keeps working for at least one
  minor release, with a runtime warning and a changelog note pointing at the replacement,
  then is removed in the next major.
- Backwards-compatibility shims are kept until a major boundary.

## Releases

Releases are managed with changesets. Every release:

- Bumps the version and updates
  [`CHANGELOG.md`](https://github.com/Ark0N/Codeman/blob/master/CHANGELOG.md).
- Publishes to npm as `aicodeman`.
- Cuts a GitHub release, tagged `codeman@X.Y.Z`.
- **Credits its contributors and bug reporters by name** in the release notes.

There is no fixed cadence. Patches ship when fixes are ready, which in practice is often.

## Which version am I on?

```bash
codeman --version
```

Or **App Settings → Updates**, which also checks for a newer one and can install it. See
[Running As A Service](Running-As-A-Service).

## Read next

- [HTTP API](HTTP-API) - the stable API surface itself.
- [Contributing](Contributing) - how changes get made.
- [`docs/versioning-policy.md`](https://github.com/Ark0N/Codeman/blob/master/docs/versioning-policy.md) - the authoritative statement.
