#!/bin/bash
# =============================================================================
#  Epik PHP probe — STAGE 2.  Tests the load-bearing assumption behind R1.
#
#  §3/R1 claims: with the resolver INSIDE the swapped tree, __DIR__ is the real
#  release path, so one request reads one release, and PHP's realpath cache and
#  opcache cannot serve a stale mix.  That was inferred from the stage-1 probe's
#  realpath() output, never measured directly.  This measures it, three ways:
#
#    E1  /_q1/probe.php          in-tree, two hops — the design's actual shape.
#                                Answers: is __DIR__ already resolved?
#    E2  /_q2/stable.php         the counterfactual R1 rejects: a resolver on a
#                                stable docroot path reaching through `current`.
#                                Answers: is the 120s realpath TTL claim real?
#    E3  /_q2/stable-opcache.php worst case — an include whose two versions have
#                                identical size AND mtime, reached through the
#                                stable path.  Answers: can opcache serve stale
#                                bytes when the timestamp gives it no hint?
#
#  E2/E3 are not proposals.  They are there so R1 is a measured choice rather
#  than an asserted one, and so the mitigation cost is known if E1 comes back NO.
#
#  Both PHP-side caches are per-worker, so "first B" is not "settled".  The loop
#  reports first-B and 5-consecutive-B separately, and prints the worker pids.
#  The stable paths are PRIMED before the swap — a cold realpath cache resolves
#  fresh and would report a fake 0s.
#
#  SAFETY: same discipline as stage 1.  Creates only ~/prb-probe2, one symlink
#  and one directory inside the STAGING docroot, and aborts if either name is
#  already taken.  Never moves, renames, or deletes anything pre-existing.
#  public_html is never touched.
# =============================================================================
set -u

URL="https://staging.prorigbuilder.com"   # grey-cloud A record -> Epik
AUTH=""                                   # "user:pass" if the staging guard is on
SD=""                                     # staging docroot; auto-detected below
REL="$HOME/prb-probe2"
POLL_MAX=180                              # must exceed the 120s default realpath TTL
STABLE_N=5                                # consecutive B reads that count as settled

[ -z "$SD" ] && for c in "$HOME/staging.prorigbuilder.com" "$HOME/staging" "$HOME/public_html/staging"; do
  [ -d "$c" ] && SD="$c" && break
