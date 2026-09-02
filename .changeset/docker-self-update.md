---
'aicodeman': minor
---

Restore in-app self-update for the Docker Compose deployment.

App Settings → Updates now works in the container, using the same updater,
status file and progress UI as a bare-host install. The Compose file mounts the
checkout it builds from at `/opt/codeman`, so an update's `git checkout` and
rebuild land on the host and survive container recreation, and the restart is
the server exiting — `restart: unless-stopped` relaunches it on the new build.

An in-place container update applies application code only, since a restarted
container reuses its existing image and configuration. The updater therefore
refuses a release that changes `docker/server.Dockerfile` or
`docker/docker-compose.yaml`, or that adds keys to `docker/.env.example` the
user's `.env` has no value for, naming what changed and pointing at
`docker/Start-Codeman.sh` on the host. It also refuses when the container's
restart policy would not bring it back. The missing-key check matters most:
Compose resolves an unset `${VAR}` to the empty string and starts anyway, so a
new required setting would otherwise arrive as a silently blank variable.

Supporting changes:

- The runtime image keeps devDependencies and gains `python3`/`make`/`g++`, so
  `npm install` and `npm run build` can run inside the container. This makes the
  image larger; that is the cost of updating in place.
- Build artefacts live in `codeman-node-modules` and `codeman-dist` named
  volumes so container-compiled native modules never land in the host checkout.
- The four global agent CLIs are pinned, so a release needing newer CLI
  behaviour becomes a Dockerfile change the environment gate can detect.
- `docker/Start-Codeman.sh` records the Dockerfile and compose fingerprints the
  container was created from, which is the baseline the gate compares against.
- New CI guard: `test/docker-compose-env-parity.test.ts` fails when a compose
  variable has no `.env.example` entry, or the reverse.

Documented in `docs/docker-self-update.md`.
