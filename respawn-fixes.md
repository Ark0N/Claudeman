# Suggested Fixes for Respawn Controller Issues

**DO NOT EXECUTE** - Waiting for user review

## Fixes


### Fix for Issue #1
**Send/wait state stuck**

Stuck in waiting_update - the controller is trying to send a command but may not be receiving expected response.

Check terminal output:
```bash
curl -sk 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/terminal?tail=10000' | tail -100
```

Try restarting respawn:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/stop'
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/start'
```


### Fix for Issue #2
**Check for hung session**

The session may be hung. Check:

1. Session process status:
```bash
screen -ls | grep reddit
```

2. Attach to screen and check:
```bash
screen -r claudeman-w3-reddit-analyse
# Press Ctrl+A D to detach
```

3. If hung, restart the session via web UI or:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/stop'
# Then start a new session
```


### Fix for Issue #3
**Check for hung session**

The session may be hung. Check:

1. Session process status:
```bash
screen -ls | grep reddit
```

2. Attach to screen and check:
```bash
screen -r claudeman-w3-reddit-analyse
# Press Ctrl+A D to detach
```

3. If hung, restart the session via web UI or:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/stop'
# Then start a new session
```


### Fix for Issue #4
**Watching state stuck**

The controller is watching but not detecting idle. Possible causes:
1. Session is actively working (expected behavior)
2. Idle detection thresholds too high

Check session activity:
```bash
curl -sk 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98' | jq '{status, lastActivityAt}'
```

If truly idle, try adjusting config:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/config' -H 'Content-Type: application/json' -d '{"idleThresholdMs": 30000}'
```


### Fix for Issue #5
**Check for hung session**

The session may be hung. Check:

1. Session process status:
```bash
screen -ls | grep reddit
```

2. Attach to screen and check:
```bash
screen -r claudeman-w3-reddit-analyse
# Press Ctrl+A D to detach
```

3. If hung, restart the session via web UI or:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/stop'
# Then start a new session
```


### Fix for Issue #6
**Check for hung session**

The session may be hung. Check:

1. Session process status:
```bash
screen -ls | grep reddit
```

2. Attach to screen and check:
```bash
screen -r claudeman-w3-reddit-analyse
# Press Ctrl+A D to detach
```

3. If hung, restart the session via web UI or:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/stop'
# Then start a new session
```


### Fix for Issue #7
**Enable respawn controller**

Via API:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/enable'
```

Or via web UI: Open session tab -> Respawn panel -> Enable


### Fix for Issue #8
**Enable respawn controller**

Via API:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/enable'
```

Or via web UI: Open session tab -> Respawn panel -> Enable


### Fix for Issue #9
**Send/wait state stuck**

Stuck in waiting_update - the controller is trying to send a command but may not be receiving expected response.

Check terminal output:
```bash
curl -sk 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/terminal?tail=10000' | tail -100
```

Try restarting respawn:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/stop'
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/start'
```


### Fix for Issue #10
**Enable respawn controller**

Via API:
```bash
curl -sk -X POST 'https://localhost:3000/api/sessions/5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98/respawn/enable'
```

Or via web UI: Open session tab -> Respawn panel -> Enable

