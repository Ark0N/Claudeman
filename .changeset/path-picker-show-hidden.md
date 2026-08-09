---
'aicodeman': patch
---

The filesystem path picker can show hidden files and folders, and the shared secret blocklist grew to make that safe.

The picker behind Link Existing's "Browse" and the mobile keyboard's `Path` key
refused every path with a dot-prefixed segment, so `.github/workflows/ci.yml`
could not be selected and a hidden folder could not even be opened. It now has
the same `.*` toggle as the File Viewer, default OFF, per-device, and it applies
to both the listing and the preview endpoint (which re-resolves the path
independently).

That filter was quietly doing security work. With every hidden path unreachable,
`isSensitivePath` never had to name the credentials that live in dot-directories,
because the picker's roots include Home. Lifting the filter removes that
accident, so the blocklist now covers them explicitly: SSH keys at any depth (not
only under `$HOME`), GPG keyrings, AWS/GCloud/Azure/Docker/Kubernetes
credentials, npm, Yarn, git, `gh`, netrc, PyPI, RubyGems, Cargo and Terraform
tokens, `.pgpass` and `.my.cnf`, and the Claude and Codeman agent credentials.
`~/.codeman/` and `~/.claude/` stay attachable as trees, since the publish skill
and the review-card loop read from them; only their secret-bearing members are
named.

Blocked trees, sensitive files, root confinement and symlink-escape checks are
all unchanged and still apply with the toggle on: a hidden entry that resolves
to a secret is dropped from the listing, and opening it is refused.

Follows #221.
