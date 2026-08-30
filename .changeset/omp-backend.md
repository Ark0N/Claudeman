---
"aicodeman": minor
---

feat: add OMP as a first-class CLI backend (SessionMode 'omp')

Codeman can now spawn the OMP CLI (`omp`) in local, Docker, and remote-SSH
sessions, alongside Claude Code, OpenCode, Codex, Gemini, Antigravity, Pi, Grok
Build, and DeepSeek Harness — the ninth CLI backend (tenth `SessionMode`,
counting `shell`).

- New `SessionMode = ... | 'omp'` with an `OmpConfig` (model, resumeSessionId)
- `src/utils/omp-cli-resolver.ts` PATH probe + `/api/omp/status` + `codeman doctor` entry
- Run-mode UI: toolbar dropdown, welcome button, mobile overview, command
  palette, clone-repo brain, cron agent types, tab badges, and per-mode colors
- Env override allowlist gains the `OMP_*` prefix
- Docker/remote default commands, resume flag, and CLI-version probing
