/**
 * Pre-flight check for GitHub repositories, run on the delegating machine
 * before a cloud session is created: the platform mounts repositories
 * silently, so a private repository without a usable token would otherwise
 * surface only as a missing directory inside the sandbox.
 *
 * @module dsh-qoder-cloud-agents/github
 */

/** Outcome of the pre-flight check. */
export interface GitHubAccess {
  /** Fatal: the session would not be able to mount the repository. */
  readonly error?: string
  /** Non-fatal notes for the run result. */
  readonly warnings: readonly string[]
}

/**
 * Parse `https://github.com/<owner>/<repo>(.git)`.
 * @returns owner and repo, or `undefined` for other URLs.
 */
export function githubSlug(url: string): { owner: string; repo: string } | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') return undefined
  const [owner, repo] = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/')
  return owner && repo ? { owner, repo } : undefined
}

/**
 * Ask the GitHub API whether the repository is reachable with `token` and
 * whether it can be pushed to. Network failures are not fatal: the check is
 * advisory and the platform has the final word.
 * @param url - HTTPS clone URL.
 * @param token - git token handed to the sandbox, if any.
 * @param tokenEnv - credential name, for messages.
 * @param signal - cancellation.
 * @param fetchImpl - injected for tests.
 */
export async function checkGitHubAccess(
  url: string,
  token: string | undefined,
  tokenEnv: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubAccess> {
  const slug = githubSlug(url)
  if (slug === undefined) return { warnings: [] }
  let response: Response
  try {
    response = await fetchImpl(`https://api.github.com/repos/${slug.owner}/${slug.repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-qoder-cloud-agents',
        ...token === undefined ? {} : { Authorization: `Bearer ${token}` },
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
  } catch {
    if (signal.aborted) throw signal.reason
    return { warnings: ['could not reach api.github.com to check repository access; continuing.'] }
  }
  if (response.status === 401) {
    return { error: `the GitHub token in ${tokenEnv} was rejected (401); fix or remove it`, warnings: [] }
  }
  if (response.status === 404) {
    return {
      error: token === undefined
        ? `${slug.owner}/${slug.repo} is private or does not exist; set ${tokenEnv} to a GitHub token with access to it`
        : `the GitHub token in ${tokenEnv} cannot see ${slug.owner}/${slug.repo} (404); grant it access to this repository`,
      warnings: [],
    }
  }
  if (!response.ok) {
    return { warnings: [`GitHub repository check returned HTTP ${response.status}; continuing.`] }
  }
  const body = await response.json().catch(() => ({})) as { permissions?: { push?: boolean } }
  if (token === undefined) {
    return { warnings: [`no ${tokenEnv} is set: the cloud agent can read this public repository but cannot push its branch.`] }
  }
  if (body.permissions?.push === false) {
    return { warnings: [`the token in ${tokenEnv} has no push access to ${slug.owner}/${slug.repo}: the cloud agent cannot push its branch.`] }
  }
  return { warnings: [] }
}
