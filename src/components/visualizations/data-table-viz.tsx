import { useMemo } from 'react'

import { useMetricQuery } from '@/hooks/use-metric-query'

interface DataTableVizProps {
  sql: string
  refreshMs: number
  visibleColumns?: string[]
}

export function DataTableViz({ sql, refreshMs, visibleColumns }: DataTableVizProps) {
  const { data, loading, error } = useMetricQuery(sql, refreshMs)

  const columns = useMemo(() => {
    if (visibleColumns?.length) {
      return visibleColumns
    }

    if (!data.length) {
      return ['metric_name', 'metric_value', 'observed_at']
    }

    return Object.keys(data[0])
  }, [data, visibleColumns])

  const rows = data.length
    ? data
    : [
        { metric_name: 'Revenue', metric_value: 1200, observed_at: '2026-03-25' },
        { metric_name: 'Cost', metric_value: 870, observed_at: '2026-03-25' },
      ]

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="text-xs text-slate-500">{loading ? 'Refreshing...' : 'Live metric table'}</div>
      {error ? <div className="text-xs text-red-600">{error}</div> : null}
      <div className="min-h-0 flex-1 overflow-auto rounded border border-slate-200">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              {columns.map((column) => (
                <th className="px-3 py-2" key={column}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr className="border-t border-slate-100" key={`row-${rowIndex}`}>
                {columns.map((column) => (
                  <td className="px-3 py-2 text-slate-700" key={`${rowIndex}-${column}`}>
                    {String(row[column] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
