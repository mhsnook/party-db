'use strict'

// Turn two directories of collected static-check output into markdown
// fragments plus a gate sidecar. Section order comes from the numeric filename
// prefix, so fragments render consistently whatever order the jobs finish in.
//
// party-db has no linter and no formatter, so the typecheck is the only static
// check rendered here.

const fs = require('fs')
const path = require('path')
const { parsers, differential, readLines, countSummary, listBlock } = require('./delta.cjs')

// How many issues to print before collapsing to "… and N more".
const CAP = 50

module.exports = function render({ head, base, out }) {
	fs.mkdirSync(out, { recursive: true })
	const write = (name, markdown, gate) => {
		fs.writeFileSync(path.join(out, `${name}.md`), markdown)
		fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(gate, null, 2))
	}

	// A whole tree's output directory is absent when that job died before the
	// static checks ran. Diffing nothing against nothing renders "no change",
	// which is the most dangerous thing this report can say, so name the tree
	// that is missing and let the gate fail the check.
	const missingTree =
		!fs.existsSync(head) ? 'The PR' : !fs.existsSync(base) ? 'The base branch' : null
	if (missingTree) {
		write(
			'10-typecheck',
			`#### Type errors\n\n⚠️ ${missingTree} job produced no measurement, so there is nothing to compare. Check the job log.`,
			{ check: 'typecheck', missing: true }
		)
		return
	}

	const tc = differential(
		readLines(`${base}/typecheck.txt`),
		readLines(`${head}/typecheck.txt`),
		parsers.tsc
	)
	write(
		'10-typecheck',
		[
			'#### Type errors',
			'',
			countSummary(tc, 'error(s)'),
			listBlock('New', tc.added, CAP),
			listBlock('Resolved', tc.resolved, CAP),
		]
			.filter((l) => l !== null)
			.join('\n'),
		{ check: 'typecheck', new: tc.added.length, resolved: tc.resolved.length, total: tc.head }
	)
}