done
if [ -z "$SD" ]; then
  echo "!! Could not auto-detect the staging docroot. Set SD= at the top. Candidates:"
  ls -d "$HOME"/*/
  exit 1
fi
echo "staging docroot: $SD"

for n in "$SD/_q1" "$SD/_q2" "$REL"; do
  [ -e "$n" ] && { echo "!! $n already exists — refusing to touch it. Remove it or rename the probe."; exit 1; }
done
echo "CLEANUP AT ANY TIME:  rm -rf '$REL' '$SD/_q1' '$SD/_q2'"

A=""; [ -n "$AUTH" ] && A="-u $AUTH"

# ── two release trees ───────────────────────────────────────────────────────
mkdir -p "$REL/A" "$REL/B"
for r in A B; do
  printf 'RELEASE=%s\n' "$r" > "$REL/$r/data.txt"

  # inc.php: A and B differ by one byte, so size is identical.  mtime is forced
  # identical below.  This is the only shape in which opcache has nothing to
  # invalidate on.
  printf '<?php return "%s";\n' "$r" > "$REL/$r/inc.php"

  sed "s/@REL@/$r/g" > "$REL/$r/probe.php" <<'PHP'
<?php
header("Content-Type: text/plain");
header("Cache-Control: no-store, max-age=0");
$d = __DIR__;
$rp = realpath($d);
// LIVE= is what the timing loop greps: release identity derived from a data
// file read through __DIR__, not from a constant compiled into this script.
echo "LIVE=", trim(@file_get_contents($d . "/data.txt")) === "RELEASE=B" ? "B" : "A", "\n";
echo "script_release=@REL@\n";                 // flipped only when opcache re-reads this file
echo "data_release=", trim(@file_get_contents($d . "/data.txt")), "\n";
echo "__DIR__=", $d, "\n";
echo "realpath(__DIR__)=", ($rp === false ? "FALSE" : $rp), "\n";
echo "DIR_IS_RESOLVED=", ($d === $rp ? "YES" : "NO"), "\n";   // <= the R1 answer
echo "pinned_to=", ($rp === false ? "?" : basename($rp)), "\n";
echo "__FILE__=", __FILE__, "\n";
echo "SCRIPT_FILENAME=", $_SERVER["SCRIPT_FILENAME"], "\n";
echo "DOCUMENT_ROOT=", $_SERVER["DOCUMENT_ROOT"], "\n";
echo "open_basedir=", (ini_get("open_basedir") ?: "none"), "\n";
echo "realpath_cache_ttl=", ini_get("realpath_cache_ttl"), "\n";
echo "realpath_cache_size=", ini_get("realpath_cache_size"), "\n";
echo "opcache.enable=", ini_get("opcache.enable"),
     " validate_timestamps=", ini_get("opcache.validate_timestamps"),
     " revalidate_freq=", ini_get("opcache.revalidate_freq"),
     " file_cache=", (ini_get("opcache.file_cache") ?: "none"), "\n";
echo "php=", PHP_VERSION, " sapi=", PHP_SAPI, " pid=", getmypid(), "\n";
PHP
done
# identical mtime AND size on inc.php — the worst case for E3
touch -t 202601010000 "$REL/A/inc.php" "$REL/B/inc.php"
ls -l --time-style=long-iso "$REL/A/inc.php" "$REL/B/inc.php"

ln -sfn "$REL/A" "$REL/current"

# ── E1: in-tree resolver, two hops (the design's shape) ─────────────────────
ln -sfn "$REL/current" "$SD/_q1"

# ── E2/E3: stable-docroot resolver reaching through `current` ───────────────
mkdir -p "$SD/_q2"
sed "s#@BASE@#$REL#g" > "$SD/_q2/stable.php" <<'PHP'
<?php
header("Content-Type: text/plain");
header("Cache-Control: no-store, max-age=0");
$cur = "@BASE@/current";
$d = trim(@file_get_contents($cur . "/data.txt"));
echo "LIVE=", ($d === "RELEASE=B" ? "B" : "A"), "\n";
echo "mode=stable-docroot\n";
echo "readlink(current)=", (@readlink($cur) ?: "n/a"), "\n";   // never cached
echo "realpath(current)=", (realpath($cur) ?: "FALSE"), "\n";  // realpath cache
echo "data_via_symlink=", $d, "\n";
clearstatcache(true);
echo "-- after clearstatcache(true) --\n";
echo "realpath(current)=", (realpath($cur) ?: "FALSE"), "\n";
echo "data_via_symlink=", trim(@file_get_contents($cur . "/data.txt")), "\n";
echo "realpath_cache_ttl=", ini_get("realpath_cache_ttl"), " pid=", getmypid(), "\n";
PHP
sed "s#@BASE@#$REL#g" > "$SD/_q2/stable-opcache.php" <<'PHP'
<?php
header("Content-Type: text/plain");
header("Cache-Control: no-store, max-age=0");
$cur = "@BASE@/current";
$v = @include $cur . "/inc.php";   // A and B: same size, same mtime
echo "LIVE=", ($v === "B" ? "B" : "A"), "\n";
echo "mode=stable-docroot-include (identical size+mtime)\n";
echo "inc_release=", var_export($v, true), "\n";
echo "realpath(inc)=", (realpath($cur . "/inc.php") ?: "FALSE"), "\n";
if (function_exists("opcache_get_status")) {
  $s = @opcache_get_status(true);
  $keys = ($s && !empty($s["scripts"])) ? array_keys($s["scripts"]) : [];
  $hit = preg_grep("#inc\\.php$#", $keys);
  echo "opcache_keys_for_inc=", ($hit ? implode(" | ", $hit) : "none"), "\n";
} else {
  echo "opcache_keys_for_inc=opcache_get_status unavailable\n";
}
echo "pid=", getmypid(), "\n";
PHP
ls -l "$SD/_q1" "$SD/_q2"

# fail fast on a typo in the generated PHP, before the timing loop burns 3 min
if command -v php >/dev/null 2>&1; then
  for f in "$REL/A/probe.php" "$REL/B/probe.php" "$SD/_q2/stable.php" "$SD/_q2/stable-opcache.php"; do
    php -l "$f" >/dev/null 2>&1 || {
      echo "!! PHP syntax error in $f:"; php -l "$f"
      rm -f "$SD/_q1"; rm -rf "$SD/_q2" "$REL"; echo "cleaned."; exit 1
    }
  done
  echo "php -l: all four generated files parse"
else
  echo "(no CLI php — skipping lint; a parse error will show up as a 500 below)"
fi

E1="/_q1/probe.php"; E2="/_q2/stable.php"; E3="/_q2/stable-opcache.php"
g() { curl -sS --max-time 10 $A "$URL$1" 2>/dev/null; }
dump() { echo "== $1"; g "$1" | sed 's/^/   /'; }

echo
echo "############ BASELINE (current -> A) ############"
dump "$E1"; dump "$E2"; dump "$E3"

echo
echo "-- priming the stable paths (a cold realpath cache reports a fake 0s) --"
for i in $(seq 1 20); do g "$E2?p=$i" >/dev/null; g "$E3?p=$i" >/dev/null; done
echo "   primed; pids seen on E2:"
for i in $(seq 1 8); do g "$E2?w=$i" | sed -n 's/.* pid=/     pid=/p'; done | sort -u

# ── swap ────────────────────────────────────────────────────────────────────
echo
echo "-- atomic swap current -> B --"
ln -sfn "$REL/B" "$REL/current.tmp" && {
  mv -T "$REL/current.tmp" "$REL/current" 2>/dev/null || {
    rm -f "$REL/current.tmp"; ln -sfn "$REL/B" "$REL/current"
    echo "  (no mv -T; used non-atomic ln)"
  }
}
readlink "$REL/current"

first1="-"; stab1="-"; strk1=0
first2="-"; stab2="-"; strk2=0
first3="-"; stab3="-"; strk3=0
upd() { # $1=idx  $2=value  $3=elapsed seconds
  eval "s=\$strk$1; f=\$first$1; t=\$stab$1"
  if [ "$2" = "B" ]; then
    s=$((s+1))
    [ "$f" = "-" ] && f="${3}s"
    [ "$s" -ge "$STABLE_N" ] && [ "$t" = "-" ] && t="${3}s"
  else
    s=0
  fi
  eval "strk$1=$s; first$1='$f'; stab$1='$t'"
}

T=$(date +%s)
for i in $(seq 1 "$POLL_MAX"); do
  e=$(( $(date +%s) - T ))
  v1=$(g "$E1?t=$i" | sed -n 's/^LIVE=//p')
  v2=$(g "$E2?t=$i" | sed -n 's/^LIVE=//p')
  v3=$(g "$E3?t=$i" | sed -n 's/^LIVE=//p')
  upd 1 "${v1:-ERR}" "$e"; upd 2 "${v2:-ERR}" "$e"; upd 3 "${v3:-ERR}" "$e"
  printf '\r  t=%3ds  E1=%-3s E2=%-3s E3=%-3s' "$e" "${v1:-ERR}" "${v2:-ERR}" "${v3:-ERR}"
  [ "$stab1" != "-" ] && [ "$stab2" != "-" ] && [ "$stab3" != "-" ] && break
  sleep 1
done
echo; echo

echo "############ TIME TO SERVE RELEASE B ############"
printf '  %-34s %-12s %s\n' "endpoint" "first B" "${STABLE_N}x consecutive B"
printf '  %-34s %-12s %s\n' "E1 in-tree __DIR__  (the design)" "$first1" "$stab1"
printf '  %-34s %-12s %s\n' "E2 stable path realpath()"        "$first2" "$stab2"
printf '  %-34s %-12s %s\n' "E3 stable path include, same mtime" "$first3" "$stab3"
echo "  (stage 1 measured static content at 0s and .htaccess headers at ~8s)"

echo
echo "############ AFTER SETTLE (current -> B) ############"
dump "$E1"; dump "$E2"; dump "$E3"

cat <<'READ'

############ HOW TO READ IT ############
E1 DIR_IS_RESOLVED=YES  and  E1 first B = 0s
    R1 holds exactly as written in §3.  __DIR__ is the real release directory,
    each release is a distinct opcache key, and the resolver cannot mix releases
    within a request.  Nothing in the design changes.

E1 DIR_IS_RESOLVED=NO
    __DIR__ is the symlink path.  §3 no longer holds on its own: resolver.php
    needs `$R = realpath(__DIR__);` at the top and must use $R for all four
    reads, and the realpath-cache mitigation stops being optional.  E2's numbers
    are then the staleness you have inherited — read them as the cost.

E1 script_release stuck at A while data_release says B
    opcache is keyed on the unresolved path.  Same fix as above, plus the E3
    result becomes load-bearing.

E2 first B ≈ realpath_cache_ttl (120s default)
    Confirms the §3/R1 rationale with a number: a stable-path resolver really is
    worse than the 8s .htaccess skew it would have been fixing.

E2 "after clearstatcache(true)" shows B while the lines above show A
    clearstatcache(true) is a sufficient mitigation, and its cost is one extra
    stat per request.

E3 first B never arrives (stays A past POLL_MAX)
    opcache can serve stale bytes across a swap when size and mtime match.  Real
    releases rarely produce identical mtimes, so this is a tail risk, not a
    likely one — but it is only fully absent under R1, which is the argument for
    keeping the resolver in the tree.
READ

echo
# read from the terminal, not stdin — stdin is the pipe under `curl | bash`,
# which would EOF instantly and clean up before you could look at anything.
if [ -r /dev/tty ]; then
  read -t 600 -p "  Press Enter to clean up (or Ctrl-C and use the line above): " _ < /dev/tty || true
else
  echo "  no tty — leaving the probe in place. Clean up with the line above."
  exit 0
fi
rm -f "$SD/_q1"
rm -rf "$SD/_q2"
rm -rf "$REL"
echo "cleaned."
