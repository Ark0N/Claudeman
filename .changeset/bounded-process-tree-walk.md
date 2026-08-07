---
'aicodeman': patch
---

Bound the process-tree walk that could take a machine down.

`getChildPids` ran `pgrep -P <pid>` per node and recursed with no visited set, no
depth limit and no node cap. Across ~28 adopted tmux trees the fan-out exploded,
and because each `pgrep` blocks in the kernel while reading `/proc/<pid>/cgroup`
under WSL, none returned while the walk kept spawning more — ~13,000 `pgrep`
processes stuck in D-state out of ~39,000 total, load average above 13,000,
recoverable only by restarting WSL.

Now: one `ps` snapshot, breadth-first with a visited set, a depth cap and a node
cap, in a pure module (`proc-tree.ts`) that the regression tests exercise
directly. The snapshot is refreshed asynchronously, and the kill path forces a
fresh one so the SIGKILL escalation cannot re-read pre-SIGTERM state.
