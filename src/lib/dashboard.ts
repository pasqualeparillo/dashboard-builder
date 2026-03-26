import type { LayoutItem } from 'react-grid-layout'

import type { DashboardItem, DatasetDefinition, SavedDashboardLayout } from '@/lib/types'

export const DEFAULT_SQL =
  'SELECT metric_name, metric_value, observed_at FROM my_catalog.my_schema.my_metric_view LIMIT 50'

export function createDefaultItem(id: string, type: DashboardItem['type']): DashboardItem {
  const defaultTitle =
    type === 'line-chart'
      ? 'Line Chart'
      : type === 'data-table'
        ? 'Data Table'
        : type === 'metric-gauge'
          ? 'Metric Gauge'
          : 'Text Box'

  const base = {
    id,
    props: {
      title: defaultTitle,
      refreshMs: 30000,
      datasetId: undefined,
      description: '',
      textContent: type === 'text-box' ? 'Add narrative context for this dashboard section.' : '',
      showTitle: true,
      showDescription: false,
      coordinates: {},
    },
  }

  return {
    ...base,
    type,
  }
}

export function toSavedLayout(
  slug: string,
  title: string,
  layout: LayoutItem[],
  items: DashboardItem[],
  datasets: DatasetDefinition[],
): SavedDashboardLayout {
  return {
    slug,
    title,
    updatedAt: new Date().toISOString(),
    datasets,
    layout: layout.map((entry) => ({
      i: entry.i,
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
      minW: entry.minW,
      minH: entry.minH,
    })),
    items,
  }
}
