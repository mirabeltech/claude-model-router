/**
 * Prints what `os.homedir()` resolves to, and nothing else.
 *
 * Every "the developer's real ~/.claude is never touched" claim in this phase rests on an
 * assumption: that setting HOME and USERPROFILE in a constructed child environment actually
 * redirects `os.homedir()`. On Windows, Node has historically also consulted HOMEDRIVE+HOMEPATH,
 * so the assumption is platform-dependent and worth checking rather than believing.
 *
 * This turns it into a measured fact: a test spawns this and compares the output to the fake home.
 */
import os from 'node:os'

process.stdout.write(os.homedir())
