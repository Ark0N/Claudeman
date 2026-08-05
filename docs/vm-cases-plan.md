<!-- Design doc drafted 2026-07-28 from WWDC26 session 224 research. STATUS: PLANNED, NOT IMPLEMENTED. Blocked on macOS 27 "Golden Gate" (beta now, GA expected fall 2026). -->

# VM Cases (macOS Virtualization framework), Implementation Plan

## Status

PLANNED, nothing implemented. This is the design + phased execution plan for a native-macOS VM isolation tier for cases ("the VM subsystem"), modeled on Docker cases (`docs/docker-cases-plan.md`). Testbed prerequisite: a macOS 27 host (see Section 8).

**⚠ DESIGN DIRECTION (owner, 2026-07-29): the subsystem is GUI-first.** Users want real macOS desktops, not headless SSH machines. Guests may be macOS (GUI-only in practice) or Linux (GUI or headless). Key decision 3 below carries the full consequences; anything in this doc that reads as "Linux-first / headless-first" predates this and has been revised.

**2026-07-29: Phase 0 substantially validated on the beta testbed; full Apple-stack reference now lives in [`docs/vm-subsystem-apple-stack.md`](vm-subsystem-apple-stack.md)** (API surfaces, beta bugs, our empirical results, and design implications). Plan-relevant corrections from that work: vmnet's topology/port-forwarding APIs are macOS 26 (only the loopback fix is 27); guest provisioning is macOS-guests-only (Linux stays cloud-init, proven working); DiskImageKit has NO flatten/merge, so the `export` subcommand ships the layer chain (or flattens in-guest) instead of flattening; seed ISOs are base-build-time only, never attached at case runtime; per-case EFI variable stores are mandatory; guest health checks read DHCP leases, never serial/ping.

## 1. Context and motivation

