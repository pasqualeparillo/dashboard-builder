import { Octokit } from 'octokit'

import { toDashboardYaml } from '@/lib/dashboard-spec'
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

  await octokit.rest.repos.createOrUpdateFileContents({
    owner: repoOwner,
    repo: repoName,
    path,
    message: `Save dashboard spec ${layout.slug}`,
    content: toBase64(serialized),
    sha,
    branch,
  })

  return path
}
