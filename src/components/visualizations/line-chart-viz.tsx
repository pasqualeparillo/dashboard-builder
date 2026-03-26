import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { useMetricQuery } from '@/hooks/use-metric-query'

interface LineChartVizProps {
  sql: string
  refreshMs: number
  xField?: string
  yField?: string
}

export function LineChartViz({ sql, refreshMs, xField, yField }: LineChartVizProps) {
  const { data, loading, error } = useMetricQuery(sql, refreshMs)

  const xKey = xField?.trim() || 'label'
  const yKey = yField?.trim() || 'value'

  const chartData = data.map((row, index) => ({
    label: String(row[xKey] ?? row.label ?? row.metric_name ?? `Row ${index + 1}`),
    value: Number(row[yKey] ?? row.value ?? row.metric_value ?? 0),
  }))

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{loading ? 'Refreshing...' : 'Live metric data'}</span>
        {error ? <span className="text-red-600">Query failed</span> : null}
      </div>
      <div className="min-h-0 flex-1">
        {chartData.length === 0 ? (
          <div className="grid h-full animate-pulse gap-2 rounded border border-slate-200 bg-slate-50 p-3">
            <div className="h-4 w-40 rounded bg-slate-200" />
            <div className="h-full rounded bg-slate-200" />
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="value" stroke="#0f766e" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
