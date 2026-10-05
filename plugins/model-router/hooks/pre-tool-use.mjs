#!/usr/bin/env node
/**
 * The PreToolUse hook entry point. Registered for `Read` only — see hooks/hooks.json.
 *
 * Its whole job is I/O at the process boundary: read stdin, load the config, ask run.mjs, write
 * at most one line of JSON, exit 0. Every decision is made elsewhere.
 *
 * THIS PROCESS NEVER FAILS. stdout is a protocol channel that Claude Code parses, so there is no
 * logging, no diagnostic print and no stderr; `exit 2` is never used, because that would turn
 * stderr into Claude's feedback and block the tool call, which is the opposite of what a broken
 * router should do. An empty stdout with exit 0 is indistinguishable from the hook not being
 * installed, which is exactly the degradation this plugin promises.
 */

import fs from 'node:fs'

import { loadConfig } from '../lib/config.mjs'
import { writeExitDiagnostic } from '../lib/hook/exit-diagnostic.mjs'
import { runReadHook } from '../lib/hook/run.mjs'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

let wroteResponse = false

try {
  const raw = await readStdin()
  const { config } = loadConfig()
  const { response } = await runReadHook({ raw, config })

  if (response !== null) {
    // writeSync, not process.stdout.write: on a pipe, stdout can be asynchronous, and a buffered
    // write racing process exit is how a response arrives truncated. The telemetry sink uses the
    // same discipline for the same reason.
    fs.writeSync(1, JSON.stringify(response))
    wroteResponse = true
  }
} catch {
  // Nothing is reported, because there is nobody safe to report it to. The absence of output is
  // itself the correct answer: run the Read.
}

// Total by construction and off unless an operator names a file — see the module header. Outside
// the try for the same reason exit 0 is: a throw must not skip it.
writeExitDiagnostic(process.env.CLAUDE_ROUTER_EXIT_DIAGNOSTIC, { wroteResponse })

// exitCode, NOT process.exit(0). Measured on Windows / Node 24: calling process.exit() while
// undici is still tearing down the TLS socket of a just-finished fetch aborts the process natively
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c") with exit
// 3221226505 and that text on stderr — 5 of 5 runs in a minimal repro, and 3 of 3 live hook runs
// against Gemini. Letting the loop drain instead exited 0 in 5 of 5, and drained in 1–11 ms.
process.exitCode = 0
// The backstop: if some handle ever keeps the loop alive, do not hold the developer's Read
// hostage to it. unref'd, so it never delays a clean drain by itself.
setTimeout(() => process.exit(0), 2000).unref()
