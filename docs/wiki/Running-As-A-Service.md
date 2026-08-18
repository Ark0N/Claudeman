# Running As A Service

Keeping Codeman up: past the shell you started it in, past a logout, past a reboot. Plus
logs, updates, and running more than one instance.

## Three levels

| Level                | Survives                                  | Command                   |
| -------------------- | ----------------------------------------- | ------------------------- |
| Foreground           | Nothing. Dies with the terminal.           | `codeman web`             |
| Detached             | Closing the shell and logging out.         | `codeman web -d`          |
| Service              | Reboots.                                   | `codeman service install` |

Agents themselves survive all three, because they live in tmux. Stopping the server never
stops the agents.

## Detached mode

```bash
codeman web -d          # start detached; logs to ~/.codeman/web.log
codeman web --status    # is it up, and on which pid
codeman web --stop      # graceful stop; agents keep running
```

`-d` waits until the server actually answers before reporting success, so a port clash never
reads as a successful start.

Two implementation details that explain the behaviour:

- It relaunches the same entry script detached, so there is no controlling terminal and no
  shell job entry. `nohup` is **not** what makes this work: Node re-arms the hangup signal to
  its default even when it inherits "ignore", and Codeman handles that signal with a graceful
  shutdown, so a delivered hangup would still stop the server.
- `--stop` verifies the process still looks like a Codeman server before signalling it,
  because process ids get recycled.

**It refuses to start a second server on the same data directory.** Two servers sharing a
tmux socket attach to each other's live sessions.

## Installing as a service

```bash
codeman service install     # systemd user unit on Linux, LaunchAgent on macOS
codeman service status
codeman service uninstall
```

The installer's final menu offers this too.

Notable behaviours:

- **Your PATH is baked into the unit.** launchd hands a job
  `/usr/bin:/bin:/usr/sbin:/sbin`, which finds neither a Homebrew or nvm `node` nor `tmux`
  or `claude`. This is the single most common cause of a hand-written unit that starts and
  immediately dies.
- **`CODEMAN_PASSWORD` is never written into the unit file.** Add it yourself if the service
  needs authentication.
- **It refuses when a server is already running** on that data directory, for the same reason
  detached mode does.
- **It verifies rather than assumes.** `launchctl load` and a clean spawn are both silent
  about a server that starts and immediately exits, so the parent polls until the child
  answers or dies.

On Linux, if you want the service running while you are not logged in:

```bash
loginctl enable-linger $USER
```

### Writing the unit by hand

**Linux (systemd user unit):**

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/codeman-web.service << EOF
[Unit]
Description=Codeman Web Server
After=network.target

[Service]
Type=simple
ExecStart=$(which node) $HOME/.codeman/app/dist/index.js web
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now codeman-web
loginctl enable-linger $USER
```

**macOS (LaunchAgent):**

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.codeman.web.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codeman.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>$HOME/.codeman/app/dist/index.js</string>
    <string>web</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/tmp/codeman.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/codeman.log</string>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codeman.web.plist
```

Prefer `codeman service install` where you can. It handles the PATH problem for you.

## Logs

```bash
journalctl --user -u codeman-web -f    # systemd
tail -f ~/.codeman/web.log             # detached mode
log stream --predicate 'process == "node"'   # macOS, noisy
```

## Updating

| Install route | Update with                                                             |
| ------------- | ------------------------------------------------------------------------ |
| Installer     | Re-run the one-liner, or **App Settings → System → Updates**.             |
| npm           | `npm update -g aicodeman`                                                 |
| git clone     | `git pull && npm install && npm run build`, then restart.                 |

### The in-app updater

**App Settings → System → Updates**, for git-clone installs supervised by systemd or
launchd. npm installs report as non-updatable, and an unsupervised install is told to
restart manually.

The interesting part is that the update restarts the very process running it. So the real
work runs in a **detached script that outlives the restart** and writes progress to a status
file, which the browser polls across the connection drop. A dirty tree is stashed rather
than discarded.

### After updating

Sessions are unaffected: they live in tmux and the server reattaches. If the UI looks stale,
reload; on iOS Safari, close the tab completely and reopen.

## Running two instances

The data directory and the tmux socket are process wide, so a second server on the defaults
will discover and attach the first one's sessions. Scope both together:

```bash
CODEMAN_INSTANCE=beta CODEMAN_PORT=5000 codeman web
```

Service unit names are instance-scoped too, so a beta instance can be installed as its own
service without colliding with the main one. `CODEMAN_DATA_DIR` and `CODEMAN_TMUX_SOCKET`
exist for the rare case where they need to differ, but setting only one of them recreates
exactly the problem you were avoiding.

## The tunnel as a service

```bash
systemctl --user enable codeman-tunnel
loginctl enable-linger $USER
```

Or the toggle in **App Settings → System → Remote access**. See
[Remote Access](Remote-Access).

## Health checks

```bash
curl -s localhost:3000/api/status | jq '.version, .uptime'
codeman web --status
codeman doctor
```

Add `-k` and the `https://` URL on an HTTPS install.

## Read next

- [Installation](Installation) - the routes and what each supports.
- [Remote Access](Remote-Access) - exposing it once it stays up.
- [Troubleshooting](Troubleshooting) - when it does not.
