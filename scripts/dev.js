#!/usr/bin/env node
'use strict'

const concurrently = require('concurrently')

const demo = process.argv.includes('--demo')
process.env.NEXT_PUBLIC_DEMO = demo ? '1' : '0'
process.env.NEXT_PUBLIC_RELAY_PORT = '3001'

const commands = demo
  ? [{ command: 'pnpm run dev:web', name: 'web' }]
  : [{ command: 'pnpm run dev:relay', name: 'relay' }, { command: 'pnpm run dev:web', name: 'web' }]
concurrently(commands, { prefixColors: ['blue', 'green'], killOthersOn: ['failure'] }).result
  .catch(() => { process.exitCode = 1 })
