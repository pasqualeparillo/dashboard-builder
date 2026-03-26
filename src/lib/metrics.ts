export type MetricRow = Record<string, string | number | null>

interface MetricQueryResponse {
  rows: MetricRow[]
  columns?: Array<{ name: string; type: string }>
  mode?: 'mock' | 'live'
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined

export async function fetchMetrics(sql: string): Promise<MetricRow[]> {
  const response = await fetch(`${apiBaseUrl ?? ''}/api/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Metric query failed (${response.status})`)
  }

  const data = (await response.json()) as MetricQueryResponse
  return data.rows
}

export async function validateDatasetSql(sql: string) {
  const response = await fetch(`${apiBaseUrl ?? ''}/api/validate-query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Validation failed (${response.status})`)
  }

  return (await response.json()) as {
    valid: boolean
    message: string
    columns: Array<{ name: string; type: string }>
  }
}
