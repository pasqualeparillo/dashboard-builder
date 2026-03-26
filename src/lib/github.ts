import { Octokit } from 'octokit'

import { parseDashboardYaml, toDashboardYaml } from '@/lib/dashboard-spec'
import type { SavedDashboardLayout } from '@/lib/types'

const owner = import.meta.env.VITE_GITHUB_OWNER as string | undefined
const repo = import.meta.env.VITE_GITHUB_REPO as string | undefined
const token = import.meta.env.VITE_GITHUB_TOKEN as string | undefined
const branch = (import.meta.env.VITE_GITHUB_BRANCH as string | undefined) ?? 'main'

function getOctokit() {
  if (!token) {
    throw new Error('Missing VITE_GITHUB_TOKEN')
  }

  return new Octokit({ auth: token })
}

function assertRepoConfig() {
  if (!owner || !repo) {
    throw new Error('Missing VITE_GITHUB_OWNER or VITE_GITHUB_REPO')
  }

  return { owner, repo }
}

function toBase64(content: string) {
  return btoa(unescape(encodeURIComponent(content)))
}

function fromBase64(content: string) {
  return decodeURIComponent(escape(atob(content)))
}

export async function saveDashboardLayout(layout: SavedDashboardLayout) {
  const { owner: repoOwner, repo: repoName } = assertRepoConfig()
  const octokit = getOctokit()
  const path = `dashboards/${layout.slug}/dashboard.yaml`
  const serialized = toDashboardYaml(layout)

  let sha: string | undefined

  try {
    const current = await octokit.rest.repos.getContent({
      owner: repoOwner,
      repo: repoName,
      path,
      ref: branch,
    })

    if (!Array.isArray(current.data) && 'sha' in current.data) {
      sha = current.data.sha
    }
  } catch (error) {
    const maybeStatus = error as { status?: number }
    if (maybeStatus.status !== 404) {
      throw error
    }
  }

  const response = await octokit.rest.repos.createOrUpdateFileContents({
    owner: repoOwner,
    repo: repoName,
    path,
    message: `Save dashboard spec ${layout.slug}`,
    content: toBase64(serialized),
    sha,
    branch,
  })

  return {
    path,
    commitSha: response.data.commit.sha,
  }
}

export async function deleteDashboardLayout(slug: string) {
  const { owner: repoOwner, repo: repoName } = assertRepoConfig()
  const octokit = getOctokit()
  const path = `dashboards/${slug}/dashboard.yaml`

  let sha: string | undefined

  try {
    const current = await octokit.rest.repos.getContent({
      owner: repoOwner,
      repo: repoName,
      path,
      ref: branch,
    })

    if (!Array.isArray(current.data) && 'sha' in current.data) {
      sha = current.data.sha
    }
  } catch (error) {
    const maybeStatus = error as { status?: number }
    if (maybeStatus.status === 404) {
      return
    }
    throw error
  }

  if (!sha) {
    return
  }

  await octokit.rest.repos.deleteFile({
    owner: repoOwner,
    repo: repoName,
    path,
    message: `Delete dashboard spec ${slug}`,
    sha,
    branch,
  })
}

export async function listDashboardLayoutsFromGithub(): Promise<SavedDashboardLayout[]> {
  const { owner: repoOwner, repo: repoName } = assertRepoConfig()
  const octokit = getOctokit()

  let entries:
    | Array<{
        type?: string
        path?: string
      }>
    | null = null

  try {
    const response = await octokit.rest.repos.getContent({
      owner: repoOwner,
      repo: repoName,
      path: 'dashboards',
      ref: branch,
    })

    if (Array.isArray(response.data)) {
      entries = response.data.map((entry) => ({
        type: entry.type,
        path: entry.path,
      }))
    }
  } catch (error) {
    const maybeStatus = error as { status?: number }
    if (maybeStatus.status === 404) {
      return []
    }
    throw error
  }

  if (!entries) {
    return []
  }

  const yamlPaths = entries
    .filter((entry) => entry.type === 'dir' && typeof entry.path === 'string')
    .map((entry) => `${entry.path}/dashboard.yaml`)

  const fetched = await Promise.all(
    yamlPaths.map(async (path) => {
      try {
        const response = await octokit.rest.repos.getContent({
          owner: repoOwner,
          repo: repoName,
          path,
          ref: branch,
        })

        if (Array.isArray(response.data) || !('content' in response.data)) {
          return null
        }

        const decoded = fromBase64(response.data.content.replace(/\n/g, ''))
        return parseDashboardYaml(decoded)
      } catch {
        return null
      }
    }),
  )

  return fetched.filter((entry): entry is SavedDashboardLayout => entry !== null)
}