WWDC 2026 session 224 ("Expand the Capabilities of your Virtualization App", https://developer.apple.com/videos/play/wwdc2026/224/) shipped the missing pieces for programmatic, fleet-style VM management on macOS:

- **`VZMacGuestProvisioningOptions`**: automated first-boot setup of a macOS guest (user account, auto-login, SSH enabled) with zero interactive setup.
- **DiskImageKit**: stacked disk images on the Apple Sparse Image Format (ASIF): a read-only base layer plus cheap per-VM cache/overlay layers. Direct analog of Docker image layers + writable container layer.
- **vmnet framework**: custom network topologies and port forwarding from the host process.
- **`VZCustomVirtioDevice`**: custom low-latency host<->guest channels (Linux guests).
- **AccessoryAccess**: USB passthrough (not relevant to Codeman, out of scope).

Codeman's isolation story today is Docker cases. On macOS, Docker means Docker Desktop / a Linux VM anyway, with weaker fidelity and a heavyweight dependency. The Virtualization framework gives hardware-virtualized per-case sandboxes natively, with a layered-image story that mirrors what `scripts/build-agent-image.mjs` does for Docker. This is the premium native-macOS tier ON TOP of Docker cases, never a replacement (Docker remains the cross-platform story; the Linux prod box cannot use any of this).

## 2. Platform reality (hard constraints)

| Constraint                | Detail                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host OS                   | macOS 27 "Golden Gate" required for the new APIs (dev beta since 2026-06-08, public beta since 2026-07-13, GA expected fall 2026)                    |
| Host hardware             | Apple Silicon only (macOS 27 dropped Intel). Testbed: the owner's dedicated MacBook (Section 8); the M4 Mac mini (macOS 26.4, runs the second Codeman install) stays on stable + untouched |
| Guest provisioning        | `VZMacGuestProvisioningOptions` needs macOS 27 on BOTH host and guest. Linux guests provision via cloud-init instead                                 |
| macOS guest concurrency   | **Hard kernel cap: 2 concurrent macOS VMs per host. MEASURED on 27 beta 4 (2026-07-29), not inferred**: the 3rd VM is refused instantly with `VZErrorDomain` code 6 while 39% of RAM is free, so more hardware does NOT raise it. Since macOS GUI guests are the headline use case, this is a real product capacity limit to schedule around and surface in the UI. Linux guests are uncapped (resource-bound only) |
| Language                  | Virtualization framework is Swift/ObjC only; Node cannot call it. Requires a Swift helper binary (Key decision 2)                                    |
| Entitlement               | Host process needs `com.apple.security.virtualization`. Fine for a locally built dev binary; distribution needs signing thought (Section 9)          |
| Nested virtualization     | Linux-guest-only on M3+. A macOS 27 VM cannot dependably host its own guests, so the host-side APIs must be tested on bare-metal 27 (dual-boot)      |
| CI                        | Cannot run in CI (needs beta macOS on Apple Silicon). Same answer as tmux/docker: no-op all VM IO under `VITEST`, unit-test the pure parts            |

## 3. Goal and user stories

Add "VM cases" to Codeman: a case can point at a per-case virtual machine on a macOS host, and any CLI backend runs inside it over the existing remote-SSH session machinery. A LOCATION OVERLAY on cases, exactly like remote-SSH and Docker cases, NEVER a sixth `SessionMode`.

- As a Mac user, I link a case to a VM so an autonomous run executes behind a hardware virtualization boundary (stronger than Docker's shared kernel) while file viewing, transcripts, and hooks keep working.
- Per-case VMs are instant and cheap: a shared provisioned base image plus a per-case overlay, not a full image copy per case.
- Killing a session kills only its in-guest tmux; the VM stays up while sibling sessions remain; case delete tears the VM down.
- I export a case's VM overlay as a portable artifact (mirror of `docker-exports/`), secrets excluded.
- On a non-mac host, or a Mac without the helper, the feature is invisible: zero UI, zero probes, zero errors.

Non-goals for the MVP: USB passthrough, custom Virtio channels (Phase 3 candidate), macOS-guest fleets (capped at 2 anyway), Kubernetes-style orchestration, Intel Macs.

## 4. Architecture

```
Codeman (Node, unchanged session layer)
  |  JSON over stdout (same pattern as shelling out to docker/tmux)
  v
codeman-vm  (Swift package: CLI + per-VM GUI runner app in the console session)
  |  Virtualization / DiskImageKit / vmnet
  v
per-case VM (macOS or Linux)
      |-- GUI mode: VZVirtualMachineView in a window  --> guest screen sharing --> browser (noVNC)
      |-- shell:    SSH on vmnet IP                   --> existing remote-SSH tmux machinery
      ^ VirtioFS: host case dir mounted at the SAME absolute path
```

Note the runner is a **GUI app in the console user's session**, not a detached daemon: a daemon-launched VM cannot render, which is fatal for macOS guests and for Linux desktop cases.

### Key decision 1: location overlay, not a mode

Identical reasoning to Docker/remote-SSH (see CLAUDE.md): the session layer, respawn, Ralph, recovery, and quick-start plumbing all stay untouched. `SessionMode` stays five-valued. State mirrors the Docker pair: `~/.codeman/vm-hosts.json` + `vm-cases.json`, new `src/vm-hosts.ts` with the storage + pure helpers split.

### Key decision 2: Swift helper CLI (`codeman-vm`)

The framework is Swift-only, so all VM work lives in a SwiftPM package (`packages/codeman-vm/`), a CLI with a stable JSON contract:

- `create-base --guest linux|macos`: build the shared base image. Linux: boot an arm64 cloud image with EFI + cloud-init, install Node 22 + tmux + the four CLIs (same inventory as `docker/agent.Dockerfile`), seal as base ASIF. macOS: IPSW restore + `VZMacGuestProvisioningOptions` (agent user, SSH on), then **desktop-readiness baking**, which is mandatory for GUI guests: suppress the per-user first-login assistant (`com.apple.SetupAssistant` keys + the User Template), enable auto-login (`autoLoginUser` + `/etc/kcpassword`), disable screensaver/lock/display-sleep, and set a static wallpaper (animated "aerials" wallpaper is unusable over remote display). ⚠ Use RAW (not ASIF) for macOS guest disks until the beta's macOS-guest space-reclamation bug is fixed.
- `create <case>`: DiskImageKit stacked image: shared read-only base + fresh per-case overlay. Near-instant, space-efficient.
- `start <case>` / `stop` / `status` / `ip`: lifecycle + vmnet NAT; `ip` reports the guest SSH endpoint.
- `export <case>` / `import`: flatten overlay + workspace tar + manifest, credentials excluded (mirror of docker-export).

A VM dies with its owning process, so `start` spawns a DETACHED per-VM runner process (analog of the detached `scripts/self-update.sh` trick) rather than a monolithic daemon; `status` talks to it over a unix socket in the instance data dir (`dataPath()`, never a hardcoded `~/.codeman` path).

### Key decision 3: multi-guest, and GUI is a first-class mode (REVISED 2026-07-29 by the repo owner)

The subsystem supports both macOS and Linux guests, and a guest runs in one of two **display modes**:

| | macOS guest | Linux guest |
| --- | --- | --- |
| **GUI mode** | **the point of the feature**; a real macOS desktop. Mandatory: nothing renders without an attached `VZVirtualMachineView` in an unlocked host session | supported (EFI + virtio-gpu framebuffer) for desktop Linux cases |
| **Headless mode** | not offered: a macOS guest with no view renders nothing, so a "headless macOS desktop" is a contradiction. SSH-only macOS is possible but is not what this feature is for | supported and cheap; the natural mode for agent/CI work, driven over SSH |

Consequences that flow from GUI being first-class:
- VM processes are **GUI apps in the console user's session** (LaunchAgent / `launchctl asuser`), never daemons. A daemon-launched VM cannot render.
- **The host is part of the product surface**: it must auto-login, never lock, never sleep, and keep a live WindowServer. Host lock == every VM's screen goes black, so the screen lock is effectively a global kill switch for every VM display on the machine. The product must own these host settings rather than treat them as user preference.
- **FileVault conflicts with unattended GUI hosting** and the trade-off must be a deliberate choice: FileVault disables auto-login, so a full-disk-encrypted host needs a human at a keyboard (or a remote screen-sharing session) after every reboot before any VM can render. Options are (a) FileVault on, accept manual login per boot, (b) FileVault off on a dedicated VM host so it boots straight into a rendering session, or (c) FileVault on plus a remote-unlock runbook. Codeman should detect the state and tell the user which one they are in instead of silently serving black screens.
- **Guests must be desktop-ready, not just booted**: auto-login, no screensaver/lock, and the per-user first-login assistant pre-suppressed at base-image time (`com.apple.SetupAssistant` keys, plus the User Template so later accounts inherit it). Otherwise the user connects to a login prompt or a setup wizard, which is exactly what happened during the first hands-on run.
- **Capacity is capped for macOS**: at most 2 concurrent macOS VMs per host, confirmed by our own test on 27 beta 4 (3rd refused with `VZErrorDomain` 6 at 39% free RAM; it is a kernel quota, so bigger hardware does not help). Scheduling must queue or evict beyond 2, the UI must explain why, and the scheduler should tolerate the acknowledged slot-leak bug (a slot occupied with nothing running, host-reboot to clear). Linux guests are uncapped and bounded only by host resources, which is the lever for scaling case counts on one machine.
- **Access is via the guest's own screen**, viewable in a browser through the noVNC chain (see `docs/vm-subsystem-apple-stack.md` §8), so no client-version or client-install requirements land on the user.

Provisioning per guest type: `VZMacGuestProvisioningOptions` for macOS (needs 27-on-27, first-boot-only, and does NOT skip the per-user wizard), cloud-init NoCloud seed ISO for Linux (proven working).

### Key decision 3b: the GUI VM host profile, and supervision that catches black screens

GUI hosting only works if the host is configured for it and supervised. This profile was derived the hard way on the testbed (prototyped there 2026-07-30) and should be what `codeman-vm` installs and verifies:

**Host profile** (the product should own these, not leave them to preference):
1. **No login barrier.** Either FileVault off + auto-login (a dedicated VM host boots straight into a rendering session, fully unattended), or FileVault on and remote reboots done with `sudo fdesetup authrestart`, where the pre-boot unlock *is* the login so the machine returns already logged in with encryption intact. **`authrestart` is VERIFIED on the testbed (2026-07-30): the host rebooted remotely and came back with a live logged-in console session, FileVault still enabled, no password prompt** — this is the recommended pattern for an encrypted GUI VM host. Plain reboots on a FileVault host always need a human, so Codeman should detect that combination and warn instead of serving black screens.
2. **Never lock**: lock policy off (needs the account password, so it is a setup step, not a scriptable one) plus `caffeinate -d -i -m -u` re-armed per session.
3. **Never sleep**: `pmset -a sleep 0 displaysleep 0 disablesleep 1`; a physical display is NOT required (a lid-closed laptop renders fine, only an unlocked session matters). Note OS updates reset these.
4. **Session-independent control plane**: run VPN/remote access as a system service, never a session app, and keep the access chain (forwards, VNC proxies, web endpoints) in LaunchDaemons so a session restart cannot sever operator access.

**Supervision** must be a **root LaunchDaemon**, not a user LaunchAgent. This is the load-bearing detail: a user agent cannot launch a GUI app into the Aqua session, so its restart attempts fail *silently* (the child dies instantly, leaving an empty log while the supervisor cheerfully reports success). A root daemon can, via `launchctl asuser <uid> sudo -u <user> …`, and those launches persist. Prototyped and verified on the testbed 2026-07-30; a working supervisor runs on a short interval and:

- Restarts the runner when the process is gone **or when its log shows `WindowServer event port death`**, which means it is permanently blind while still looking alive.
- Defers restarts while the console is at the login window, and launches into whichever session actually exists (resolve the console user with `stat -f %Su /dev/console`, never a hardcoded one).
- Re-points the guest port-forward whenever the guest's NAT lease changes, which happens on **every guest boot** under plain NAT. A vmnet DHCP reservation for a stable per-case IP is the better long-term answer.
- **Re-applies host power settings**, because `pmset -a disablesleep 1` does NOT survive a reboot (caught on the supervisor's first run after a real reboot) and OS updates reset it too.
- Re-arms the keep-awake helper, which dies with its session.
- Ideally also samples the guest framebuffer for non-black content, since a black screen is the one symptom common to every failure mode here.

`pgrep` alone is worthless for health: every failure mode in this session presented as a healthy process.

### Key decision 4: sessions ride the existing remote-SSH machinery

A provisioned guest is literally an SSH host on a vmnet IP. Session launch = the remote-SSH flow with the host swapped in: durable remote `tmux -L codeman-remote`, session names failing `SAFE_MUX_NAME_PATTERN` on purpose, EVERY ssh command line through `buildSshConnectionArgs()` (command-injection invariant), run flows through `POST /api/quick-start` (never `POST /api/sessions`, which stat-validates `workingDir` locally). What is genuinely new is only lifecycle (create/start/stop/export) and the vm-hosts/vm-cases overlay state.

### Key decision 5: workspace via VirtioFS at the same absolute path

Mirror the Docker bind-mount invariant: the case workspace is a real host directory shared into the guest via VirtioFS and mounted at the SAME absolute path. That keeps file-routes/watchers on real host bytes and makes the in-guest transcript projHash match the host. Without this, transcripts/attachments/file viewer all silently degrade.

### Key decision 6: credentials seeded, hooks bridged

- Credentials are SEEDED (read-only share, copied into the guest once at create), never shared read-write, and excluded from exports: byte-for-byte the Docker cases rule and rationale.
- Hooks: on the loopback-only prod bind a guest cannot reach `127.0.0.1:3000`. Mirror `CODEMAN_DOCKER_BRIDGE_HOOKS` with a `CODEMAN_VM_BRIDGE_HOOKS` opt-in listener on the vmnet gateway IP; otherwise idle detection falls back to output-based, same as Docker.

### Key decision 7: drift and teardown copy Docker semantics verbatim

Config hash label on the VM (guest type, cpu/mem, share list); a drifted launch is REFUSED, never silently launched stale. One VM per case shared by all sessions; session kill = in-guest tmux kill only; case delete = stop + remove overlay; instance-scoped boot reaper for orphaned runner processes.

## 5. Implementation phases

**Phase 0, testbed (no repo code):** dedicated MacBook on the macOS 27 beta, remotely accessible over the tailnet (setup protocol in Section 8), Xcode 27 beta, then a throwaway Swift script proving the loop: create base -> overlay -> boot -> ssh in. This validates 80% of the design before any Codeman code.

**Phase 1, `codeman-vm` helper:** SwiftPM package, the six subcommands above, JSON contract doc, detached runner + unix-socket status, Linux base image build. Deliverable is testable entirely without Codeman.

**Phase 2, Codeman integration:** types (`VmHost`/`VmCase`/`SessionVm`), `src/vm-hosts.ts` (+ pure helpers: config hash, arg building, endpoint parsing), Zod schemas, `case-routes` link/unlink + listing, `quick-start` vm branch reusing the remote-SSH launch path, `Session` threading + recovery round-trip, `VITEST` no-op layer, unit tests. Feature-detect: darwin + arm64 + helper binary present, else invisible.

**Phase 3, polish:** export/import UI, frontend Create Case "VM" tab + case-picker labels, SSE `vm:*` events, macOS-guest opt-in with cap surfaced, custom-Virtio input channel exploration, CLAUDE.md Key Pattern + `docs/vm-cases.md` + COM.

## 6. Testing

- Pure helpers unit-tested (ports pattern from `docker-hosts.ts`: 26 tests there, aim similar).
- All helper-invoking IO no-ops under `VITEST` (the `IS_TEST_MODE` pattern in `tmux-manager.ts`).
- End-to-end verification happens ON the beta MacBook, per the always-end-to-end rule: real base build, real per-case overlay boot, real quick-start into the guest, workspace round-trip through VirtioFS, session-delete keeps VM up, case-delete removes it.
- CI never runs the real path; the static guards are type-level + unit-level only.

## 7. Risks

1. **Beta API churn**: everything here targets beta SDKs; symbol/behavior changes are likely before fall GA. Mitigation: Phase 0/1 are throwaway-tolerant; no Codeman-side commitment until the helper contract survives a beta cycle.
2. **New artifact class**: Codeman ships pure TypeScript today; a Swift binary changes build/distribution (build-on-install via `xcrun swift build` on macs with Xcode CLT? prebuilt signed binary per release?). Needs an owner decision; local dev build is fine for the whole beta period.
3. **Entitlement/signing**: `com.apple.security.virtualization` is trivial for local dev, real for distribution.
4. **Adoption gating**: users need macOS 27 + Apple Silicon for months after GA. Docker cases remain the default recommendation; VM cases ship dark (feature-detected) with zero cost to everyone else.

## 8. Beta testbed plan: dedicated MacBook (actionable now)

Testbed is a dedicated MacBook the owner sacrifices to the beta (after a full backup). This supersedes the earlier dual-boot-the-Mini idea (git history has it): a dedicated machine means no OS-switching, no downtime for the Mini's live Codeman, and no FileVault pre-boot headaches.

**Sequencing rule that makes it headless: configure ALL remote access on the CURRENT macOS first, THEN upgrade in place.** An in-place beta upgrade preserves Remote Login, Tailscale, user accounts, and auto-login, so there is no Setup Assistant and no post-install physical step. (A fresh install would boot into GUI-only Setup Assistant with no SSH, which on a headless box is a dead end.)

Confirmed hardware (2026-07-28): MacBook, M3, 16 GB RAM, 256 GB disk with ~100 GB free. Verdict: green. M3 = eligible + nested-virt capable; 16 GB = host + 2-3 concurrent Linux guests (macOS guest = one at a time); 100 GB = fits with discipline: install Xcode 27 beta with the macOS platform only (skipping iOS/watchOS/tvOS simulators saves 15-20 GB), and defer any macOS guest base (~30 GB) to an external SSD or until actually needed. Linux guests + sparse ASIF overlays are the comfortable path.

### Pre-upgrade checklist (owner, physical, once)

1. Full backup (Time Machine or clone); the machine should be considered beta-only afterwards.
2. Tailscale: install, sign into the tailnet, confirm it appears in `tailscale status` from another node.
3. System Settings -> General -> Sharing: **Remote Login ON** (SSH) and **Screen Sharing ON** (for the rare GUI-only moments: Xcode license, Apple Account dialogs).
4. **FileVault stays ON** (owner decision 2026-07-28, security over convenience). Consequences: auto-login is unavailable, but FileVault's pre-boot unlock doubles as login, so an unlocked boot still lands in a live GUI session; planned remote reboots go through `sudo fdesetup authrestart` (unlocks for exactly one restart); an UNPLANNED reboot (beta kernel panic, battery drain) parks the machine at the pre-boot screen, no SSH/Tailscale, until the password is typed physically. If the testbed goes silent, suspect this first. Keep it on AC so the battery absorbs power blips.
5. Beta enrollment (manual): sign into the Apple Account in System Settings; System Settings -> General -> Software Update -> **Beta Updates** -> select the **macOS 27 Developer Beta** (preferred: framework fixes land weeks earlier than public beta; free since 2023 after accepting the agreement once at developer.apple.com; public-beta alternative: enroll at beta.apple.com). Then run the offered upgrade: plugged in, lid open, trusted network.
6. Send over: tailnet name/IP, username, and a first-login password (key install + lockdown happens remotely right after).

### Post-upgrade setup (remote, over the tailnet)

1. Verify: `sw_vers` reports 27.x, SSH reachable.
2. Server-ize the laptop: `sudo pmset -a sleep 0 disksleep 0 disablesleep 1` (lid-closed operation without an external display), `womp 1` (wake on network), `sudo systemsetup -setrestartpowerfailure on`. Keep on AC power.
3. Install the controlling host's SSH key, then disable password auth.
4. Xcode 27 beta install (the one step needing the owner's Apple Account sign-in once, doable via Screen Sharing from anywhere); `xcode-select`, license accept, verify `swift --version` + the 27 SDK (`xcrun --show-sdk-version`).
5. Phase 0 prototype loop, all remote from here: Linux guest base image (no 27-on-27 provisioning dependency), DiskImageKit overlay, boot, vmnet NAT, ssh into the guest, run `claude --version` inside.
6. Only after that loop works: start Phase 1 in `packages/codeman-vm/`.

## 9. Open decisions (owner)

1. Linux base distro/image for the default guest (proposal: Ubuntu 24.04 arm64 cloud image, matching the docker agent image's userland).
2. Helper distribution for GA: build-on-install vs prebuilt signed binary vs "bring your own Xcode".
3. Ship dark behind `CODEMAN_VM_CASES=1` for the first release, or feature-detect only?
4. Export format parity with docker-exports (one manifest schema for both?).

## References

- Session 224: https://developer.apple.com/videos/play/wwdc2026/224/
- Fleet-angle writeup: https://bitrise.io/blog/post/wwdc26-the-virtualization-framework-updates-that-matter-for-large-mac-fleets
- Beta timeline: https://www.macworld.com/article/3189014/apple-july-2026-ios-ipados-macos-27-public-betas-tv-arcade-releases.html
- Internal analogs: `docs/docker-cases-plan.md` (architecture template), `docs/remote-sessions.md` (session transport), `docs/architecture-invariants.md#docker-cases`
