<!-- Reference doc for the VM subsystem (Codeman VM cases). Compiled 2026-07-29 from: Apple DocC JSON backend, macOS 27 beta 4 SDK on the testbed, a multi-source web research sweep, and hands-on prototyping on a MacBook Air M3 running macOS 27.0 beta (26A5388g). Companion to vm-cases-plan.md (the Codeman integration plan). -->

# The VM Subsystem: Apple Virtualization Stack Reference (macOS 27 "Golden Gate")

"VM subsystem" is the working name for Codeman's native-macOS VM isolation tier and everything under it. This document is the single place for what the Apple stack actually provides, what we have verified ourselves on the beta, and what is known-broken. The Codeman-side design lives in `docs/vm-cases-plan.md`.

**Research method note:** Apple's HTML doc pages are JS-rendered and come back empty to fetchers. The working route is the DocC JSON backend: `https://developer.apple.com/tutorials/data/documentation/<path>.json` (page content) and `https://developer.apple.com/tutorials/data/index/<framework>` (full symbol tree with per-symbol `beta` flags). Everything below marked "Apple docs" was parsed from that backend directly.

## 1. Component map and minimum OS versions

| Component | What it is | Min host OS | Notes |
| --- | --- | --- | --- |
| Virtualization.framework core | VMs, EFI/Linux boot, virtio devices, VirtioFS | macOS 11-13 era | Unchanged basics; our prototype uses nothing newer than macOS 13 APIs except the DiskImageKit bridge |
| **DiskImageKit** | ASIF + raw disk images, layered stacks | **macOS 27** | Swift-only, no ObjC headers. Section 2 |
| **Guest provisioning** | First-boot account/SSH setup for macOS guests | **macOS 27 host AND guest** | Mac guests only as of beta 4. Section 3 |
| vmnet topology/port-forward/DHCP APIs | Custom networks, port forwarding | **macOS 26** (NOT 27) | 27 adds exactly one fix: loopback port forwarding. Section 4 |
| `VZVmnetNetworkDeviceAttachment` | In-process vmnet attach | macOS 26 | |
| **`VZCustomVirtioDevice`** family | Custom paravirt devices | **macOS 27** | Linux guests only, custom guest driver required. Section 5 |
| AccessoryAccess (USB passthrough) | USB claim + attach to VMs | macOS 27 | Requires paid-team provisioning profile, Dock app. Out of scope for Codeman. Section 6 |

Corrections to the WWDC-session framing we started with: vmnet's topology family is a macOS 26 story (129 symbols, zero beta-flagged in 27); provisioning does NOT currently extend beyond macOS guests despite the generic-looking `VZGuestProvisioningOptions` base class; DiskImageKit has no attach/mount API at all (it is a file-format library that hands `DiskImage` objects to Virtualization, no `/dev/diskN`, no root needed, no entitlement documented).

## 2. DiskImageKit (macOS 27, Swift-only)

Public framework, `/System/Library/Frameworks/DiskImageKit.framework`. No ObjC headers; the API surface lives in the `.swiftinterface`. Verified present in the CLT 27 beta 4 SDK, and our prototype compiled against it with plain `swiftc` on the first attempt.

### API surface (complete as of beta 4)

```swift
class DiskImage {
  convenience init(creating: some DiskImage.CreationConfiguration) throws
  convenience init(opening: some OpenConfigurationProtocol) throws
  func appending(any DiskImage.CreationConfiguration & DiskImage.StackableLayer) throws -> any StackedImage
  func appending(consuming DiskImage) throws -> any StackedImage   // reattach an existing layer; validates parentUUID
  func truncate(blockCount: Int) throws                            // stacked: affects top layer; does NOT resize guest fs
  var blockCount, blockSize, format, layerType, layerUUID, parentUUID, openMode, size, url
}
protocol StackedImage: DiskImage { var layers: [DiskImage] }
struct OpenConfiguration { init(url:mode:); Mode = automatic | readOnly | readWrite }
// CreationConfiguration statics: .asif(url:blockCount:blockSize:), .asifLayer(url:type:), .raw(url:blockCount:)
// DiskImage.LayerType: .cache | .overlay | .overlay(blockCount:)
// DiskImage.BlockSize: .bytes512 | .bytes4096
// Errors: CorruptedImageError, IncompatibleStackingError(reason), InvalidBlockCountError, UnsupportedFormatError
```

Bridge into Virtualization is a new beta convenience init on the existing attachment class. Note there is no `readOnly:` parameter; read-only-ness comes from each layer's own `openMode`:

```swift
VZDiskImageStorageDeviceAttachment(diskImage: stack, cachingMode: .automatic, synchronizationMode: .full)
```

### Stacking rules (Apple docs, verbatim where quoted)

