import {
  BarChart3,
  Gauge,
  type LucideIcon,
  Table,
  Type,
} from 'lucide-react'

import type { DashboardItem, DatasetDefinition, VizType } from '@/lib/types'

import { DataTableViz } from './data-table-viz'
import { LineChartViz } from './line-chart-viz'
import { MetricGaugeViz } from './metric-gauge-viz'
import { TextBoxViz } from './text-box-viz'

export interface VisualizationDefinition {
  type: VizType
  label: string
  icon: LucideIcon
  requiredCoordinates: string[]
}

export const visualizationPalette: VisualizationDefinition[] = [
  {
    type: 'line-chart',
    label: 'Line',
    icon: BarChart3,
    requiredCoordinates: ['xField', 'yField'],
  },
  {
    type: 'data-table',
    label: 'Table',
    icon: Table,
    requiredCoordinates: [],
  },
  {
    type: 'metric-gauge',
    label: 'Gauge',
    icon: Gauge,
    requiredCoordinates: ['valueField'],
  },
  {
    type: 'text-box',
    label: 'Text',
    icon: Type,
    requiredCoordinates: [],
  },
]

export const typeAxisRules: Record<VizType, { required: string[] }> = Object.fromEntries(
  visualizationPalette.map((entry) => [entry.type, { required: entry.requiredCoordinates }]),
) as Record<VizType, { required: string[] }>

export function renderVisualization(item: DashboardItem, datasets: DatasetDefinition[]) {
  if (item.type === 'text-box') {
    return <TextBoxViz textContent={item.props.textContent} />
  }

  const dataset = datasets.find((entry) => entry.id === item.props.datasetId)
  const sql = dataset?.sql ?? ''

  if (!dataset) {
    return (
      <div className="flex h-full items-center justify-center rounded border border-dashed border-slate-300 text-sm text-slate-500">
        Select a dataset in the right panel.
      </div>
    )
  }

  if (item.type === 'line-chart') {
    return (
      <LineChartViz
        refreshMs={item.props.refreshMs}
        sql={sql}
        xField={item.props.coordinates.xField}
        yField={item.props.coordinates.yField}
      />
    )
  }

  if (item.type === 'data-table') {
    const visibleColumns = [
      item.props.coordinates.xField,
      item.props.coordinates.yField,
      item.props.coordinates.colorField,
    ].filter(Boolean) as string[]

    return (
      <DataTableViz
        refreshMs={item.props.refreshMs}
        sql={sql}
        visibleColumns={visibleColumns.length ? visibleColumns : undefined}
      />
    )
  }

  return (
    <MetricGaugeViz
      refreshMs={item.props.refreshMs}
      sql={sql}
      valueField={item.props.coordinates.valueField}
    />
  )
}
