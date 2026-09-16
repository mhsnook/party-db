#!/usr/bin/env bash
# Collect normalised static-check output into $1.
#
# Runs once on the head tree and once on the base tree, always from that tree's
# own root. Output is one sorted line per issue, so the diff engine can treat
# the two runs as comparable sets.
#
# party-db has no linter and no formatter, so the typecheck is the only static
# check here. There is nothing to restore afterwards either: every tsconfig sets
# `noEmit`, so nothing this script runs writes to the tree.

# Deliberately no `-e`: the typechecker exits non-zero when it finds errors,
# which is the normal case, not a script failure.
set -uo pipefail

OUT="${1:?usage: collect-static.sh <output-dir>}"
mkdir -p "$OUT"

# Byte-order sorting, so the two trees produce comparable lists even if the two
# runners ever differ in locale.
export LC_ALL=C

# `pnpm typecheck` is three `tsc -p` runs chained with `&&`, and that chain is
# wrong for a measurement in two separate ways:
#
#   1. The first failure short-circuits the other two, so a PR that adds a
#      client error hides every server and integration error behind it. The
#      delta would then report those as "resolved" the moment the client error
#      is fixed.
#   2. A tsc that fails before it typechecks — a missing tsconfig, a bad
#      `extends` — prints a message the `grep ': error TS'` below does not
#      always match, and an empty file reads as zero errors.
#
# So run the three projects separately, keep each exit status, and concatenate.
# They all set `noEmit`, so they cannot collide and they run concurrently.
PROJECTS=(tsconfig.client.json tsconfig.server.json tsconfig.integration.json)

for project in "${PROJECTS[@]}"; do
	(
		pnpm exec tsc -p "$project" >"$OUT/.tsc.$project.raw" 2>&1
		echo $? >"$OUT/.tsc.$project.status"
	) &
done
wait

status=0
for project in "${PROJECTS[@]}"; do
	rc=$(cat "$OUT/.tsc.$project.status" 2>/dev/null || echo 1)
	[ "$rc" -ne 0 ] && status="$rc"
done

# `sort -u`: the three projects overlap — src/protocol.ts and src/schema.ts are
# in all three — so one error in a shared file is printed up to three times.
# It is one error, and de-duplicating keeps the count honest. Two projects that
# genuinely disagree about a line still produce two different messages, which
# survive the `-u`.
#
# The grep drops tsc's own summary lines. Those change whenever the error count
# does, so they would diff as a permanent phantom issue.
cat "$OUT"/.tsc.*.raw | grep ': error TS' | sort -u >"$OUT/typecheck.txt"

# A typechecker that failed but printed nothing the grep recognises would leave
# an empty file, which reads as zero errors and merges clean. Record the failure
# as a synthetic issue instead, so the delta shows it and the gate blocks.
if [ "$status" -ne 0 ] && [ ! -s "$OUT/typecheck.txt" ]; then
	echo "typecheck:0:0: error TS0000: the typechecker exited $status without recognisable error lines — see the job log" \
		>"$OUT/typecheck.txt"
fi

# The raw logs are scratch, not part of the measurement. Leaving them in $OUT
# would upload them as artifacts and, worse, let a later `cat .raw` pick them up
# twice.
rm -f "$OUT"/.tsc.*.raw "$OUT"/.tsc.*.status

# Never let a missing file break the render step.
[ -f "$OUT/typecheck.txt" ] || : >"$OUT/typecheck.txt"

wc -l "$OUT"/*.txt
