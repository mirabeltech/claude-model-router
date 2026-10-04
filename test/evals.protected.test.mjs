/**
 * THE NEGATIVE EVAL, as a cross-product.
 *
 * CLAUDE.md's sixth non-negotiable says changing a threshold or a glob default requires a negative
 * eval proving the system still refuses to delegate reasoning work. `routing.exclusions.test.mjs`
 * discharges that for ONE baseline input. This file discharges it for EVERY INPUT IN THE CORPUS —
 * every size, every shape, every path set, every config override, including the inputs that DO
 * delegate — crossed with every task type outside the allowlist.
 *
 * Starting from inputs that delegate is what makes it falsifiable. A case that already refuses on
 * size would pass trivially and prove nothing, so the valuable rows are the nine that otherwise
 * delegate: they assert that no content shape, no payload size and no path set can rescue a
 * protected task type.
 *
 * WHY THIS IS NOT A THIRD COPY OF THE EXCLUSIONS TEST. That file flips one field on one synthetic
 * baseline. This one asserts a property of the gate across the whole corpus, and it is the file
 * that will fail the day someone adds a classifier.
 *
 * WHICH BRINGS US TO THE PART THAT CHANGED IN PHASE 7, recorded here because it belongs next to
 * the assertions rather than in a commit message.
 *
 * This file used to say the guarantee was VACUOUS, AND SAFE BECAUSE IT WAS VACUOUS: nothing could
 * be misclassified because nothing was classified, so the cross-product above proved a property
 * of a gate that was never asked a hard question. It also said that the moment anyone added a
 * transcript heuristic the guarantee would stop being automatically safe in the same commit.
 *
 * Phase 7 is that commit. The hook now reads the developer's newest prompt out of the session
 * transcript — when, and only when, `hooks.taskIntent.source` says to — and hands it to the
 * worker. Prompt text exists inside the hook, so "could that text change a routing decision" is
 * a real question for the first time.
 *
 *   THE GUARANTEE IS NARROWER NOW, AND IT IS NO LONGER VACUOUS.
 *
 * What is still true, and is what the assertions below enforce:
 *
 *   - `hook/adapter.mjs` still assigns `taskType` as a LITERAL. Nothing is classified; the
 *     recovered prompt is never consulted to decide what kind of work this is.
 *   - `decide()`'s input has no field that could carry intent, and still gets none.
 *   - Intent is extracted strictly AFTER the gate has ruled. That ordering is the enforcement,
 *     and it is pinned, because an argument about care is not an argument about structure.
 *   - The only tool intercepted is still `Read`.
 *
 * So intent reaches the task builder and nothing else. A developer who asks Claude to debug
 * something may now have that sentence forwarded to a worker as the question about a file — which
 * is the feature — but it cannot make the router treat debugging as delegatable work.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { decide } from '../plugins/model-router/lib/routing.mjs'
import { BULK_READ_TASK } from '../plugins/model-router/lib/hook/adapter.mjs'
import { INTENT_PROMPT_VERSION, MODES, PROMPT_VERSION } from '../plugins/model-router/lib/dispatch/modes.mjs'
import { buildWorkerTask } from '../plugins/model-router/lib/dispatch/task.mjs'
import {
  DELEGATABLE_TASK_TYPES,
  ROUTING_TASK_TYPES,
} from '../plugins/model-router/lib/routing-policy.mjs'
import { evalConfig } from './evals/config.mjs'
import { loadCorpus, REPO_ROOT } from './evals/load.mjs'
import { PROTECTED_TASK_TYPES } from './evals/gates.mjs'
import { toRoutingInputForCase } from './evals/routing.mjs'

let scratch
let corpus

test.before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-protected-'))
  corpus = loadCorpus({ scratchDir: scratch })
  assert.deepEqual(corpus.errors, [], 'the corpus must load before it can be crossed')
})

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

/* ------------------------------------------------------------- the cross-product */

test('no corpus input, at any size or shape, lets a protected task type delegate', () => {
  const delegated = []
  let assertions = 0

  for (const caseDef of corpus.cases) {
    const config = evalConfig(caseDef.config ?? {}, { projectDir: scratch })
    const input = toRoutingInputForCase({
      caseDef,
      absPaths: corpus.absPaths.get(caseDef.id),
      projectDir: scratch,
    })
    for (const taskType of PROTECTED_TASK_TYPES) {
      const d = decide({ ...input, taskType }, config)
      assertions += 1
      if (d.delegate !== false) delegated.push(`${caseDef.id} + ${taskType} -> ${d.reason}`)
    }
  }

  assert.deepEqual(delegated, [], `\n  ${delegated.join('\n  ')}`)
  assert.equal(
    assertions,
    corpus.cases.length * PROTECTED_TASK_TYPES.length,
    'every case must be crossed with every protected type',
  )
})

