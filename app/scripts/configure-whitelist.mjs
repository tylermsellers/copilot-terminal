#!/usr/bin/env node
// Copilot Terminal is a self-pack app: Even Hub's network permission
// whitelist only accepts exact origins (no wildcards, no bare hostnames —
// see https://hub.evenrealities.com/docs/build/networking), and every
// user's relay server runs on their own LAN at a different address. That
// means there is no single .ehpk that can work for everyone out of the box
// — each user (or fork) must bake their OWN relay origin into their OWN
// app.json before running `evenhub pack`.
//
// This script does that: it auto-detects your machine's LAN IPv4 address,
// lets you confirm/override it and the relay port, and rewrites app.json's
// `network` permission whitelist in place.
import { networkInterfaces } from 'node:os'
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appJsonPath = join(__dirname, '..', 'app.json')

function detectLanIPv4() {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return null
}

function ask(rl, question, fallback) {
  return new Promise((resolve) => {
    rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `, (answer) => {
      resolve(answer.trim() || fallback || '')
    })
  })
}

async function main() {
  const detected = detectLanIPv4()
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('Copilot Terminal — configure your relay whitelist')
  console.log('This writes YOUR relay address into app.json before packing.')
  console.log('It only affects your own build; it is not shared with anyone else.\n')

  const ip = await ask(rl, 'LAN IP of the machine running the relay server', detected ?? undefined)
  const port = await ask(rl, 'Relay port', '4756')
  rl.close()

  if (!ip) {
    console.error('\nNo IP provided — aborting. Run again and enter your LAN IP.')
    process.exit(1)
  }

  const origin = `http://${ip}:${port}`
  const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'))
  const networkPerm = appJson.permissions?.find((p) => p.name === 'network')
  if (!networkPerm) {
    console.error("\napp.json has no 'network' permission entry to update — check it manually.")
    process.exit(1)
  }
  networkPerm.whitelist = [origin]
  writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n')

  console.log(`\napp.json whitelist set to: ${origin}`)
  console.log('Next steps:')
  console.log('  1. npm run build')
  console.log('  2. npx evenhub pack app.json dist -o copilot-terminal.ehpk')
  console.log('  3. Sideload the .ehpk as a Private Build (see README.md)')
  console.log(`  4. In the app's phone settings screen, set the relay URL to: ${origin}`)
}

main()
