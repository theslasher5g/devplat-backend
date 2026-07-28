# Database backups — Infomaniak Swiss Backup

Nightly encrypted `pg_dump` to Swiss Backup over rclone, plus a weekly restore
test and a staleness alert.

The point of the last two: an untested backup is a belief, and a backup job
that silently stopped four months ago looks exactly like one that works. Both
failure modes are only discovered on the day you actually need the data.

```
pg_dump -Fc  →  gpg AES-256  →  rclone copy  →  prune by age
                                     ↓
                          POST /internal/backup-report
                                     ↓
                    admin dashboard + alert if it goes quiet
```

## What you have to change

Four things, and nothing else.

| # | Where | What |
|---|---|---|
| 1 | `/root/.config/rclone/rclone.conf` | The file Infomaniak emailed you. Replace `[password]`, and rename the section to `[swissbackup]`. |
| 2 | `/opt/devplat/backup.env` | `BACKUP_PASSPHRASE` — generate one, and **also save it in your password manager**. |
| 3 | `/opt/devplat/backup.env` | `BACKUP_REPORT_TOKEN` — any random string. |
| 4 | `/opt/devplat/backend/.env` | The same `BACKUP_REPORT_TOKEN`, so the API accepts the report. |

Everything else in `backup.env.example` already matches this deployment.

## Setup

**1. rclone and the remote**

```bash
curl https://rclone.org/install.sh | sudo bash

mkdir -p /root/.config/rclone && chmod 700 /root/.config/rclone
# Paste in the file Infomaniak emailed you, replacing [password] and renaming
# the section to [swissbackup]. See rclone.conf.example for what to touch.
nano /root/.config/rclone/rclone.conf
chmod 600 /root/.config/rclone/rclone.conf

rclone lsd swissbackup:          # must list the "default" container
```

**2. Backup config**

```bash
cp /opt/devplat/backend/deploy/backup/backup.env.example /opt/devplat/backup.env
openssl rand -base64 48          # → BACKUP_PASSPHRASE (save it elsewhere too!)
openssl rand -hex 32             # → BACKUP_REPORT_TOKEN (same value in backend/.env)
nano /opt/devplat/backup.env
chown root:root /opt/devplat/backup.env && chmod 600 /opt/devplat/backup.env
```

Add the matching line to `/opt/devplat/backend/.env` and restart the API:

```
BACKUP_REPORT_TOKEN=<the same hex string>
```

```bash
cd /opt/devplat && docker compose up -d api
```

**3. First run, by hand**

```bash
/opt/devplat/backend/deploy/backup/backup.sh
/opt/devplat/backend/deploy/backup/restore.sh --list
/opt/devplat/backend/deploy/backup/restore.sh --verify
```

Do not schedule anything until `--verify` prints `VERIFY OK`. A backup you have
never restored is not yet a backup.

**4. Schedule**

```bash
crontab -e
```

```cron
# Nightly backup at 02:15, and a restore test every Sunday at 03:30.
15 2 * * *  /opt/devplat/backend/deploy/backup/backup.sh  >> /var/log/devplat-backup.log 2>&1
30 3 * * 0  /opt/devplat/backend/deploy/backup/restore.sh --verify >> /var/log/devplat-backup.log 2>&1
```

02:15 UTC is roughly 03:15/04:15 Swiss time — the quietest point for a CI-driven
product, whose load follows working hours.

## Restoring

```bash
./restore.sh --list                          # what exists
./restore.sh --verify                        # newest, into a scratch DB, safe
./restore.sh --into devplat_old <archive>    # side-by-side copy to inspect
./restore.sh --production                    # overwrite live (prompts first)
```

For `--production`, stop the API first so nothing writes mid-restore:

```bash
docker compose -f /opt/devplat/docker-compose.yml stop api
./restore.sh --production
docker compose -f /opt/devplat/docker-compose.yml start api
```

## Design notes

**`copy`, never `sync`.** Infomaniak's FAQ demonstrates `rclone sync`, which
makes the destination match the source. Pointed at a staging directory holding
only tonight's dump, the very first run would delete every older backup on the
remote. `backup.sh` uses `copy` and prunes explicitly by age.

**Encrypted before it leaves the host.** The database holds bcrypt hashes, API
token hashes, and — because TOTP is symmetric and has to stay verifiable —
every enrolled user's live second-factor secret. That must not sit readable in
a third party's object storage, however Swiss.

**gpg rather than an rclone `crypt` remote.** The archive is then a
self-contained file that any machine with gpg and the passphrase can open. In a
real disaster, fewer moving parts between you and your data beats encrypted
filenames. It also means rclone's config holds no secret beyond the Swift
credentials.

**The passphrase is the whole backup.** It lives in `/opt/devplat/backup.env`
(root, 0600) so cron can run unattended. If that file dies with the VPS and the
passphrase exists nowhere else, every archive you own is noise. Put it in your
password manager the moment you generate it.

**What this does not cover.** The `hosts` Firecracker machines hold no durable
state — a VM is scratch by design — so only Postgres is backed up. If that ever
changes, this is the place to extend.
