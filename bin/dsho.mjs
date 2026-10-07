#!/usr/bin/env node
// dsho / dsh-orchestra entry point.
import { main } from '../src/cli.mjs'

const code = await main(process.argv.slice(2))
process.exitCode = code ?? 0
