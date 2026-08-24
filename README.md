# SureFlow Store Controller — Local Relay

The store-local relay the POS lanes talk to: receipt printing, cash drawer, cheque
station, pinpad, pole display, offline sales, and cloud sync.

## This repo is a deployment artifact, not the editing surface

The relay's source of truth is the **SureFlow admin app**. Relay code is authored there
and *published* into this repo, which is then tagged. Do not hand-edit files here — the
next publish overwrites them, and a technician reading the app's reference would be
reading something the fleet is not running.

Publish from: **Admin → Controller Updates → Relay Repo**.

## Install on a controller

Do not clone this by hand. The controller installer does it:

    tar xzf sureflow-controller-*.tar.gz
    cd sureflow-controller-*
    sudo ./install

The wizard clones this repo into /srv/sureflow/relay, runs npm install and npm run build,
writes .env, installs the systemd unit, and starts the relay.

## Private repo access from a store controller

The controller must clone with **no interactive auth**. Use a read-only deploy key:

    # on the controller, as root
    ssh-keygen -t ed25519 -C "sfc-<store>-a" -f /root/.ssh/id_ed25519 -N ""
    cat /root/.ssh/id_ed25519.pub

Add that public key to this repo under **Settings → Deploy keys** (read-only, one key per
controller so a single box can be revoked without touching the fleet), then confirm:

    ssh -T git@github.com
    git clone git@github.com:alfredrb/sureflow-store-controller.git /tmp/relay-clone-test

HTTPS clone URL (needs a PAT instead of a key): https://github.com/alfredrb/sureflow-store-controller.git

## Releases

Stores are pinned to **tags**, never a moving branch — two stores updating on different
nights must land on identical code. Tags are named relay-MAJOR.MINOR.PATCH.

## Environment

Copy .env.example to .env and fill it in. The installer does this for you.

**Never put an inline comment in .env.** A trailing "# ..." is parsed as part of the
value; that is how this fleet got a NaN port and a broken endorsement indent.

| Variable | Purpose |
| --- | --- |
| STORE_ID | Store number this relay serves |
| RELAY_API_KEY / CLOUD_API_KEY | Per-store cloud sync key from the Relay Ops card |
| CLOUD_SYNC_URL | Cloud base URL for sync |
| RELAY_ACCESS_TOKEN | Gates the privileged routes; blank leaves them OPEN |
| KIOSK_ACCESS_TOKEN | Hands a cloud session to a booting lane at /kiosk |
| PRINTER_IPS | Comma-separated printer addresses; first is the default |
| BIND_ADDRESS | Backend-VLAN address (or VIP) the relay binds |
| PORT | 3000 |
| POS_DIST_URL | Optional. Tarball of the POS build for the local fallback |

## Files

- `server.js` — Express app, mount order, boot
- `api.js` — POS routes: catalog, sales, print
- `db.js` — SQLite catalog cache + offline outbox
- `sync.js` — Cloud sync worker
- `auth.js` — Relay token gate
- `telemetry.js` — Printer paper state + heartbeats
- `printer.js` — ESC/POS receipts + drawer kick
- `checkReader.js` — MICR read + endorsement
- `pinpad.js` — Ingenico customer pinpad
- `poledisplay.js` — Customer pole display
- `laneReboot.js` — Lane reboot queue
- `fetch-pos-dist.sh` — populates pos-dist for the local POS fallback
- `sureflow-backup.sh` / `sureflow-selfupdate.sh` — ops scripts on systemd timers
- `sureflow-relay.service` — reference hardened unit

## Health

    curl -s http://localhost:3000/status
    node --check server.js
    journalctl -u sureflow-relay -n 40 --no-pager

The store's relay_url in the Infrastructure Command Center must be the **backend**
address on port 3000 — a relay URL on the isolated PXE VLAN always reads as unreachable.
