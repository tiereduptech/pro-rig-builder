# Phase A — pull deploy on STAGING only

Production stays on Railway. DNS does not move. Nothing in this document touches
`public_html` or the production docroot.

Design and the measurements behind every number: `deploy/DESIGN-pull-deploy.md`.

---

## Fast path

`deploy/install-phase-a.sh` does sections 1 through 6 of this document, with a
confirmation prompt before each of the two steps that change live behaviour (the
docroot flip and the crontab entry), and a `--uninstall` that reverses both:

```
curl -fsSL https://raw.githubusercontent.com/tiereduptech/pro-rig-builder/main/deploy/install-phase-a.sh -o ~/install-phase-a.sh && bash ~/install-phase-a.sh
```

The rest of this document is the manual equivalent, and the explanation of why
each step is shaped the way it is.

---

## 0. What CI needs first

One repo **variable**, and only after the box is installed:

| kind | name | value | when |
|---|---|---|---|
| variable | `EPIK_WATCH_STAGING` | `true` | AFTER the install, or the watchdog goes red every 30 min on a status file that does not exist yet |

`EPIK_PULL_SECRETS_DIR` is an optional **secret** that overrides the staging
`AuthUserFile` directory. It defaults to `/home/tier5415/prb-staging/secrets`, so
Phase A needs no new secret — the value is a path on the box, not a credential.
It exists because **the release branch is public**,
which is the whole reason the box needs no credential to pull — so the staging
Basic-Auth hash must never be published. `build-epik.cjs` uses `EPIK_REMOTE_ROOT`
for exactly one thing, the `AuthUserFile` path in the staging guard, so the
publish job points it at this secrets directory instead of the docroot. The
artifact then carries the *directive* but not the *credential*, the job deletes
`dist/.htpasswd` before publishing, and both the publish job and `epik-pull.sh`
hard-fail if a `.htpasswd` ever appears in a tree.

Already present and reused as-is: `EPIK_STAGING_BASIC_AUTH`, `EPIK_STAGING_URL`.

`EPIK_PULL_AUTO_PUBLISH` is deliberately **not** set. Until it is, publishing is
`workflow_dispatch` only — a push to `main` will not publish anything.

---

## 1. On the box, once, by hand

Nothing below moves or deletes a live directory except step 5, which is the
docroot flip, and it *renames* the current tree rather than removing it.

```bash
# 1. tree
mkdir -p ~/prb-staging/{bin,releases,state,tmp,log,secrets}
chmod 700 ~/prb-staging/secrets

# 2. the Basic-Auth credential the artifact deliberately does NOT carry.
#    Same user:password as the EPIK_STAGING_BASIC_AUTH secret.
#    {SHA} entry, matching what build-epik.cjs generates:
printf 'USER:{SHA}%s\n' "$(printf 'PASSWORD' | openssl sha1 -binary | openssl base64)" \
  > ~/prb-staging/secrets/.htpasswd
chmod 600 ~/prb-staging/secrets/.htpasswd

# 3. the script
curl -fsSL https://raw.githubusercontent.com/tiereduptech/pro-rig-builder/main/deploy/epik-pull.sh \
  -o ~/prb-staging/bin/epik-pull.sh
chmod +x ~/prb-staging/bin/epik-pull.sh

# 4. config. The script derives its root from its own location, so this file is
#    the ONLY difference between the staging and production installs.
cat > ~/prb-staging/config <<'CFG'
REPO=tiereduptech/pro-rig-builder
BRANCH=epik-release-staging
SITE_URL=https://staging.prorigbuilder.com
DOCROOT=/home/tier5415/staging.prorigbuilder.com
BASIC_AUTH=USER:PASSWORD
EXPECT_GUARD=1
RETAIN=10
CFG
chmod 600 ~/prb-staging/config
```

Set `DOCROOT` to whatever the staging docroot actually is — confirm with
`ls -d ~/staging*` before continuing. It must be the path the vhost serves.

