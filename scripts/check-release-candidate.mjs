import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SITE_REPOSITORY, SITE_URL, verifyLocalCandidate, verifyServedCandidate } from './release-core.mjs'

const { values } = parseArgs({ options: { served: { type: 'boolean' }, 'site-commit': { type: 'string' } } })
const candidate = await verifyLocalCandidate(fileURLToPath(new URL('../dist-firebase/', import.meta.url)))
let result = { version: candidate.release.version, sourceCommit: candidate.release.sourceCommit,
  artifactSha256: candidate.sha256, filesVerified: Object.keys(candidate.files).length, localArtifact: 'exact match' }
if (values.served) {
  const siteCommit = values['site-commit']
  assert(typeof siteCommit === 'string' && /^[a-f0-9]{40}$/.test(siteCommit), '--served requires a full --site-commit')
  const remoteCommit = () => execFileSync('git', ['ls-remote', `https://github.com/${SITE_REPOSITORY}.git`,
    'refs/heads/gh-pages'], { encoding: 'utf8', timeout: 30000 }).trim().split(/\s/)[0]
  assert.equal(remoteCommit(), siteCommit, 'public site branch differs from the reviewed publication')
  const fetched = await verifyServedCandidate(candidate, async (name) => {
    const response = await fetch(new URL(name, SITE_URL), { redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(20000) })
    assert(response.ok, `served file unavailable: ${name}`)
    const data = Buffer.from(await response.arrayBuffer())
    assert(data.length <= 8 * 1024 * 1024, 'served file exceeds artifact limit')
    return data
  })
  assert.equal(remoteCommit(), siteCommit, 'public site advanced during verification')
  result = { ...result, ...fetched, siteCommit, siteUrl: SITE_URL, servedArtifact: 'exact match' }
} else assert(!values['site-commit'], '--site-commit requires --served')
console.log(JSON.stringify(result, null, 2))
