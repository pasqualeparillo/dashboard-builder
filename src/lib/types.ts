export type VizType = 'line-chart' | 'data-table' | 'metric-gauge' | 'text-box'

export interface DatasetColumn {
  name: string
  type: string
}

export interface DatasetDefinition {
  id: string
  name: string
  sql: string
  columns: DatasetColumn[]
  validationStatus: 'valid' | 'invalid'
  validationMessage?: string
}

export interface VizCoordinates {
  xField?: string
  yField?: string
  colorField?: string
  valueField?: string
}

export interface VizProps {
  title: string
  refreshMs: number
  datasetId?: string
  description?: string
  textContent?: string
  showTitle: boolean
  showDescription: boolean
  coordinates: VizCoordinates
}

export interface DashboardItem {
  id: string
  type: VizType
  props: VizProps
}

export interface SavedDashboardLayout {
  slug: string
  title: string
  updatedAt: string
  datasets: DatasetDefinition[]
  layout: Array<{
    i: string
    x: number
    y: number
    w: number
    h: number
    minW?: number
    minH?: number
  }>
  items: DashboardItem[]
}

export interface DashboardSpecV1 {
  version: 1
  metadata: {
    slug: string
    title: string
    updated_at: string
  }
  datasets: Array<{
    id: string
    name: string
    sql: string
    validation_status: 'valid' | 'invalid'
    validation_message: string | null
    columns: DatasetColumn[]
  }>
  filters: Array<Record<string, unknown>>
  widgets: Array<{
    id: string
    type: VizType
    props: {
      title: string
      refresh_ms: number
      dataset_id: string | null
      description: string
      text_content: string
      show_title: boolean
      show_description: boolean
      coordinates: {
        x_field: string | null
        y_field: string | null
        color_field: string | null
        value_field: string | null
      }
    }
  }>
  layout: Array<{
    i: string
    x: number
    y: number
    w: number
    h: number
    min_w?: number
    min_h?: number
  }>
}

export interface SavedDashboardYamlRecord {
  slug: string
  yaml: string
  updated_at: string
}
