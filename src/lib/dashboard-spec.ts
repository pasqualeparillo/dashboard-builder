import { parse, stringify } from 'yaml'

import type {
  DashboardSpecV1,
  SavedDashboardLayout,
  SavedDashboardYamlRecord,
  VizType,
} from '@/lib/types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null && !Array.isArray(value), `${path} must be an object`)
  return value as Record<string, unknown>
}

function asString(value: unknown, path: string): string {
  assert(typeof value === 'string' && value.trim().length > 0, `${path} must be a non-empty string`)
  return value
}

function asBoolean(value: unknown, path: string): boolean {
  assert(typeof value === 'boolean', `${path} must be a boolean`)
  return value
}

function asNumber(value: unknown, path: string): number {
  assert(typeof value === 'number' && Number.isFinite(value), `${path} must be a finite number`)
  return value
}

function asArray(value: unknown, path: string): unknown[] {
  assert(Array.isArray(value), `${path} must be an array`)
  return value
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

function normalizeVizType(value: unknown, path: string): VizType {
  const type = asString(value, path)
  assert(
    type === 'line-chart' || type === 'data-table' || type === 'metric-gauge' || type === 'text-box',
    `${path} must be one of: line-chart, data-table, metric-gauge, text-box`,
  )
  return type
}

export function toDashboardSpec(layout: SavedDashboardLayout): DashboardSpecV1 {
  return {
    version: 1,
    metadata: {
      slug: layout.slug,
      title: layout.title,
      updated_at: layout.updatedAt,
    },
    datasets: layout.datasets.map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      sql: dataset.sql,
      validation_status: dataset.validationStatus,
      validation_message: dataset.validationMessage ?? null,
      columns: dataset.columns.map((column) => ({
        name: column.name,
        type: column.type,
      })),
    })),
    filters: [],
    widgets: layout.items.map((item) => ({
      id: item.id,
      type: item.type,
      props: {
        title: item.props.title,
        refresh_ms: item.props.refreshMs,
        dataset_id: item.props.datasetId ?? null,
        description: item.props.description ?? '',
        text_content: item.props.textContent ?? '',
        show_title: item.props.showTitle,
        show_description: item.props.showDescription,
        coordinates: {
          x_field: item.props.coordinates.xField ?? null,
          y_field: item.props.coordinates.yField ?? null,
          color_field: item.props.coordinates.colorField ?? null,
          value_field: item.props.coordinates.valueField ?? null,
        },
      },
    })),
    layout: layout.layout.map((entry) => ({
      i: entry.i,
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
      min_w: entry.minW,
      min_h: entry.minH,
    })),
  }
}

export function fromDashboardSpec(spec: DashboardSpecV1): SavedDashboardLayout {
  const widgetIds = new Set(spec.widgets.map((widget) => widget.id))
  const layoutIds = new Set(spec.layout.map((entry) => entry.i))
  const datasetIds = new Set(spec.datasets.map((dataset) => dataset.id))

  for (const widgetId of widgetIds) {
    assert(layoutIds.has(widgetId), `layout entry missing for widget '${widgetId}'`)
  }
  for (const layoutId of layoutIds) {
    assert(widgetIds.has(layoutId), `widget entry missing for layout '${layoutId}'`)
  }

  for (const widget of spec.widgets) {
    const datasetId = widget.props.dataset_id
    if (datasetId) {
      assert(datasetIds.has(datasetId), `widget '${widget.id}' references unknown dataset '${datasetId}'`)
    }
  }

  return {
    slug: spec.metadata.slug,
    title: spec.metadata.title,
    updatedAt: spec.metadata.updated_at,
    datasets: spec.datasets.map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      sql: dataset.sql,
      columns: dataset.columns.map((column) => ({
        name: column.name,
        type: column.type,
      })),
      validationStatus: dataset.validation_status,
      validationMessage: normalizeOptionalString(dataset.validation_message),
    })),
    layout: spec.layout.map((entry) => ({
      i: entry.i,
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
      minW: entry.min_w,
      minH: entry.min_h,
    })),
    items: spec.widgets.map((widget) => ({
      id: widget.id,
      type: widget.type,
      props: {
        title: widget.props.title,
        refreshMs: widget.props.refresh_ms,
        datasetId: widget.props.dataset_id ?? undefined,
        description: widget.props.description,
        textContent: widget.props.text_content,
        showTitle: widget.props.show_title,
        showDescription: widget.props.show_description,
        coordinates: {
          xField: widget.props.coordinates.x_field ?? undefined,
          yField: widget.props.coordinates.y_field ?? undefined,
          colorField: widget.props.coordinates.color_field ?? undefined,
          valueField: widget.props.coordinates.value_field ?? undefined,
        },
      },
    })),
  }
}

