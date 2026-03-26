import { useMetricQuery } from '@/hooks/use-metric-query'

interface MetricGaugeVizProps {
  sql: string
  refreshMs: number
  valueField?: string
}

export function MetricGaugeViz({ sql, refreshMs, valueField }: MetricGaugeVizProps) {
  const { data, loading, error } = useMetricQuery(sql, refreshMs)
  const valueKey = valueField?.trim()
  const metricValue = Number(data[0]?.[valueKey ?? 'metric_value'] ?? data[0]?.value ?? 0)
  const capped = Math.max(0, Math.min(metricValue, 100))

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <div className="text-xs text-slate-500">{loading ? 'Refreshing...' : 'Current value'}</div>
      <div className="relative h-28 w-28 rounded-full border-8 border-slate-200">
        <div
          className="absolute inset-0 rounded-full border-8 border-transparent border-t-teal-600"
          style={{ transform: `rotate(${(capped / 100) * 360}deg)` }}
        />
        <div className="absolute inset-0 flex items-center justify-center text-2xl font-semibold text-slate-800">
          {Number.isFinite(metricValue) ? metricValue.toFixed(1) : '0.0'}
        </div>
      </div>
      {error ? <div className="text-xs text-red-600">{error}</div> : null}
    </div>
  )
}