- ASIF works standalone or stacked. "You can only use RAW images as standalone images or as **base** images in stacked configurations." Upper layers are always ASIF.
- **One cache layer per stack**, any number of overlays conceptually, "shallow stacks perform better" (WWDC 224). No published max-depth guidance.
- "Layers are processed from bottom (base) to top. The **topmost layer determines the stack's size and receives all writes**." `.overlay(blockCount:)` therefore also grows the virtual disk.
- UUID chaining: appending sets the child's `parentUUID` to the parent's `layerUUID`. Raw bases have no UUID. "The layer UUID **changes if the layer is written to**", and reattaching a mismatched layer throws `IncompatibleStackingError`. This is the mechanism that makes a shared read-only base safe.
- Base sharing across multiple VMs is the stated design intent ("can be shared across multiple VMs"), with the WWDC caveat that per-VM auxiliary files (EFI variable store, macOS auxiliary storage) must be duplicated per VM, never shared.
- **There is no flatten/merge.** An overlay cannot be merged back into its base (confirmed by Howard Oakley's coverage plus an independent hands-on report). Export/move flows must ship the layer chain, or flatten inside a guest (dd to a fresh attached image).

### Known issues and adoption

- **ASIF space reclamation is broken for macOS guests on the beta** (deleted files never return space, survives reboots). Linux guests reclaim correctly on both raw and ASIF via `fstrim -av`. Single detailed field report, unrefuted. Since the VM subsystem targets macOS guests, the practical rule until this is fixed is: back macOS guest disks with RAW, and revisit ASIF stacking for macOS guests each beta (stacking still works, the disks just never shrink).
- **Zero shipping adopters anywhere.** tart has a design issue with no activity; nobody has published working DiskImageKit code. Everything must be treated as field-untested (and our own testing bears that out, Section 8).
- Framework binary grew every beta (588 → 598 across betas 1-4); expect churn until GA.
- Release notes list no DiskImageKit known issues in any beta, which given the above says more about the notes than the framework.

## 3. Guest provisioning (macOS guests only)

```swift
class VZGuestProvisioningOptions: NSObject { func validate() throws }   // "use one of its subclasses"
class VZMacGuestProvisioningOptions: VZGuestProvisioningOptions {
  var fullName, username, password: String
  var logsInAutomatically: Bool
  var enablesRemoteLogin: Bool   // SSH
}
// Wiring: VZMacOSVirtualMachineStartOptions.guestProvisioningOptions (Mac-typed)
//         .setGuestProvisioning(_:) throws  (validating setter)
```

- **Requires macOS 27 on host AND guest.** Older guests **silently ignore** the options (no error).
- **First boot after restore only.** Cannot reconfigure an already-provisioned VM; property changes after start are no-ops.
- The base class is forward-looking scaffolding; its only subclass is Mac. A Linux/cloud-init analogue may come later; do not assume it lands in 27.0. For Linux guests, cloud-init NoCloud seed ISOs remain the provisioning path (proven working, Section 8).
- Field-verified behavior (third-party hands-on, beta 3): provisioned account gets full admin + sudo; Setup Assistant fully skipped; SSH reachable ~48 s after first boot. **Race**: the account is created late in first boot (~T+54 s), after LaunchDaemons start (~T+33 s), so anything at daemon-level must wait for the account to exist.
- Open Apple-acknowledged bug: provisioned users are invisible to `CSIdentityQueryExecute()` (FB23716201).
- IPSW acquisition gotcha for automation: `VZMacOSRestoreImage.latestSupported` tracks the latest *release* (returned 26.5.2), not the installed beta; beta IPSWs must be fetched from the seed CDN explicitly.

## 4. vmnet: a macOS 26 feature set, one macOS 27 fix

Everything interesting shipped in macOS 26: `vmnet_network_create`, `vmnet_network_configuration_create`, `..._add_port_forwarding_rule`, `..._add_dhcp_reservation`, subnet/prefix/MTU/external-interface setters, NAT44/NAT66/DHCP/DNS-proxy/RA disables, plus serialization (`vmnet_network_copy_serialization` / `_create_with_serialization`) for handing networks across processes. `VZVmnetNetworkDeviceAttachment` is macOS 26.

macOS 27's only change (beta 4 release notes, verbatim): "The vmnet port forwarding APIs now support port forwarding when communicating over loopback." That closes the old gap where the host could not reach its own forwarded ports via 127.0.0.1 (confirmed working by the original bug reporter). Directly relevant to Codeman's loopback-bound production server talking to per-case guests.

Gotchas:
- vmnet networks are **not persisted**; they die with the owning process. Persist settings yourself and recreate (or serialize across processes).
- The `com.apple.vm.networking` entitlement is still restricted ("contact your Apple representative", though DTS says most requests are approved). The plain `VZNATNetworkDeviceAttachment` needs no special entitlement and is what our prototype uses.
- Ecosystem signal: tart's maintainer is not adopting in-process vmnet (prefers their separate-process softnet), so field testing of these APIs is thin.

## 5. VZCustomVirtioDevice (macOS 27, Linux guests only)

14 new types (`VZCustomVirtioDevice(+Configuration/Delegate/Provider)`, `VZVirtioQueue(+Element)`, `VZVirtioFeatureSet`, shared-memory-region types, `VZGuestMemoryMapping`), wired via `VZVirtualMachineConfiguration.customVirtioDevices`. Mandatory for guest discovery: `deviceID`, `pciClassID`, `pciSubclassID`, `virtioQueueCount`. You must write the Linux guest driver (Virtio spec 1.3/1.4). Threading contract: the framework calls the device/delegate on a serial queue (`deviceQueue`, defaulting to the VM's queue). Zero public adopters. For the VM subsystem this is a Phase 3+ option for a low-latency host-guest channel; SSH over NAT is proven and sufficient for now.

## 6. Signing and entitlements

- **Core loop (VZ + DiskImageKit + provisioning): ad-hoc signing with only `com.apple.security.virtualization` suffices.** Verified by us on beta 4 (plain `codesign --entitlements ... -s -` on a `swiftc` binary) and independently by third parties on beta 3. DiskImageKit documents no entitlement at all.
- **Over-entitling is the actual trap.** Adding `com.apple.application-identifier`/team-identifier keys without an embedded provisioning profile hangs the process before `main` (watchdog kill); shipping `com.apple.vm.networking` unauthorized gets AMFI SIGKILL at exec (exit 137, no crash report, even for `--version`). Keep the entitlements plist to exactly the one key.
- **USB passthrough breaks the ad-hoc story**: `com.apple.developer.accessory-access.usb` is profile-restricted (any paid team, no ad-hoc), additionally requires `com.apple.security.device.usb`, and `AAUSBAccessoryManager` presents UI, so it wants a Dock app, not a headless CLI. Out of scope for Codeman.
- No Xcode required for any of the above: the CLT beta (~500 MB via `softwareupdate`) carries the full macOS 27 SDK including DiskImageKit and compiles/signs everything.

## 7. Ecosystem state (July 2026)

- **tart is now `openai/tart`** (moved from cirruslabs, mid-2026) and **relicensed to FSL-1.1-ALv2** (no longer permissive). Provisioning support shipped in 2.33.0. Old cirruslabs URLs and license assumptions are stale.
- VirtualBuddy shipped provisioning ("Skip Setup Assistant") in 2.2 betas; had to add account-detail validation and a workaround installer for the cross-version bug below.
- lima is deliberately waiting for GA before touching macOS 27 APIs.
- **Code-Hex/vz (Go bindings) is dormant** (no commits since Feb 2026, no macOS 27 APIs), so the entire Go ecosystem (podman-machine, colima) currently has no path to these APIs. Swift is the only realistic binding today, which validates the VM subsystem's Swift-helper design.
- Useful pattern if ever supporting older SDKs: resolve new classes via `NSClassFromString` at runtime (no link-time dependency), fail gracefully when absent.
- **Cross-version restore bug**: installing a macOS 27 guest from IPSW on a macOS 26 host fails at 77-78% (`VZErrorDomain 10007`); fixed in 26.6b3 + Xcode 27b4 era, with a nasty MobileDevice.pkg trap (installing it from Xcode 27 beta on a 26 host requires a full macOS reinstall to undo). Not relevant to our 27-host testbed, very relevant to anyone on a 26 host.

## 8. Our empirical results (beta 4, 26A5388g, MacBook Air M3, 2026-07-29)

Prototype tooling, all in `~/vm-lab/` on the testbed, compiled with CLT-only `swiftc` and ad-hoc signed with the single virtualization entitlement:

| Tool | Purpose |
| --- | --- |
| `vzboot.swift` | Linux guest: EFI boot + virtio disk/net/entropy + NAT + optional cloud-init seed ISO + serial on stdio |
| `vzstack.swift` | Same, but boots a DiskImageKit stack (read-only raw base + ASIF overlay) |
| `vzmac.swift` | macOS guest: `install` (IPSW restore into a bundle) and `run` (boot, `--provision` for first-boot account/SSH) |
| `vzmacgui.swift` | macOS guest in a real window via `VZVirtualMachineView` (required for the guest to render at all) |
| `setup-seed.sh` | Builds a cloud-init NoCloud seed ISO with `hdiutil makehybrid` (volume label `cidata`) |
| `vncproxy.py` | RFB proxy that advertises only security type 2, so version-skewed/browser clients can authenticate |
| noVNC + `websockify` | Browser access; `websockify --web noVNC-<ver> 0.0.0.0:<port> 127.0.0.1:<proxy>` |
| `vmwatchdog.sh` + `vmaccess.sh` | Supervision: root LaunchDaemon that restarts a blind/dead runner, re-points the forward, re-applies `pmset`, re-arms keep-awake; plus a keeper for the proxy/web endpoints |

Host-side diagnostics written during this work (in the session scratchpad, not on the testbed): `vnclogin.py` (Apple DH auth + session open, distinguishes "credentials rejected" from "authorized but session refused"), `vncshot.py` (decodes the raw framebuffer to PNG and reports non-black pixel counts, plus optional synthetic wake input), `relay.py` (plain TCP relay used to bridge a tailnet peer to a LAN-only host), `sshpw.py` (pty-driven password SSH for the one-time key bootstrap into a freshly provisioned guest).

### Proven working

1. **Boot**: Debian 12 arm64 cloud images (nocloud and genericcloud variants) boot under `VZEFIBootLoader` + `VZGenericPlatformConfiguration`.
2. **Networking**: `VZNATNetworkDeviceAttachment` gives the guest a `192.168.64.x` DHCP lease from the host's bootpd (leases visible in `/var/db/dhcpd_leases`, bridge is `bridge100`).
3. **cloud-init provisioning**: NoCloud seed ISO (built with `hdiutil makehybrid -iso -joliet -default-volume-name cidata`) created a `codeman` user with SSH key + passwordless sudo on first boot; `ssh codeman@<lease-ip>` from the host works with key auth.
4. **DiskImageKit stack mechanics**: opening a raw base `.readOnly`, appending an ASIF overlay (`ASIFCreationConfiguration.layer(url:type:.overlay)`), attaching via `init(diskImage:)`, and booting it. The overlay received ~44 MB of boot-time writes while the **base file's SHA-256 stayed bit-identical**, which is the write-isolation property the whole per-case design rests on.
5. **Reattach**: reopening an existing overlay and `appending(consuming:)` onto the same base passes UUID validation.
6. **macOS guest install (added later the same day)**: `VZMacOSInstaller` restore of the 27.0 IPSW (26A5388g, fetched from the seed CDN via appledb; same build as host) into a sparse 64 GiB raw disk + auxiliary storage: INSTALL-OK on the first attempt, ~25 minutes.
7. **Headless guest provisioning WORKS**: `VZMacGuestProvisioningOptions` via `setGuestProvisioning` (username, password, `enablesRemoteLogin`, `logsInAutomatically=false`) produced, with zero GUI interaction: an account with full admin (groups include `80(admin)`, `com.apple.access_ssh`), Remote Login on from first boot, port 22 reachable ~140 s after first-boot start, hostname auto-derived from the account ("Codemans-Virtual-Machine"). SSH password auth is on by default, so the bootstrap path is: pty-driven password login once to install `authorized_keys`, key auth thereafter. Note the provisioned account's sudo is NOT passwordless (`echo <pass> | sudo -S ...`), and provisioning is first-boot-only (later boots take no options and just boot).
8. **Slot-leak bug NOT reproduced on 26A5388g**: a guest-initiated `shutdown -h now` fired `guestDidStop` cleanly and an immediate relaunch started fine (SSH-ready again in ~75 s), so FB22967193 (VM slot leaked on guest-initiated shutdown, host reboot to recover) did not manifest after one cycle. Either fixed in beta 4 or needs more cycles to trigger.

### Unstable / under investigation (beta-quality territory)

Boot reliability degraded over a ~15-VM session on one host boot, ending with reproducible silent hangs (VM process alive, 0% CPU, no DHCP, no ARP, nothing on serial):

- A genericcloud base that had been booted read-write once (cloud-init first boot) subsequently hung on every boot **with the seed ISO still attached**, while booting **without** the seed succeeded, then later runs failed in both configurations. The seed correlation is strong but was observed while host state was already suspect, so it needs a retest from a clean baseline.
- The first stack-boot "success" that later wedged turned out (via DHCP lease timestamp arithmetic) never to have reached the network at all; its overlay growth was pre-network boot writes.
- Working hypothesis, matching a class of acknowledged beta bugs (e.g. the VM-slot counter that leaks on guest-initiated shutdown, FB22967193, where only a host reboot recovers): accumulated hypervisor/vmnet state on the host degrades boots. Requires a host reboot + a disciplined retest matrix to confirm.

### Display rendering: the single most important operational finding

**A VZ macOS guest renders nothing unless a `VZVirtualMachineView` is attached AND the host session is actually drawing.** Verified byte-for-byte: the guest's own screen sharing serves an all-zero framebuffer (0 non-black bytes across 400 KB samples, with a sane pixel format: `rmax/gmax/bmax = 255`, shifts 16/8/0), in-guest `screencapture` fails with "could not create image from display", and no `IODisplayWrangler` shows up in the guest's `ioreg`. Three distinct states all produce black:

1. **Headless** (VM run with no view attached).
2. **View attached, host session locked.** The lock screen suspends drawing and the guest's virtual GPU produces no frames.
3. **View attached, but the app lost its WindowServer connection** (see the incident below): black permanently until the app is restarted.

**Consequence for the VM subsystem: rendering is a first-class requirement, not an optional extra (owner decision 2026-07-29).** The product serves GUI desktops: mandatory for macOS guests, optional-but-supported for Linux guests (which can also run headless over SSH). Any VM in GUI mode must be launched by an app that attaches a `VZVirtualMachineView`, from inside a host GUI session that is logged in and unlocked. That makes the following non-negotiable parts of the design, not workarounds:

- VMs run as **GUI apps in the console user's session** (launched via a LaunchAgent or `launchctl asuser`), never as daemons.
- The **host must auto-login and never lock or sleep**; a locked host is equivalent to a powered-off display for every VM on it.
- The **guest must auto-login, never lock, and have its first-login assistant pre-suppressed**, or the "desktop" a user connects to is a password prompt or a setup wizard.
- A VM app that loses its WindowServer connection is **permanently blind** and must be restarted; supervision has to detect that, not just check that the process is alive.
- The **2-concurrent-macOS-VM cap** becomes a real capacity limit for the product, so it must be surfaced in the UI and tested (still untested worldwide as of this writing).

### Incident 2026-07-29: `killall -HUP loginwindow` (never do this on a remote Mac)

Applying a wallpaper change on the testbed with `killall -HUP loginwindow` restarted the host's login session. Three consequences:

1. **The Mac dropped off the tailnet entirely.** Tailscale's App Store build is a GUI app living in the user session, so killing the session killed the VPN; remote access was gone until someone logged in. Recovery came from a second machine on the same LAN: it could still SSH in, and then relay ports back over the tailnet (a plain TCP relay on a tailnet-connected LAN peer is a good out-of-band path worth keeping ready).
2. **The VM app lost its WindowServer connection** (`HIToolbox: received notification of WindowServer event port death`) while surviving as a process. Every later black screen traced to this, and nothing guest-side could fix it; only restarting the app restored rendering.
3. The session's `caffeinate` died, so the host resumed auto-locking.

Rule: on a remote Mac, never run session-level commands (`killall -HUP loginwindow`, `pkill -u <user>`, logout, fast user switching). `killall WallpaperAgent` alone is session-safe. Before any such command, enumerate what depends on that session: VPN, VM processes, port forwards, keep-awake helpers.

### Keeping host and guest usable unattended

- **Host**: `caffeinate -d -i -m -u` prevents display sleep but does NOT override the lock policy. "Require password after screen saver begins or display is turned off → Never" must be set in System Settings; it needs the account password, so a passwordless-sudo shell cannot script it, and turning it off does NOT dismiss a lock that is already engaged (one more unlock is always needed). `pmset -a disablesleep 1` keeps a lid-closed laptop awake but **does not survive a reboot**, and OS updates reset it too, so a supervisor should re-apply it rather than assume it sticks.
- **Rebooting an encrypted host**: use `sudo fdesetup authrestart`. FileVault's pre-boot unlock doubles as the login, so the machine returns with a **live logged-in console session** and encryption intact, no password prompt, and supervision can then bring the VMs back by itself. Verified 2026-07-30. A plain `reboot` parks at the lock screen and blacks out every VM until a human logs in.
- **Guest**: set `autoLoginUser` plus a valid `/etc/kcpassword` (XOR-obfuscated password file, key `7D 89 52 23 D2 BC DE A3`, payload zero-padded to a multiple of 12). `sysadminctl -autologin` fails with `SACSetAutoLoginPassword error:22` on provisioned accounts, and a fresh guest has no Python, so generate the bytes on the controlling host and copy them in. Then `pmset -a displaysleep 0 sleep 0 disablesleep 1`, `defaults -currentHost write com.apple.screensaver idleTime 0`, `defaults write com.apple.screensaver askForPassword 0`, and `caffeinate` inside the guest. ⚠ `autoLoginUser` was observed being wiped by failed `sysadminctl -autologin` attempts; verify it after each boot until stable.
- **Wallpaper**: animated "aerials" wallpaper is brutal over VNC. The provider lives in `~/Library/Application Support/com.apple.wallpaper/Store/Index.plist` under several keys (`AllSpacesAndDisplays:Desktop`, `:Idle`, and `SystemDefault:*` which is what the login/lock screen uses). Switch each `Provider` to `com.apple.wallpaper.choice.solid-color` with PlistBuddy and restart `WallpaperAgent`. The login-window copy is cached and only refreshes on a later login cycle.

### Remote GUI/SSH access to a guest (recipe, verified 2026-07-29)

The guest lives on the host-private NAT bridge, so remote access is guest-service + host-forward:

1. **In the macOS guest** (over ssh), use ONE mechanism, fully activated. The reliable form is Remote Management in a single kickstart call:
   ```
   sudo .../RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
     -activate -configure -access -on \
     -clientopts -setvnclegacy -vnclegacy yes -setvncpw -vncpw <8-char-pw> \
     -allowAccessFor -allUsers -privs -all -restart -agent -menu
   ```
   ⚠ **Half-configured states authenticate but refuse the session.** Loading `com.apple.screensharing` while Remote Management is deactivated (or vice versa) produces an Apple-client error that names the wrong culprit: *"Screen Sharing is not permitted on <host>. Disable and re-enable Screen Sharing or Remote Management in System Settings"*. A raw-protocol client can still authenticate AND open a framebuffer in that state, so protocol-level tests pass while every Apple client fails. The remedy is exactly what the dialog says, done over ssh: `launchctl unload -w …screensharing.plist`, `kickstart -deactivate -configure -access -off`, `pkill screensharingd`, then the single activate call above.
   Notes: `launchctl enable system/com.apple.screensharing` fails with "Could not find service" on this build; `load -w` is the plain-Screen-Sharing path if you deliberately want it instead of Remote Management. Apple clients negotiate `RSA-SRP` (auth type 33) and the guest logs `Authentication: SUCCEEDED :: User Name: … :: Type: RSA-SRP` on success, which is the definitive server-side confirmation.
2. **On the host**: a gateway port-forward makes the guest's 5900 reachable from the whole tailnet without per-client tunnels: self-authorize the host's own key, then `ssh -N -g -L 0.0.0.0:5901:<guest-ip>:5900 <user>@localhost` (nohup'd).
   ⚠⚠ **NEVER forward on host port 5900.** If the host has Screen Sharing enabled (our testbed does, from the pre-upgrade checklist), launchd already owns 5900 socket-activated. The `ssh -L` bind then fails with "Address already in use" **while the tunnel process keeps running**, so every symptom of success is present (process alive, port answers, real RFB banner) yet **every connection reaches the HOST's login window, not the guest**. This cost us an hour: guest credentials failed against the host's screensharingd, which reads exactly like broken guest auth, and we chased the (real, but irrelevant) provisioned-account identity bug. Diagnostics that would have caught it instantly: `sudo lsof -nP -iTCP:5900 -sTCP:LISTEN` showing `launchd` rather than `ssh`, or the guest's own logs showing NO auth attempts during a failed login. Always use a distinct host port and verify with `lsof` that the forward owns it.
   ⚠ `-g` binds all interfaces, so the forward is also visible on the host's LAN; the VNC layer still requires the account or VNC password. ⚠ The forward pins the guest IP, which changes per boot under plain NAT; re-point it after a guest reboot (the proper fix is a vmnet DHCP reservation, macOS 26 API, once we move off plain `VZNATNetworkDeviceAttachment`).
   Verified working: with the forward on 5901, both a provisioned account and a `sysadminctl`-created one authenticate successfully (RFB `SecurityResult` = 0) against the guest. The guest offers security types `[30, 33, 36, 2, 35]`, i.e. Apple DH/SRP **plus classic type 2**, so non-Apple VNC clients work with the legacy password once ARD's `-setvnclegacy` is set. (The host's screensharingd, by contrast, offered no type 2, which is itself a tell that you are talking to the wrong machine.)
3. **SSH from any tailnet device**: `ssh -J <host-user>@<host> codeman@<guest-ip>` (jump through the host), after adding the connecting machine's key to the guest's `authorized_keys`.

**Client-version incompatibility (macOS 27 servers vs older Screen Sharing clients)**: an older Mac's Screen Sharing client fails Apple's `RSA-SRP` handshake against macOS 27 servers, logging `Authentication: FAILED :: User Name: <user> :: Type: RSA-SRP` server-side, while a macOS 27 client authenticates against the same servers without issue. This was verified against BOTH a macOS 27 guest and a macOS 27 host with the operator's own account, so it is a client-side version skew, not configuration, and no server-side change fixes it. Same family as the documented "macOS 26 host cannot install a 27 guest" bug. Practical workaround: bypass Apple auth entirely with classic VNC auth (security type 2), which macOS offers only when Remote Management legacy VNC is enabled. Two ways to consume it: any third-party VNC client, or a browser via noVNC.

**Browser-based access chain (zero client install, version-proof)**, all hosted on the Mac:
```
browser --HTTP/WS--> websockify (+ noVNC static files)
                       --> type-2-only proxy   # rewrites the server's security-type list to [2]
                         --> ssh -L forward     # loopback hop; see the Local Network note below
                           --> guest:5900
```
Notes learned the hard way: (a) **never bind the forward on host port 5900** (see the launchd warning above); (b) a Python proxy cannot reach the guest subnet directly because macOS **Local Network privacy** denies headless CLI binaries, surfacing as `No route to host`, so point the proxy at a loopback `ssh -L` forward instead (Apple-signed `ssh` is unaffected); (c) noVNC needs `?resize=scale` or Scaling Mode → Local Scaling, otherwise a Retina host screen (2940x1912) is unusable in a browser window; (d) noVNC speaks security type 2 only, which is exactly why the proxy rewrite is needed.

**Debugging technique that settled all of this**: a ~80-line Python RFB client (scratchpad `vnclogin.py`) that implements Apple DH auth (security type 30) and continues through `ClientInit`/`ServerInit`. It reports the server's `SecurityResult` plus the framebuffer size and desktop name, which separates "credentials rejected" from "authorized but session refused" without any GUI client. Pair it with `log stream --predicate 'process == "screensharingd"'` inside the guest, and drive a REAL Apple client headlessly from the host with `sudo launchctl asuser <uid> sudo -u <user> osascript -e 'tell application "Screen Sharing" to open location "vnc://user:pass@host:port"'`, verifying the result via `lsof -nP -iTCP -a -p <pid>` (an ESTABLISHED socket to the target) since `screencapture` fails on a lid-closed laptop ("could not create image from display"). Tailscale was never implicated: both the raw client and Apple's client work over the tailnet address once the guest service is fully activated.

### Hard-won operational lessons (write these into any tooling)

- **Silent serial is normal, not failure.** Debian's GRUB/kernel log to the graphics console; nothing attaches a getty to hvc0 by default. The reliable boot signal is the DHCP lease (or passive `tcpdump -i bridge100`), never the serial port and never a quick ping (BSD ping's first packet often dies to ARP latency; passive capture showed "dead" guests alive).
- **DHCP lease entries carry truth**: `name=` shows the guest hostname, and the lease timestamps order events; stale entries linger, so compare timestamps before attributing a lease to a boot.
- **Never boot a base image read-write.** Every RW boot mutates it (dhclient lease cache, journal, cloud-init state) and destroys experiment reproducibility, exactly why the production design only ever boots bases under overlays. Provision INTO the base once at base-build time, or provision per-case overlays with the seed, then detach the seed.
- **A killed SSH client does not kill a remote `nohup`'d VM**, and the survivor holds the EFI variable store lock: "The EFI variable store is already in use" (`VZErrorDomain 50002`) means a zombie VM process, `pkill` it.
- **EFI variable stores are per-VM state.** Fresh stores boot reliably; reuse across different VM instances is at minimum suspect on this beta (Apple's own guidance for cloned VMs is one store per VM). Cheap policy: one store per case, created with the overlay, deleted with it.
- **Downloads from cloud.debian.org mirrors truncate silently**; always verify byte count against origin `Content-Length` and resume with `curl -C -`.
- The remote host's default shell is zsh: `=` -prefixed words (`echo ===`) explode via zsh's `=cmd` expansion; keep separators zsh-safe in automation.

### The 2-concurrent-macOS-VM cap: TESTED AND CONFIRMED on macOS 27 beta 4 (2026-07-29)

We measured it, which as far as we can tell nobody had published for macOS 27. Method: `cp -c -R` the guest bundle (APFS clonefile, instant and **zero additional disk**), regenerate the machine identifier per clone (`VZMacMachineIdentifier()` written to `machine.id`; the hardware model is reused), then launch VMs until one is refused.

Result: VM #1 (8 GB, GUI) and VM #2 (4 GB, headless) ran concurrently without complaint. VM #3 was refused **instantly** at `vm.start`:

```
VZErrorDomain Code=6 "The maximum supported number of active virtual machines has been reached."
NSLocalizedFailure = "The number of virtual machines exceeds the limit."
```

**This is a licensing/kernel quota, not a resource limit**: the refusal came with **39% of system memory free** on a 16 GB host, and adding RAM or CPU cannot raise it. It matches the pre-27 behavior (`hv_apple_isa_vm_quota`), so nothing changed in 27 despite the framework's other additions. Linux guests are unaffected and are bounded only by host resources.

Design consequences: macOS-guest capacity per host is **hard-capped at 2**, so a GUI-macOS-per-case product must schedule around it (queue, evict idle VMs, or scale across hosts) and surface it in the UI. Also relevant: the acknowledged slot-leak bug (a guest-initiated shutdown failing to release a slot, recoverable only by host reboot) is far more damaging under a cap of 2 than it sounds; we did not reproduce it on beta 4, but any scheduler should treat "slot appears used but nothing is running" as a real state.

### Not yet tested
- Cache layers (`LayerType.cache`), `.overlay(blockCount:)` disk growth, stack depth performance, VirtioFS + stack combination, `truncate`, ASIF disks for macOS guests (raw used so far; ASIF has the reclamation bug).
- One more scripting lesson from this session: inner `ssh` calls inside a piped `sh -s` script MUST use `-n`, or they consume the remainder of the script from stdin and it silently never runs.

### Session timeline (what was actually established, 2026-07-29)

Linux path: base image download (with resume, mirrors truncate) → `vzboot` compiles against the beta SDK first try → EFI boot → NAT DHCP lease → cloud-init seed provisions a user with the host's SSH key → `ssh` into the guest works → DiskImageKit stack boots with an ASIF overlay taking all writes while the base stays SHA-identical. Later Linux boots became unreliable on an un-rebooted host (silent hangs, 0% CPU, no DHCP); a clean-baseline retest is still pending.

macOS path: seed-CDN IPSW (matched to the host build) → `VZMacOSInstaller` restore, ~25 min, first try → first boot with `VZMacGuestProvisioningOptions` creates an admin account with Remote Login on, no interaction needed, SSH reachable ~140 s later → key bootstrap over a one-time password login → guest shutdown/relaunch clean (the slot-leak bug did not reproduce) → GUI access fought through a port collision, a client-version incompatibility, the rendering dependency, and a self-inflicted session kill, ending with a browser-based path plus a guest hardened to auto-login and never lock.

**Lifecycle verified (stop → start), 2026-07-30**: an in-guest `shutdown -h now` fires `guestDidStop` and the runner app exits on its own; relaunching from the same bundle boots the guest in ~2 minutes straight into an auto-logged-in desktop, and the VM slot is released cleanly (an immediate restart works, so the slot-leak bug did not bite). Two operational notes: the guest takes a **new NAT lease on every boot**, so any port-forward must be re-pointed (or use a vmnet DHCP reservation), and a host reboot resets `pmset -a disablesleep`.

⚠ **Provisioning does NOT skip the per-user first-login assistant.** `VZMacGuestProvisioningOptions` skips the initial Setup Assistant (account creation, region, Apple Account) so the machine is immediately reachable, but the first time anyone actually logs into a desktop, macOS still presents its per-user wizard (Apple Intelligence, Siri, privacy, appearance, Touch ID). The operator hit exactly this. For a GUI-first product this MUST be pre-suppressed during base-image creation by writing `com.apple.SetupAssistant` keys for every account that will log in, and into `/System/Library/User Template/English.lproj/Library/Preferences/` so accounts created later inherit it.

⚠ **A partial key list is worse than none**, because the wizard simply shows the panes you missed and the operator has to click through them again after every fresh login (we hit this twice). The set that finally silenced macOS 27 beta 4: `DidSeeCloudSetup`, `DidSeeSiriSetup`, `DidSeePrivacy`, `DidSeeAppearanceSetup`, `DidSeeTouchIDSetup`, `DidSeeAvatarSetup`, `DidSeeScreenTime`, `DidSeeApplePaySetup`, `DidSeeSafariImport`, `DidSeeAccessibility`, **`DidSeeActivationLock`, `DidSeeAppStore`, `DidSeeLockdownMode`** (the three easy to miss), plus the Express-Settings flags **`SkipExpressSettingsUpdating`** and **`SkipFirstLoginOptimization`**, and the version markers `LastSeenCloudProductVersion` / `LastSeenBuddyBuildVersion` / `PreviousSystemVersion` / `PreviousBuildVersion` matching the guest build. Verify afterwards by reading the domain back and checking that no `DidSee*` key is still `0`. Note these keys change between macOS releases, so base-image creation should re-verify per OS version rather than trust a hardcoded list.

## 9. Design implications for Codeman's VM subsystem

0. **GUI is a first-class mode, and for macOS guests it is the whole point (owner decision, 2026-07-29).** The subsystem serves real desktops, not only headless SSH boxes. macOS guests are GUI-only in practice (nothing renders without an attached view). Linux guests are supported in BOTH modes: GUI when the case wants a desktop, headless-over-SSH when it wants a cheap agent sandbox. The costs of the GUI path are in §8 "Display rendering": VMs as GUI apps in a live session, a host that never locks, guests that auto-login with their first-login wizard pre-suppressed, and the macOS concurrency cap as a real capacity limit.
1. **The macOS-specific liabilities are accepted costs, not reasons to avoid macOS guests**: provisioning is macOS-only and first-boot-only, ASIF space reclamation is broken for macOS guests on the beta (use RAW disks for macOS guests until fixed), and the 2-VM cap applies. Plan around each: RAW-backed macOS disks, provisioning baked into base-image creation, and capacity limits surfaced in the UI.
2. **Base immutability is not just hygiene, it is load-bearing**: DiskImageKit's UUID invalidation plus our sha-stability proof make a read-only shared base per image-generation the core artifact. Bases are built once (seed attached), then only ever opened `.readOnly` under per-case overlays.
3. **Seed ISOs are a base-build-time tool only.** Never attach a seed to a routine case boot (correlated with boot hangs on the beta, and semantically wrong anyway since cloud-init already ran).
4. **Per-case files**: overlay ASIF + EFI variable store live and die together with the case.
5. **Export = ship the layer chain** (base ref + overlay + manifest), not flatten; there is no flatten API. In-guest `dd` to a fresh image is the fallback for a true single-file export.
6. **Health checking must be lease/API based**, not serial/ping based, and Codeman's `codeman-vm status` should read `/var/db/dhcpd_leases` (or use vmnet DHCP reservations for deterministic per-case IPs, a macOS 26 API).
7. **Run `fstrim` periodically in Linux guests** (or mount with discard) so overlays stay sparse.
8. **Entitlements plist stays minimal** (exactly `com.apple.security.virtualization`) to dodge the AMFI/watchdog traps.
9. **Expect beta churn**: pin findings to build numbers (this doc: 26A5388g) and retest each beta; the framework binaries changed every beta so far.
10. **A macOS guest is only "ready" when its desktop is ready**, which is a stricter bar than "the VM booted". Readiness means: VM app running with a live WindowServer connection, guest auto-logged-in (not at a login or lock screen), first-login assistant suppressed, and the guest's screen sharing serving a non-black framebuffer. Health checks should sample the framebuffer for non-black content, because every failure mode in this session (headless run, locked host, dead WindowServer, locked guest, setup wizard) presents as a perfectly healthy-looking process with a black or useless screen.
10b. **Supervision must run as a root LaunchDaemon.** A user LaunchAgent cannot launch a GUI app into the Aqua session; its restarts fail silently (child dies instantly, empty log, supervisor reports success). Root + `launchctl asuser <uid> sudo -u <user> …` works and the launched process persists. This bit us on the first supervisor implementation and is easy to repeat.

11. **Remote-access plumbing belongs in the helper CLI, not in ad-hoc shell**: a `codeman-vm` implementation should own port selection (never 5900), forward lifecycle across guest IP changes (or better, vmnet DHCP reservations for stable per-case IPs), and a documented browser path, because every failure in this session came from hand-rolled plumbing rather than from the Virtualization APIs themselves.
12. **Never let control-plane connectivity depend on a GUI session** on a remote Mac host: prefer a Tailscale system service over the App Store app, and keep a LAN-adjacent peer able to relay as an out-of-band recovery path.

## Sources

Apple DocC JSON backend (diskimagekit, virtualization, vmnet trees; macOS 27 release notes) | WWDC26 session 224 https://developer.apple.com/videos/play/wwdc2026/224/ | eclecticlight.co ASIF/virtualization coverage | developer.apple.com/forums threads 839343 (CSIdentity bug), 830118 (cross-version restore), 830119 (VM-slot leak), 830383 (VM cap), 834822 + 831902 (USB entitlements), 822658 (vmnet loopback) | openai/tart issues 1261/1263/1268/1269/1285 | Spooky-Labs provisioning design doc | VirtualBuddy 2.2 release notes | lima-vm discussions | our own test transcripts on the testbed (`~/vm-lab/*.log`, this repo's session)
