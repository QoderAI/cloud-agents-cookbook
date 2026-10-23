/**
 * Describe the delegating workspace's git checkout so the cloud sandbox can
 * mount the same repository. The cloud agent never sees local files: only
 * what is reachable on the remote (pushed commits) travels.
 *
 * @module dsh-qoder-cloud-agents/git
 */

import { execFile } from 'node:child_process'

export interface LocalRepository {
  /** HTTPS clone URL derived from `remote.origin.url` (no credentials). */
  readonly url: string
  /** `github.com` remotes map to the `github_repository` resource type. */
  readonly github: boolean
  /** Repository directory name. */
  readonly name: string
  /** Where the sandbox mounts it; the console's convention `/data/workspace/<name>`. */
  readonly mountPath: string
  /** Account name an `https://user@host/...` origin carries (never `git`), for authenticated non-GitHub clones. */
  readonly remoteUsername?: string
  /** Current branch, when HEAD is attached and the branch exists on origin. */
  readonly branch?: string
  /** HEAD commit. */
  readonly head: string
  /** Checkout to request: the pushed branch, else the HEAD commit. */
  readonly checkout: { type: 'branch'; name: string } | { type: 'commit'; sha: string }
  /** Local state the cloud agent cannot see. */
  readonly warnings: readonly string[]
}

type Git = (args: readonly string[]) => Promise<string | undefined>

function gitIn(cwd: string, signal?: AbortSignal): Git {
  return args => new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout: 10_000,
      ...signal === undefined ? {} : { signal },
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => {
      resolve(error === null ? stdout.trim() : undefined)
    })
  })
}

/**
 * Normalize a git remote to an HTTPS URL without embedded credentials.
 * Accepts `https://`, `ssh://git@host[:port]/path` and scp-like `git@host:path`.
 * @param remote - raw `remote.origin.url`.
 * @returns the HTTPS URL, or `undefined` for local/unsupported remotes.
 */
export function httpsRemote(remote: string): string | undefined {
  const trimmed = remote.trim()
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(trimmed)
  if (scp !== null) return `https://${scp[1]}/${scp[2]}`
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol === 'ssh:' || url.protocol === 'git+ssh:') {
    return `https://${url.hostname}${url.pathname}`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  url.username = ''
  url.password = ''
  return url.toString()
}

/** Mount root the Qoder console uses for repositories (environment-manager's code workspace). */
export const WORKSPACE_ROOT = '/data/workspace'

/**
 * The account name of an HTTP(S) remote such as `https://alice@code.example.com/g/r.git`.
 * SSH remotes (`git@…`) carry a transport user, not an account, so they yield nothing.
 */
export function httpsRemoteUsername(remote: string): string | undefined {
  let url: URL
  try {
    url = new URL(remote.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const username = decodeURIComponent(url.username)
  return username.length > 0 && username !== 'git' ? username : undefined
}

/**
 * Inspect `cwd` as a git checkout.
 * @param cwd - the delegating session's working directory.
 * @param signal - cancellation.
 * @returns the repository description, or `undefined` when `cwd` is not a
 *   checkout with a usable `origin` remote.
 */
export async function detectRepository(cwd: string, signal?: AbortSignal): Promise<LocalRepository | undefined> {
  const git = gitIn(cwd, signal)
  const top = await git(['rev-parse', '--show-toplevel'])
  if (top === undefined) return undefined
  const remote = await git(['config', '--get', 'remote.origin.url'])
  const url = remote === undefined ? undefined : httpsRemote(remote)
  const remoteUsername = remote === undefined ? undefined : httpsRemoteUsername(remote)
  const head = await git(['rev-parse', 'HEAD'])
  if (url === undefined || head === undefined) return undefined

  const warnings: string[] = []
  const branchName = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  let branch: string | undefined
  if (branchName !== undefined && branchName.length > 0) {
    const remoteHead = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchName}`])
    if (remoteHead !== undefined) {
      branch = branchName
      if (remoteHead !== head) {
        const ahead = await git(['rev-list', '--count', `refs/remotes/origin/${branchName}..HEAD`])
        if (ahead !== undefined && ahead !== '0') {
          warnings.push(`${ahead} local commit(s) on ${branchName} are not pushed to origin; the cloud agent works from origin/${branchName}.`)
        }
      }
    } else {
      warnings.push(`branch ${branchName} has no origin counterpart (last fetched state); the cloud agent starts from the default branch and fetches commit ${head.slice(0, 12)}, which must exist on origin.`)
    }
  }
  const dirty = await git(['status', '--porcelain', '--untracked-files=no'])
  if (dirty !== undefined && dirty.length > 0) {
    warnings.push('the local working tree has uncommitted changes that the cloud agent cannot see.')
  }

  const name = (url.replace(/\/+$/, '').split('/').pop() ?? 'repo').replace(/\.git$/, '') || 'repo'
  return {
    url,
    github: new URL(url).hostname.toLowerCase() === 'github.com',
    name,
    mountPath: `${WORKSPACE_ROOT}/${name}`,
    ...remoteUsername === undefined ? {} : { remoteUsername },
    ...branch === undefined ? {} : { branch },
    head,
    checkout: branch === undefined ? { type: 'commit', sha: head } : { type: 'branch', name: branch },
    warnings,
  }
}
