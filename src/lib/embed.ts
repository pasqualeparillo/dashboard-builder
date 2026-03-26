import type { SavedDashboardLayout } from '@/lib/types'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined

interface EmbedTokenResponse {
  slug: string
  expires_at: string
  token: string
  embed_url: string
  iframe_html: string
}

interface EmbedDashboardResponse {
  dashboard: SavedDashboardLayout
}

export async function createEmbedToken(slug: string, ttlSeconds = 3600): Promise<EmbedTokenResponse> {
  const response = await fetch(`${apiBaseUrl ?? ''}/api/embed-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ slug, ttl_seconds: ttlSeconds }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Failed to create embed token (${response.status})`)
  }

  return (await response.json()) as EmbedTokenResponse
}

export async function fetchEmbedDashboard(slug: string, token: string): Promise<SavedDashboardLayout> {
  const response = await fetch(
    `${apiBaseUrl ?? ''}/api/embed-dashboard/${encodeURIComponent(slug)}?token=${encodeURIComponent(token)}`,
  )

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Failed to load embedded dashboard (${response.status})`)
  }

  const data = (await response.json()) as EmbedDashboardResponse
  return data.dashboard
}
