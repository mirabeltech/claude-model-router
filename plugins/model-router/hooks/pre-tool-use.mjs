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
import { runReadHook } from '../lib/hook/run.mjs'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

try {
  const raw = await readStdin()
  const { config } = loadConfig()
  const { response } = await runReadHook({ raw, config })

  if (response !== null) {
    // writeSync, not process.stdout.write: on a pipe, stdout can be asynchronous, and a buffered
    // write racing process exit is how a response arrives truncated. The telemetry sink uses the
    // same discipline for the same reason.
    fs.writeSync(1, JSON.stringify(response))
  }
} catch {
  // Nothing is reported, because there is nobody safe to report it to. The absence of output is
  // itself the correct answer: run the Read.
}

process.exit(0)