test('the cross-product includes inputs that DO delegate, or it proves nothing', () => {
  // The guard on the guard. If every corpus input refused for some other reason, the test above
  // would be vacuous — so this asserts the baseline it starts from is genuinely permissive.
  const config = evalConfig({}, { projectDir: scratch })
  const delegating = corpus.cases.filter((caseDef) => {
    const input = toRoutingInputForCase({
      caseDef,
      absPaths: corpus.absPaths.get(caseDef.id),
      projectDir: scratch,
    })
    return decide(input, evalConfig(caseDef.config ?? {}, { projectDir: scratch })).delegate === true
  })
  assert.ok(
    delegating.length >= 3,
    `only ${delegating.length} corpus inputs delegate as bulk_read; the cross-product needs permissive baselines`,
  )
  assert.ok(config.enabled, 'the eval config must have routing enabled')
})

test('each protected task type is refused on at least one otherwise-delegating input', () => {
  // Per-type, so a single type silently becoming delegatable cannot hide inside an aggregate.
  for (const taskType of PROTECTED_TASK_TYPES) {
    let provedOnAPermissiveInput = false
    for (const caseDef of corpus.cases) {
      const config = evalConfig(caseDef.config ?? {}, { projectDir: scratch })
      const input = toRoutingInputForCase({
        caseDef,
        absPaths: corpus.absPaths.get(caseDef.id),
        projectDir: scratch,
      })
      if (decide(input, config).delegate !== true) continue
      const d = decide({ ...input, taskType }, config)
      assert.equal(d.delegate, false, `${taskType} delegated on ${caseDef.id} (${d.reason})`)
      provedOnAPermissiveInput = true
    }
    assert.ok(provedOnAPermissiveInput, `${taskType} was never tested against a delegating input`)
  }
})

test('the allowlist is still exactly two members, so the cross-product cannot be hollowed out', () => {
  // Widening DELEGATABLE_TASK_TYPES would shrink PROTECTED_TASK_TYPES and quietly reduce the
  // cross-product to nothing. That change must break this test, not pass it.
  assert.deepEqual([...DELEGATABLE_TASK_TYPES], ['bulk_read', 'code_write'])
  assert.equal(
    PROTECTED_TASK_TYPES.length,
    ROUTING_TASK_TYPES.length - 2,
    'every non-delegatable task type must be in the protected set',
  )
  for (const want of ['debugging', 'architecture', 'security', 'precise_edit', 'general', 'unknown']) {
    assert.ok(PROTECTED_TASK_TYPES.includes(want), `${want} must be protected`)
  }
})

test('the two refusal codes for a protected type are distinct and both hold', () => {
  // `unknown` refuses one rule EARLIER than the rest: normalizeInput folds an unrecognised value to
  // `unknown`, which rule 2a owns, while a recognised-but-undelegatable type reaches rule 2b. The
  // corpus has a case for each, and conflating the codes would lose the distinction.
  const caseDef = corpus.cases.find((c) => c.expected.class === 'delegate' && c.harness === 'decide')
  const config = evalConfig(caseDef.config ?? {}, { projectDir: scratch })
  const input = toRoutingInputForCase({
    caseDef,
    absPaths: corpus.absPaths.get(caseDef.id),
    projectDir: scratch,
  })

  assert.equal(decide({ ...input, taskType: 'debugging' }, config).reason, 'task_type_excluded')
  assert.equal(decide({ ...input, taskType: 'unknown' }, config).reason, 'unknown_input')
  assert.equal(decide({ ...input, taskType: 'architecure' }, config).reason, 'unknown_input')
})

/* ------------------------------------------- the absence of a classifier, pinned */

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, 'plugins', 'model-router', rel), 'utf8')

test('the hook still emits a literal bulk_read, so nothing is classified', () => {
  // The moment this becomes a computed value, the protected-category guarantee stops being vacuous
  // and this test is the notice. Pinned as a literal because a regex over a computed expression
  // would pass for a classifier that happens to return 'bulk_read' sometimes.
  const adapter = read('lib/hook/adapter.mjs')
  assert.match(
    adapter,
    /taskType:\s*'bulk_read',/,
    'hook/adapter.mjs must assign taskType as a literal; a computed value means a classifier exists',
  )
  for (const protectedType of ['debugging', 'architecture', 'precise_edit']) {
    assert.equal(
      adapter.includes(`'${protectedType}'`),
      false,
      `adapter.mjs mentions ${protectedType}; if it now classifies, this file's guarantee needs rewriting`,
    )
  }
})

test('no module outside the policy carries a protected task type as a routing input', () => {
  // routing-policy.mjs declares the vocabulary and routing.mjs validates against it. Anywhere else
  // naming one of these strings is either a classifier or a second copy of the enum.
  const ALLOWED = new Set(['lib/routing-policy.mjs', 'lib/routing.mjs'])
  const SCANNED = Object.freeze([
    'lib/hook/adapter.mjs',
    'lib/hook/event.mjs',
    'lib/hook/facts.mjs',
    'lib/hook/intent.mjs',
    'lib/hook/run.mjs',
    'lib/dispatch/index.mjs',
    'lib/dispatch/modes.mjs',
    'lib/dispatch/contract.mjs',
    'lib/dispatch/task.mjs',
  ])
  for (const rel of SCANNED) {
    if (ALLOWED.has(rel)) continue
    const source = read(rel)
    for (const protectedType of ['debugging', 'architecture', 'precise_edit']) {
      assert.equal(
        new RegExp(`['"]${protectedType}['"]`).test(source),
        false,
        `${rel} names the protected task type ${protectedType}`,
      )
    }
  }
})