function parseDashboardSpec(input: unknown): DashboardSpecV1 {
  const root = asObject(input, 'dashboard')
  const version = asNumber(root.version, 'version')
  assert(version === 1, `unsupported dashboard spec version '${version}'`)

  const metadata = asObject(root.metadata, 'metadata')
  const datasets = asArray(root.datasets, 'datasets')
  const filters = root.filters
  const widgets = asArray(root.widgets, 'widgets')
  const layout = asArray(root.layout, 'layout')

  if (filters !== undefined) {
    asArray(filters, 'filters')
  }

  const parsed: DashboardSpecV1 = {
    version: 1,
    metadata: {
      slug: asString(metadata.slug, 'metadata.slug'),
      title: asString(metadata.title, 'metadata.title'),
      updated_at: asString(metadata.updated_at, 'metadata.updated_at'),
    },
    datasets: datasets.map((entry, index) => {
      const dataset = asObject(entry, `datasets[${index}]`)
      const columns = asArray(dataset.columns, `datasets[${index}].columns`)
      const validationStatus = asString(
        dataset.validation_status,
        `datasets[${index}].validation_status`,
      )
      assert(
        validationStatus === 'valid' || validationStatus === 'invalid',
        `datasets[${index}].validation_status must be valid|invalid`,
      )

      return {
        id: asString(dataset.id, `datasets[${index}].id`),
        name: asString(dataset.name, `datasets[${index}].name`),
        sql: asString(dataset.sql, `datasets[${index}].sql`),
        validation_status: validationStatus,
        validation_message:
          dataset.validation_message === null || typeof dataset.validation_message === 'string'
            ? dataset.validation_message
            : null,
        columns: columns.map((columnEntry, columnIndex) => {
          const column = asObject(columnEntry, `datasets[${index}].columns[${columnIndex}]`)
          return {
            name: asString(column.name, `datasets[${index}].columns[${columnIndex}].name`),
            type: asString(column.type, `datasets[${index}].columns[${columnIndex}].type`),
          }
        }),
      }
    }),
    filters: [],
    widgets: widgets.map((entry, index) => {
      const widget = asObject(entry, `widgets[${index}]`)
      const props = asObject(widget.props, `widgets[${index}].props`)
      const coordinates = asObject(props.coordinates, `widgets[${index}].props.coordinates`)
      return {
        id: asString(widget.id, `widgets[${index}].id`),
        type: normalizeVizType(widget.type, `widgets[${index}].type`),
        props: {
          title: asString(props.title, `widgets[${index}].props.title`),
          refresh_ms: asNumber(props.refresh_ms, `widgets[${index}].props.refresh_ms`),
          dataset_id:
            props.dataset_id === null || typeof props.dataset_id === 'string' ? props.dataset_id : null,
          description: typeof props.description === 'string' ? props.description : '',
          text_content: typeof props.text_content === 'string' ? props.text_content : '',
          show_title: asBoolean(props.show_title, `widgets[${index}].props.show_title`),
          show_description: asBoolean(
            props.show_description,
            `widgets[${index}].props.show_description`,
          ),
          coordinates: {
            x_field:
              coordinates.x_field === null || typeof coordinates.x_field === 'string'
                ? coordinates.x_field
                : null,
            y_field:
              coordinates.y_field === null || typeof coordinates.y_field === 'string'
                ? coordinates.y_field
                : null,
            color_field:
              coordinates.color_field === null || typeof coordinates.color_field === 'string'
                ? coordinates.color_field
                : null,
            value_field:
              coordinates.value_field === null || typeof coordinates.value_field === 'string'
                ? coordinates.value_field
                : null,
          },
        },
      }
    }),
    layout: layout.map((entry, index) => {
      const item = asObject(entry, `layout[${index}]`)
      return {
        i: asString(item.i, `layout[${index}].i`),
        x: asNumber(item.x, `layout[${index}].x`),
        y: asNumber(item.y, `layout[${index}].y`),
        w: asNumber(item.w, `layout[${index}].w`),
        h: asNumber(item.h, `layout[${index}].h`),
        min_w: typeof item.min_w === 'number' ? item.min_w : undefined,
        min_h: typeof item.min_h === 'number' ? item.min_h : undefined,
      }
    }),
  }

  return parsed
}

export function toDashboardYaml(layout: SavedDashboardLayout): string {
  return stringify(toDashboardSpec(layout), {
    lineWidth: 120,
    defaultStringType: 'QUOTE_SINGLE',
  })
}

export function parseDashboardYaml(yamlContent: string): SavedDashboardLayout {
  const parsed = parse(yamlContent)
  const spec = parseDashboardSpec(parsed)
  return fromDashboardSpec(spec)
}

export function createYamlRecord(layout: SavedDashboardLayout): SavedDashboardYamlRecord {
  return {
    slug: layout.slug,
    yaml: toDashboardYaml(layout),
    updated_at: layout.updatedAt,
  }
}
