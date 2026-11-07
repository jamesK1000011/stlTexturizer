#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { main } from '../src/server.js'
main().catch((e) => { process.stderr.write(`[bumpmesh-mcp] ${e.stack || e}\n`); process.exit(1) })
