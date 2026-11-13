import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let prepared

async function prepare() {
  // Fixed product build gates only. No lab probe, model call, auth.json or vendor adapter is loaded.
  for (const script of ['kernel:build', 'build']) {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script, '--silent'],
      { cwd: root, stdio: 'pipe', shell: false, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
  }
  const [fixture, auth, application, store, admission, server] = await Promise.all([
    import('../dist/test/fixtures.js'), import('../dist/src/web/auth.js'),
    import('../dist/src/web/application.js'), import('../dist/src/review-store.js'),
    import('../dist/src/admission.js'), import('../dist/src/web/server.js'),
  ])
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false }).trim()
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw Error('fde-demo-source-revision-unavailable')
  const hash = createHash('sha256')
  async function sourceTree(directory) {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(directory, entry.name)
      if (entry.isDirectory()) await sourceTree(relative)
      else if (entry.isFile()) hash.update(relative).update('\0').update(await readFile(join(root, relative))).update('\0')
      else throw Error('fde-demo-source-symlink-refused')
    }
  }
  for (const directory of ['src', 'web', 'demo', 'test']) await sourceTree(directory)
  hash.update(await readFile(join(root, 'package-lock.json')))
  return { ...fixture, ...auth, ...application, ...store, ...admission, ...server,
    sourceRevision, sourceTreeSha256: hash.digest('hex') }
}

export async function startBrowserDemo({ variant }) {
  prepared ??= prepare()
  const p = await prepared
  const directory = await mkdtemp(join(tmpdir(), 'fde-browser-demo-'))
  let store, server
  try {
    // These short-lived identities exist only in this new process and store.
    const password = randomBytes(32).toString('base64url')
    const users = await Promise.all(['reviewer', 'viewer'].map(role => p.makeAuthUser(`demo-${role}`, role, password)))
    const auth = p.admitAuthConfig({ schema: 'fde.lab-auth/v1', users })
    const now = Date.now()
    const input = p.synthetic()
    for (const source of [input.erp, input.mes]) source.capture.observedAt = new Date(now).toISOString()
    const kernelSha256 = p.kernelFingerprint()
    // This is a fixture registration for the real admission/store API, not a packaged release attestation.
    const release = {
      schema: 'fde.release/v1', releaseId: 'fde-' + createHash('sha256').update(p.sourceTreeSha256 + kernelSha256).digest('hex').slice(0, 16),
      sourceRevision: p.sourceRevision, sourceTreeSha256: p.sourceTreeSha256, kernelSha256,
      nodeVersion: process.version, builtAt: new Date(now).toISOString(), configurationSchema: 'fde.private-lab/v1', files: {},
    }
    store = new p.ReviewStore(join(directory, 'reviews.sqlite'), () => now)
    let sourceAvailable = true
    server = p.createApplicationServer({ auth, store, release, now: () => now,
      source: async () => { if (!sourceAvailable) throw Error('synthetic-source-unavailable'); return structuredClone(input) } })
    const port = await p.listenLocal(server, 0)
    const url = `http://127.0.0.1:${port}/`
    return {
      url,
      fixture: 'handwritten product fixture; real compiled semantics and disposable human-review store; no vendor reads',
      // Network traces can contain authentication metadata. Keep them disabled for this scenario.
      trace: false,
      contextOptions: { httpCredentials: { username: `demo-${variant.role}`, password, origin: new URL(url).origin } },
      refuseSource() { sourceAvailable = false },
      async close() {
        server.closeAllConnections()
        try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
        finally {
          try { store.close() }
          finally { await rm(directory, { recursive: true, force: true }) }
        }
      },
    }
  } catch (error) {
    server?.closeAllConnections()
    server?.close()
    store?.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
