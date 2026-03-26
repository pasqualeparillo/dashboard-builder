import { useEffect, useState } from 'react'

import { fetchMetrics, type MetricRow } from '@/lib/metrics'

interface MetricQueryState {
  data: MetricRow[]
  loading: boolean
  error: string | null
}

export function useMetricQuery(sql: string, refreshMs: number) {
  const [state, setState] = useState<MetricQueryState>({
    data: [],
    loading: true,
    error: null,
  })

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (!sql.trim()) {
        if (!cancelled) {
          setState({ data: [], loading: false, error: 'No dataset query selected' })
        }
        return
      }

      try {
        setState((previous) => ({ ...previous, loading: true, error: null }))
        const rows = await fetchMetrics(sql)
        if (!cancelled) {
          setState({ data: rows, loading: false, error: null })
        }
      } catch (error) {
        if (!cancelled) {
          setState((previous) => ({
            data: previous.data,
            loading: false,
            error: error instanceof Error ? error.message : 'Unknown query error',
          }))
        }
      }
    }

    run()

    const poller = window.setInterval(run, refreshMs)

    return () => {
      cancelled = true
      window.clearInterval(poller)
    }
  }, [sql, refreshMs])

  return state
}