---

## 2. Publish a staging release

Actions → **Publish Epik release artifact** → Run workflow → target `staging`,
confirm **off** for this first run (nothing is pulling yet, so the poll would
just time out).

---

## 3. First pull, before anything is live

```bash
~/prb-staging/bin/epik-pull.sh --bootstrap
```

`--bootstrap` skips the docroot assertion and the healthcheck, because nothing is
serving the tree yet. It still does the **full** verification — manifest,
per-file hashes, `manifest_sha256`, required files, guard-present, no `.htpasswd`.
It ends with `~/prb-staging/current -> releases/<sha>` and nothing else changed.

---

## 4. Look at it before it is live

```bash
ls -l ~/prb-staging/current
cat ~/prb-staging/releases/*/RELEASE.json
grep -c PRB-STAGING-GUARD ~/prb-staging/current/.htaccess   # must be >0 on staging
find ~/prb-staging -name .htpasswd                          # must print ONLY secrets/.htpasswd
```

---

## 5. Flip the staging docroot

The one irreversible-ish step, and the only one that touches a live path. It
**renames** the existing docroot rather than deleting it, so the SFTP-deployed
tree is still there to flip back to.

```bash
cd ~
mv staging.prorigbuilder.com staging.prorigbuilder.com.pre-pull
ln -s /home/tier5415/prb-staging/current staging.prorigbuilder.com
readlink staging.prorigbuilder.com      # must print /home/tier5415/prb-staging/current
```

To undo at any point: `rm staging.prorigbuilder.com && mv staging.prorigbuilder.com.pre-pull staging.prorigbuilder.com`.

Then prove it serves:

```bash
~/prb-staging/bin/epik-pull.sh --check
```

`--check` asserts the docroot, runs the full healthcheck (10-request worker
unanimity on `_env.php` + the complete fixture), and writes `_deploy-status.json`.

---

## 6. Crontab

```
MAILTO=coby@tiereduptech.com
*/5 * * * * /usr/bin/flock -n /home/tier5415/prb-staging/deploy.lock /home/tier5415/prb-staging/bin/epik-pull.sh >> /home/tier5415/prb-staging/log/deploy.log
```

Note what is **not** redirected: only stdout goes to the log. The script is
silent on stdout for routine no-op ticks and writes to **stderr only on failure**,
so cron mails you exactly when something broke and never otherwise. `2>&1` would
swallow that — its absence is deliberate.

`flock -n` makes an overlapping tick a **no-op** rather than queueing it.

---

## 7. Prove the loop end to end

Publish again (target `staging`, confirm **on**). Within ~10 minutes the box
should pull, swap, healthcheck at T+15s and T+45s, and write status; the workflow
should then go green on its own by reading the site.

Verify from anywhere:

```bash
curl -u USER:PASS https://staging.prorigbuilder.com/_deploy-status.json
curl -u USER:PASS https://staging.prorigbuilder.com/_env.php
curl -u USER:PASS -I https://staging.prorigbuilder.com/_ops/epik-fixture.json   # must be 403
```

---

## 8. Stop Point C

```bash
EPIK_BASIC_AUTH='USER:PASSWORD' node test/verify-epik.cjs \
  railway=https://prorigbuilder.com \
  epik=https://staging.prorigbuilder.com
```

Same fixture, both stacks, side by side, redirects not followed. Exit 0 and
`ALL CLEAR` is the gate. **Production stays on Railway and DNS does not move
until that table is clean.**

---

## 9. Rollback of the whole experiment

Phase A is fully reversible and none of it touches production:

1. remove the crontab line
2. `rm ~/staging.prorigbuilder.com && mv ~/staging.prorigbuilder.com.pre-pull ~/staging.prorigbuilder.com`
3. set `EPIK_WATCH_STAGING=false`

`deploy-epik.yml` (SFTP) is untouched throughout and remains the only thing that
can deploy production.