test('the hook still intercepts exactly one tool, so the gated surface is what the corpus covers', () => {
  const adapter = read('lib/hook/adapter.mjs')
  assert.match(adapter, /INTERCEPTED_TOOL = 'Read'/, 'adapter.mjs must still intercept Read only')

  const hooks = JSON.parse(read('hooks/hooks.json'))
  const matchers = JSON.stringify(hooks)
  assert.ok(matchers.includes('Read'), 'hooks.json must register the Read matcher')
  for (const writeTool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(
      matchers.includes(`"${writeTool}"`),
      false,
      `hooks.json registers ${writeTool}; the corpus covers reads only and would need extending`,
    )
  }
})

test('the hook still sends one file, so no corpus case may claim a multi-file read', () => {
  // Pins the fact that makes `multi_file_read` unreachable through the hook.
  const run = read('lib/hook/run.mjs')
  assert.match(run, /files:\s*\[\{/, 'run.mjs must send a single-element files array')
})

test('with no intent the builder is an identity, so the default request is unchanged', () => {
  // THIS REPLACED A SOURCE REGEX, and the replacement is the point. The old assertion grepped
  // run.mjs for `task: BULK_READ_TASK`, which a reformat defeats and which says nothing about
  // what the worker actually receives. This asserts the property instead: with no intent, the
  // task builder returns exactly the two keys the hook has always sent, and the bulk-reader
  // renders exactly the bytes it has always rendered.
  //
  // The literal below is a CAPTURED SNAPSHOT, not a reconstruction. Rebuilding the expectation
  // from the same template that produces it would pass for any change made to both at once.
  //
  // RE-CAPTURED at PROMPT_VERSION 5, when the body gained `NNNN | ` line prefixes. The property
  // under test — no intent means no extra section and no changed keys — is untouched.
  const files = [{ path: 'p.ts', content: 'const x = 1' }]
  const input = buildWorkerTask({
    toolContext: { baseTask: BULK_READ_TASK, lane: 'bulkRead' },
    files,
    taskIntent: null,
  })

  assert.deepEqual(input, { task: BULK_READ_TASK, files })
  assert.deepEqual(Object.keys(input), ['task', 'files'], 'no empty section may ride along')

  const built = MODES['bulk-reader'].build(input)
  assert.equal(
    built.prompt,
    [
      '# Task',
      '',
      'Summarise this file for an engineer who has not seen it. Cover its purpose, its structure,' +
        ' and every significant declaration with the line it is on. Preserve identifiers,' +
        ' signatures and string literals exactly as written; never paraphrase a name. State what' +
        ' the file does not do where that is load-bearing.',
      '',
      '# Files (1)',
      '',
      '<<<<<<<<<< FILE p.ts',
      '1 | const x = 1',
      '>>>>>>>>>> END FILE p.ts',
      '',
    ].join('\n'),
  )
  // The property is "a generic request reports the GENERIC version", not "it reports 1". The
  // literal 1 was correct until the shared system prompt changed in phase 8, which moved both
  // counters (1 -> 3 and 2 -> 4); pinning the digit would have made a legitimate prompt revision
  // indistinguishable from an accidental one. The snapshot above still pins the BYTES, which is
  // the part that must not drift, and the system prompt is not part of the generic request's
  // identity assertion because the builder does not construct it.
  assert.equal(built.promptVersion, PROMPT_VERSION)
  assert.notEqual(
    built.promptVersion,
    INTENT_PROMPT_VERSION,
    'a generic request must never be stamped with the intent version, or a reader would subtract one token count from the other',
  )
})

test('intent is recovered only after the gate has ruled, which is why it cannot reach routing', () => {
  // THE ONE GENUINELY NEW PROPERTY THIS PHASE NEEDS PINNED.
  //
  // Everything else in this file asserts that the gate refuses protected work. That guarantee
  // used to be vacuous. It is not any more, because prompt text now exists inside the hook — so
  // the question "could that text change a routing decision" is a real one, and the answer has to
  // be structural rather than careful.
  //
  // It is structural because of ORDER. `decide()` returns before any intent is extracted, so
  // there is no interleaving in which intent is in scope while the decision is being made. A
  // source-order check is the right instrument here precisely because the property IS the order.
  const run = read('lib/hook/run.mjs')
  const gate = run.indexOf('decideImpl(')
  const extract = run.indexOf('extractTaskIntent(')
  assert.ok(gate > 0, 'run.mjs must still call the gate')
  assert.ok(extract > 0, 'run.mjs must call the extractor by name, not through an alias')
  assert.ok(gate < extract, 'intent must be extracted AFTER the decision, never before or beside it')

  // And the extractor is never handed the routing input, nor the routing input the extractor's
  // output, which is the other half of the same claim.
  assert.equal(
    /toRoutingInput\([^)]*[Ii]ntent/.test(run),
    false,
    'toRoutingInput must not be passed anything intent-shaped',
  )
})
