import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import * as Popover from '@radix-ui/react-popover'
import GridLayout, { noCompactor, type LayoutItem } from 'react-grid-layout'
import {
  Copy,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Check,
  Database,
  Eye,
  Filter,
  LayoutGrid,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  Trash2,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  renderVisualization,
  typeAxisRules,
  visualizationPalette,
} from '@/components/visualizations/registry'
import { createDefaultItem, DEFAULT_SQL, toSavedLayout } from '@/lib/dashboard'
import { createYamlRecord, parseDashboardYaml } from '@/lib/dashboard-spec'
import { createEmbedToken, fetchEmbedDashboard } from '@/lib/embed'
import {
  deleteDashboardLayout,
  listDashboardLayoutsFromGithub,
  saveDashboardLayout,
} from '@/lib/github'
import { useMetricQuery } from '@/hooks/use-metric-query'
import { validateDatasetSql } from '@/lib/metrics'
import { createDashboardSlug, slugify } from '@/lib/slug'
import type {
  DashboardItem,
  DatasetDefinition,
  SavedDashboardLayout,
  SavedDashboardYamlRecord,
  VizType,
} from '@/lib/types'

const GRID_COLS = 12
const ROW_HEIGHT = 32
const GRID_MARGIN: [number, number] = [12, 12]
const GRID_CONTAINER_PADDING: [number, number] = [12, 12]
const LEFT_OPEN_WIDTH = 300
const LEFT_COLLAPSED_WIDTH = 44
const RIGHT_OPEN_WIDTH = 320
const RIGHT_COLLAPSED_WIDTH = 44
const CANVAS_PAGES = 3
const LOCAL_LAYOUTS_KEY = 'dashboard-builder.saved-layout-yaml.v1'

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Unknown update time'
  }

  return date.toLocaleString()
}

function readSavedLayoutsFromStorage(): SavedDashboardLayout[] {
  if (typeof window === 'undefined') {
    return []
  }

  const raw = window.localStorage.getItem(LOCAL_LAYOUTS_KEY)
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }

    const parsedRecords = parsed.filter(
      (entry): entry is SavedDashboardYamlRecord =>
        entry &&
        typeof entry.slug === 'string' &&
        typeof entry.yaml === 'string' &&
        typeof entry.updated_at === 'string',
    )

    if (parsedRecords.length > 0) {
      return parsedRecords
        .map((entry) => {
          const layout = parseDashboardYaml(entry.yaml)
          return { ...layout, updatedAt: entry.updated_at }
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }

    return parsed
      .filter(
        (entry): entry is SavedDashboardLayout =>
          entry &&
          typeof entry.slug === 'string' &&
          typeof entry.title === 'string' &&
          typeof entry.updatedAt === 'string' &&
          Array.isArray(entry.layout) &&
          Array.isArray(entry.items) &&
          Array.isArray(entry.datasets),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

function writeSavedLayoutsToStorage(layouts: SavedDashboardLayout[]) {
  if (typeof window === 'undefined') {
    return
  }
  const records = layouts.map((layout) => createYamlRecord(layout))
  window.localStorage.setItem(LOCAL_LAYOUTS_KEY, JSON.stringify(records))
}

function upsertSavedLayout(
  layout: SavedDashboardLayout,
  existing: SavedDashboardLayout[],
): SavedDashboardLayout[] {
  const next = [layout, ...existing.filter((entry) => entry.slug !== layout.slug)]
  return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function ensureUniqueSlug(baseSlug: string, takenSlugs: Set<string>, preserveSlug?: string | null) {
  const normalizedPreserve = preserveSlug ? slugify(preserveSlug) : null
  if (!baseSlug) {
    return ''
  }

  if (!takenSlugs.has(baseSlug) || normalizedPreserve === baseSlug) {
    return baseSlug
  }

  let index = 2
  let candidate = `${baseSlug}-${index}`
  while (takenSlugs.has(candidate)) {
    index += 1
    candidate = `${baseSlug}-${index}`
  }

  return candidate
}

function ensureUniqueDashboardSlug(takenSlugs: Set<string>, preserveSlug?: string | null) {
  const normalizedPreserve = preserveSlug ? slugify(preserveSlug) : null
  let attempts = 0

  while (attempts < 20) {
    const candidate = createDashboardSlug()
    if (!takenSlugs.has(candidate) || normalizedPreserve === candidate) {
      return candidate
    }
    attempts += 1
  }

  return ensureUniqueSlug(createDashboardSlug(), takenSlugs, preserveSlug)
}

function mergeLocalAndRemoteDashboards(
  localDashboards: SavedDashboardLayout[],
  remoteDashboards: SavedDashboardLayout[],
) {
  const merged = new Map<string, SavedDashboardLayout>()

  for (const dashboard of localDashboards) {
    merged.set(dashboard.slug, dashboard)
  }

  for (const dashboard of remoteDashboards) {
    const existing = merged.get(dashboard.slug)
    if (!existing || dashboard.updatedAt > existing.updatedAt) {
      merged.set(dashboard.slug, dashboard)
    }
  }

  return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

interface BuilderSnapshot {
  items: DashboardItem[]
  layout: LayoutItem[]
  datasets: DatasetDefinition[]
  selectedId: string | null
}

type ViewMode = 'builder' | 'catalog' | 'preview'

function cloneLayout(layout: LayoutItem[]): LayoutItem[] {
  return layout.map((item) => ({ ...item }))
}

function cloneDatasets(datasets: DatasetDefinition[]): DatasetDefinition[] {
  return datasets.map((dataset) => ({
    ...dataset,
    columns: dataset.columns.map((column) => ({ ...column })),
  }))
}

function cloneItems(items: DashboardItem[]): DashboardItem[] {
  return items.map((item) => ({
    ...item,
    props: {
      ...item.props,
      coordinates: { ...item.props.coordinates },
    },
  }))
}

function createSnapshot(
  items: DashboardItem[],
  layout: LayoutItem[],
  datasets: DatasetDefinition[],
  selectedId: string | null,
): BuilderSnapshot {
  return {
    items: cloneItems(items),
    layout: cloneLayout(layout),
    datasets: cloneDatasets(datasets),
    selectedId,
  }
}

function toLayoutItems(layout: SavedDashboardLayout['layout']): LayoutItem[] {
  return layout.map((entry) => ({ ...entry }))
}

function createLayoutItem(itemId: string, type: VizType, itemCount: number): LayoutItem {
  const baseX = (itemCount * 4) % GRID_COLS

  if (type === 'text-box') {
    const width = 6
    return {
      i: itemId,
      x: baseX + width > GRID_COLS ? 0 : baseX,
      y: Infinity,
      w: width,
      h: 4,
      minW: 4,
      minH: 3,
    }
  }

  const width = type === 'metric-gauge' ? 4 : 5
  return {
    i: itemId,
    x: baseX + width > GRID_COLS ? 0 : baseX,
    y: Infinity,
    w: width,
    h: 7,
    minW: 4,
    minH: 5,
  }
}

function canPlaceItem(candidate: LayoutItem, layout: LayoutItem[]) {
  return !layout.some((item) => layoutsOverlap(candidate, item))
}

function createPlacedLayoutItem(itemId: string, type: VizType, layout: LayoutItem[]): LayoutItem {
  const base = createLayoutItem(itemId, type, layout.length)

  for (let y = 0; y < 500; y += 1) {
    for (let x = 0; x <= GRID_COLS - base.w; x += 1) {
      const candidate: LayoutItem = {
        ...base,
        x,
        y,
      }

      if (canPlaceItem(candidate, layout)) {
        return candidate
      }
    }
  }

  const maxBottom = layout.reduce((max, item) => Math.max(max, item.y + item.h), 0)
  return {
    ...base,
    x: 0,
    y: maxBottom,
  }
}

function getCanvasHeightPx(layout: LayoutItem[], viewportHeight: number, maxCanvasHeight: number) {
  const maxBottomRow = layout.reduce((max, item) => Math.max(max, item.y + item.h), 0)
  const filledHeight = maxBottomRow * (ROW_HEIGHT + GRID_MARGIN[1]) + 36
  return Math.max(viewportHeight, Math.min(maxCanvasHeight, filledHeight))
}

function layoutsOverlap(a: LayoutItem, b: LayoutItem) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function rowsOverlap(a: LayoutItem, b: LayoutItem) {
  return a.y < b.y + b.h && a.y + a.h > b.y
}

function clampItemToGrid(item: LayoutItem, cols: number) {
  const minW = item.minW ?? 1
  if (item.w < minW) {
    item.w = minW
  }
  if (item.w > cols) {
    item.w = cols
  }

  if (item.x < 0) {
    item.x = 0
  }
  if (item.x + item.w > cols) {
    item.x = Math.max(0, cols - item.w)
  }
}

function resolveCollisions(layout: LayoutItem[], activeId: string | null): LayoutItem[] {
  const next = layout.map((item) => ({ ...item }))
  const active = activeId ? next.find((item) => item.i === activeId) : null

  if (active) {
    for (const item of next) {
      if (item.i === active.i || !rowsOverlap(active, item)) {
        continue
      }

      const touchesFromLeft = item.x >= active.x
      const overlap = touchesFromLeft
        ? active.x + active.w - item.x
        : item.x + item.w - active.x

      if (overlap <= 0) {
        continue
      }

      const minW = item.minW ?? 1
      const shrinkCapacity = Math.max(0, item.w - minW)
      const shrink = Math.min(shrinkCapacity, overlap)

      if (touchesFromLeft) {
        item.x += shrink
        item.w -= shrink
      } else {
        item.w -= shrink
      }

      const remaining = overlap - shrink
      if (remaining > 0) {
        if (touchesFromLeft) {
          item.x += remaining
        } else {
          const targetX = item.x - remaining
          item.x = Math.max(0, targetX)
          if (targetX < 0) {
            item.y = Math.max(item.y, active.y + active.h)
          }
        }
      }

      clampItemToGrid(item, GRID_COLS)
    }
  }

  for (const item of next) {
    clampItemToGrid(item, GRID_COLS)
  }

  let changed = true
  let guard = 0
  while (changed && guard < 300) {
    guard += 1
    changed = false

    for (let i = 0; i < next.length; i += 1) {
      for (let j = i + 1; j < next.length; j += 1) {
        const first = next[i]
        const second = next[j]

        if (!layoutsOverlap(first, second)) {
          continue
        }

        const moveTarget = second.i === activeId ? first : second
        const anchor = moveTarget === second ? first : second
        moveTarget.y = anchor.y + anchor.h
        changed = true
      }
    }
  }

  return next
}

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  const tagName = target.tagName
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target.isContentEditable ||
    target.closest('[contenteditable="true"]') !== null
  )
}

function mergeUniqueColumns(values: string[]) {
  const deduped = new Set<string>()
  for (const value of values) {
    const next = value.trim()
    if (next) {
      deduped.add(next)
    }
  }
  return [...deduped]
}

function getFieldTypeLabel(type: string) {
  const normalized = type.toLowerCase()
  if (normalized.includes('int') || normalized.includes('double') || normalized.includes('decimal') || normalized.includes('number')) {
    return '123'
  }
  if (normalized.includes('date') || normalized.includes('time')) {
    return 'T'
  }
  return 'ABC'
}

function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('builder')
  const [dashboardTitle, setDashboardTitle] = useState('New Dashboard')
  const [dashboardSlug, setDashboardSlug] = useState(() => createDashboardSlug())
  const [items, setItems] = useState<DashboardItem[]>([])
  const [layout, setLayout] = useState<LayoutItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [datasets, setDatasets] = useState<DatasetDefinition[]>([])
  const [showDatasetEditor, setShowDatasetEditor] = useState(false)
  const [datasetName, setDatasetName] = useState('')
  const [datasetSql, setDatasetSql] = useState(DEFAULT_SQL)
  const [datasetPreviewSql, setDatasetPreviewSql] = useState('')
  const [hasRunDatasetPreview, setHasRunDatasetPreview] = useState(false)
  const [datasetStatus, setDatasetStatus] = useState('')
  const [isValidatingDataset, setIsValidatingDataset] = useState(false)
  const [datasetPreviewLimit, setDatasetPreviewLimit] = useState(5)
  const [draggingTableColumn, setDraggingTableColumn] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [hasSavedToGithub, setHasSavedToGithub] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [leftTab, setLeftTab] = useState<'data' | 'filters'>('data')
  const [gridWidth, setGridWidth] = useState(930)
  const [viewportHeight, setViewportHeight] = useState(
    typeof window !== 'undefined' ? window.innerHeight - 56 : 900,
  )
  const [history, setHistory] = useState<BuilderSnapshot[]>([])
  const [future, setFuture] = useState<BuilderSnapshot[]>([])
  const [inlineEditor, setInlineEditor] = useState<{
    itemId: string
    field: 'title' | 'description'
  } | null>(null)
  const [isEditingFormFields, setIsEditingFormFields] = useState(false)
  const [isPanelTransitioning, setIsPanelTransitioning] = useState(false)
  const [savedDashboards, setSavedDashboards] = useState<SavedDashboardLayout[]>(() =>
    readSavedLayoutsFromStorage(),
  )
  const [activePreviewSlug, setActivePreviewSlug] = useState<string | null>(null)
  const [previewDashboardOverride, setPreviewDashboardOverride] = useState<SavedDashboardLayout | null>(null)
  const [embedStatus, setEmbedStatus] = useState('')
  const [isCreatingEmbed, setIsCreatingEmbed] = useState(false)
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false)
  const [isSyncingFromGithub, setIsSyncingFromGithub] = useState(false)
  const [lastGithubSyncAt, setLastGithubSyncAt] = useState<string | null>(null)
  const [githubSyncStatus, setGithubSyncStatus] = useState('')
  const [embeddedDashboard, setEmbeddedDashboard] = useState<SavedDashboardLayout | null>(null)
  const [embedLoadError, setEmbedLoadError] = useState('')
  const gridContainerRef = useRef<HTMLDivElement | null>(null)
  const previewGridContainerRef = useRef<HTMLDivElement | null>(null)
  const importYamlInputRef = useRef<HTMLInputElement | null>(null)
  const isSyncingFromGithubRef = useRef(false)
  const activeInteractionIdRef = useRef<string | null>(null)
  const panelTransitionTimeoutRef = useRef<number | null>(null)
  const [previewGridWidth, setPreviewGridWidth] = useState(930)
  const embedSlug = useMemo(() => {
    if (typeof window === 'undefined') {
      return null
    }

    const match = window.location.pathname.match(/^\/embed\/([^/]+)$/)
    return match?.[1] ? decodeURIComponent(match[1]) : null
  }, [])

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  )

  const selectedDataset = useMemo(() => {
    if (!selectedItem?.props.datasetId) {
      return null
    }

    return datasets.find((entry) => entry.id === selectedItem.props.datasetId) ?? null
  }, [datasets, selectedItem])

  const selectedDatasetRefreshMs = selectedItem?.props.refreshMs ?? 30000
  const {
    data: selectedDatasetRows,
    loading: selectedDatasetLoading,
    error: selectedDatasetError,
  } = useMetricQuery(selectedDataset?.sql ?? '', selectedDatasetRefreshMs)
  const inferredSelectedDatasetColumns = useMemo(
    () => Object.keys(selectedDatasetRows[0] ?? {}).map((name) => ({ name, type: 'UNKNOWN' })),
    [selectedDatasetRows],
  )

  const datasetColumns =
    selectedDataset?.columns.length && selectedDataset.columns.length > 0
      ? selectedDataset.columns
      : inferredSelectedDatasetColumns
  const datasetFieldNames = useMemo(() => datasetColumns.map((column) => column.name), [datasetColumns])
  const {
    data: datasetPreviewRows,
    loading: datasetPreviewLoading,
    error: datasetPreviewError,
  } = useMetricQuery(showDatasetEditor ? datasetPreviewSql : '', 60000)
  const datasetPreviewColumns = useMemo(() => Object.keys(datasetPreviewRows[0] ?? {}), [datasetPreviewRows])
  const datasetPreviewDisplayRows = useMemo(
    () => datasetPreviewRows.slice(0, Math.max(1, Math.min(datasetPreviewLimit, 50))),
    [datasetPreviewLimit, datasetPreviewRows],
  )
  const canSaveDataset =
    hasRunDatasetPreview && !datasetPreviewLoading && !datasetPreviewError && datasetPreviewColumns.length > 0
  const requiredAxis = selectedItem ? typeAxisRules[selectedItem.type].required : []
  const missingRequiredAxis = selectedItem
    ? requiredAxis.filter(
        (key) => !selectedItem.props.coordinates[key as keyof typeof selectedItem.props.coordinates],
      )
    : []
  const selectedTableColumns = useMemo(
    () => selectedItem?.props.coordinates.tableColumns ?? [],
    [selectedItem],
  )
  const maxCanvasHeight = CANVAS_PAGES * viewportHeight
  const maxGridRows = Math.floor(maxCanvasHeight / (ROW_HEIGHT + GRID_MARGIN[1]))
  const canvasHeight = getCanvasHeightPx(layout, viewportHeight, maxCanvasHeight)
  const gridCellWidth = useMemo(() => {
    return (
      (gridWidth - GRID_MARGIN[0] * (GRID_COLS - 1) - GRID_CONTAINER_PADDING[0] * 2) /
      GRID_COLS
    )
  }, [gridWidth])
  const gridPitchX = gridCellWidth + GRID_MARGIN[0]
  const gridPitchY = ROW_HEIGHT + GRID_MARGIN[1]
  const activePreviewDashboard = useMemo(() => {
    if (previewDashboardOverride) {
      return previewDashboardOverride
    }

    if (!activePreviewSlug) {
      return null
    }

    return savedDashboards.find((entry) => entry.slug === activePreviewSlug) ?? null
  }, [savedDashboards, activePreviewSlug, previewDashboardOverride])
  const canPreviewCurrent = items.length > 0

  const syncDashboardsFromGithub = useCallback(
    async (showStatus = false) => {
      if (isSyncingFromGithubRef.current) {
        return
      }

      isSyncingFromGithubRef.current = true
      setIsSyncingFromGithub(true)
      if (showStatus) {
        setGithubSyncStatus('Syncing dashboards from GitHub...')
      }

      try {
        const remoteDashboards = await listDashboardLayoutsFromGithub()

        setSavedDashboards((current) => {
          const merged = mergeLocalAndRemoteDashboards(current, remoteDashboards)
          writeSavedLayoutsToStorage(merged)
          return merged
        })

        const syncedAt = new Date().toISOString()
        setLastGithubSyncAt(syncedAt)
        if (showStatus) {
          setGithubSyncStatus(
            remoteDashboards.length
              ? `Synced ${remoteDashboards.length} dashboard${remoteDashboards.length === 1 ? '' : 's'} from GitHub.`
              : 'GitHub sync complete. No dashboards found in repo.',
          )
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown GitHub sync error'
        if (showStatus) {
          setGithubSyncStatus(`GitHub sync failed: ${message}`)
        }
      } finally {
        setIsSyncingFromGithub(false)
        isSyncingFromGithubRef.current = false
      }
    },
    [],
  )

  useEffect(() => {
    if (viewMode !== 'builder') {
      return
    }

    const element = gridContainerRef.current
    if (!element) {
      return
    }

    const syncWidth = () => {
      const nextWidth = Math.max(320, Math.floor(element.getBoundingClientRect().width))
      setGridWidth(nextWidth)
    }

    syncWidth()
    const observer = new ResizeObserver(syncWidth)
    observer.observe(element)

    return () => {
      observer.disconnect()
    }
  }, [leftPanelOpen, rightPanelOpen, viewMode])

  useEffect(() => {
    const element = previewGridContainerRef.current
    if (!element) {
      return
    }

    const syncWidth = () => {
      const nextWidth = Math.max(320, Math.floor(element.getBoundingClientRect().width))
      setPreviewGridWidth(nextWidth)
    }

    syncWidth()
    const observer = new ResizeObserver(syncWidth)
    observer.observe(element)

    return () => {
      observer.disconnect()
    }
  }, [viewMode, activePreviewSlug])

  useEffect(() => {
    if (!embedSlug) {
      return
    }

    const token = new URLSearchParams(window.location.search).get('token')
    if (!token) {
      setEmbedLoadError('Missing embed token')
      return
    }

    let cancelled = false
    setEmbedLoadError('')

    const load = async () => {
      try {
        const dashboard = await fetchEmbedDashboard(embedSlug, token)
        if (!cancelled) {
          setEmbeddedDashboard(dashboard)
        }
      } catch (error) {
        if (!cancelled) {
          setEmbedLoadError(error instanceof Error ? error.message : 'Failed to load embedded dashboard')
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [embedSlug])

  useEffect(() => {
    const onResize = () => {
      setViewportHeight(window.innerHeight - 56)
    }

    onResize()
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (panelTransitionTimeoutRef.current !== null) {
        window.clearTimeout(panelTransitionTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    void syncDashboardsFromGithub(false)
  }, [syncDashboardsFromGithub])

  const startPanelTransition = () => {
    setIsPanelTransitioning(true)
    if (panelTransitionTimeoutRef.current !== null) {
      window.clearTimeout(panelTransitionTimeoutRef.current)
    }
    panelTransitionTimeoutRef.current = window.setTimeout(() => {
      setIsPanelTransitioning(false)
      panelTransitionTimeoutRef.current = null
    }, 220)
  }

  const setLeftPanelOpenWithTransition = (open: boolean) => {
    if (open === leftPanelOpen) {
      return
    }
    startPanelTransition()
    setLeftPanelOpen(open)
  }

  const setRightPanelOpenWithTransition = (open: boolean) => {
    if (open === rightPanelOpen) {
      return
    }
    startPanelTransition()
    setRightPanelOpen(open)
  }

  const pushHistory = () => {
    setHistory((previous) => [...previous, createSnapshot(items, layout, datasets, selectedId)])
    setFuture([])
  }

  const applySnapshot = (snapshot: BuilderSnapshot) => {
    setItems(cloneItems(snapshot.items))
    setLayout(cloneLayout(snapshot.layout))
    setDatasets(
      snapshot.datasets.map((dataset) => ({
        ...dataset,
        columns: dataset.columns.map((column) => ({ ...column })),
      })),
    )
    setSelectedId(snapshot.selectedId)
  }

  const handleUndo = () => {
    if (!history.length) {
      return
    }

    const previous = history[history.length - 1]
    setHistory((current) => current.slice(0, -1))
    setFuture((current) => [createSnapshot(items, layout, datasets, selectedId), ...current])
    applySnapshot(previous)
  }

  const handleRedo = () => {
    if (!future.length) {
      return
    }

    const next = future[0]
    setFuture((current) => current.slice(1))
    setHistory((current) => [...current, createSnapshot(items, layout, datasets, selectedId)])
    applySnapshot(next)
  }

  const addItem = (type: VizType) => {
    pushHistory()
    setIsDirty(true)
    const itemId = `${type}-${crypto.randomUUID()}`
    const newItem = createDefaultItem(itemId, type)

    setItems((previous) => [...previous, newItem])
    setLayout((previous) => [...previous, createPlacedLayoutItem(itemId, type, previous)])
    setSelectedId(itemId)
  }

  const setShowTitle = (checked: boolean) => {
    if (!selectedItem) {
      return
    }

    if (!checked) {
      updateSelected({ showTitle: false, title: '' })
      return
    }

    updateSelected({ showTitle: true, title: selectedItem.props.title || 'Widget title' })
  }

  const setShowDescription = (checked: boolean) => {
    if (!selectedItem) {
      return
    }

    if (!checked) {
      updateSelected({ showDescription: false, description: '' })
      return
    }

    updateSelected({
      showDescription: true,
      description: selectedItem.props.description || 'Description',
    })
  }

  const removeSelected = () => {
    if (!selectedItem) {
      return
    }

    pushHistory()
    setIsDirty(true)
    setItems((previous) => previous.filter((entry) => entry.id !== selectedItem.id))
    setLayout((previous) => previous.filter((entry) => entry.i !== selectedItem.id))
    setSelectedId(null)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTextEntryTarget(event.target)) {
        return
      }

      const key = event.key.toLowerCase()
      const usesShortcutModifier = event.ctrlKey || event.metaKey

      if (usesShortcutModifier && !event.altKey) {
        if (key === 'z' && !event.shiftKey) {
          event.preventDefault()
          handleUndo()
          return
        }

        if (key === 'y' || (key === 'z' && event.shiftKey)) {
          event.preventDefault()
          handleRedo()
          return
        }
      }

      if (event.key === 'Delete' && selectedItem) {
        event.preventDefault()
        removeSelected()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [selectedItem, removeSelected, handleUndo, handleRedo])

  const updateSelected = (next: Partial<DashboardItem['props']>, recordHistory = true) => {
    if (!selectedItem) {
      return
    }

    if (recordHistory && !isEditingFormFields) {
      pushHistory()
    }
    setIsDirty(true)
    setItems((previous) =>
      previous.map((entry) =>
        entry.id === selectedItem.id
          ? { ...entry, props: { ...entry.props, ...next } }
          : entry,
      ),
    )
  }

  const updateCoordinate = (
    key: 'xField' | 'yField' | 'colorField' | 'valueField',
    value: string,
  ) => {
    if (!selectedItem) {
      return
    }

    updateSelected({
      coordinates: {
        ...selectedItem.props.coordinates,
        [key]: value,
      },
    }, false)
  }

  const startFormEditing = () => {
    if (!isEditingFormFields) {
      pushHistory()
      setIsEditingFormFields(true)
    }
  }

  const endFormEditing = () => {
    if (isEditingFormFields) {
      setIsEditingFormFields(false)
    }
  }

  const beginInlineEdit = (itemId: string, field: 'title' | 'description') => {
    if (inlineEditor?.itemId === itemId && inlineEditor.field === field) {
      return
    }

    pushHistory()
    setInlineEditor({ itemId, field })
  }

  const switchSelectedVisualization = (nextType: VizType) => {
    if (!selectedItem || selectedItem.type === nextType) {
      return
    }

    pushHistory()
    setIsDirty(true)

    const defaults = createDefaultItem(selectedItem.id, nextType)

    setItems((previous) =>
      previous.map((entry) => {
        if (entry.id !== selectedItem.id) {
          return entry
        }

        return {
          ...entry,
          type: nextType,
          props: {
            ...defaults.props,
            title: entry.props.title,
            description: entry.props.description,
            showTitle: entry.props.showTitle,
            showDescription: entry.props.showDescription,
            datasetId: nextType === 'text-box' ? undefined : entry.props.datasetId,
            textContent:
              nextType === 'text-box'
                ? entry.props.textContent || defaults.props.textContent
                : '',
          },
        }
      }),
    )

    setLayout((previous) =>
      previous.map((entry) => {
        if (entry.i !== selectedItem.id) {
          return entry
        }

        if (nextType === 'text-box') {
          return {
            ...entry,
            minH: 3,
            h: Math.min(entry.h, 5),
          }
        }

        return {
          ...entry,
          minH: 5,
          h: Math.max(entry.h, 7),
        }
      }),
    )
  }

  const createDataset = async () => {
    if (!datasetName.trim()) {
      setDatasetStatus('Dataset name is required.')
      return
    }

    if (!datasetSql.trim()) {
      setDatasetStatus('Dataset SQL is required.')
      return
    }

    if (!hasRunDatasetPreview) {
      setDatasetStatus('Run the query preview before saving this dataset.')
      return
    }

    if (!canSaveDataset) {
      setDatasetStatus('Run a successful preview before saving this dataset.')
      return
    }

    setIsValidatingDataset(true)
    setDatasetStatus('Validating SQL...')

    try {
      const validation = await validateDatasetSql(datasetSql)
      pushHistory()
      setIsDirty(true)
      const dataset: DatasetDefinition = {
        id: `dataset-${crypto.randomUUID()}`,
        name: datasetName,
        sql: datasetSql,
        columns: validation.columns,
        validationStatus: validation.valid ? 'valid' : 'invalid',
        validationMessage: validation.message,
      }

      setDatasets((previous) => [...previous, dataset])
      setDatasetStatus(validation.message)
      setDatasetName('')
      setDatasetSql(DEFAULT_SQL)
      setDatasetPreviewSql('')
      setHasRunDatasetPreview(false)
      setShowDatasetEditor(false)
    } catch (error) {
      setDatasetStatus(error instanceof Error ? error.message : 'Dataset validation failed.')
    } finally {
      setIsValidatingDataset(false)
    }
  }

  const runDatasetPreview = () => {
    if (!datasetSql.trim()) {
      setDatasetStatus('Dataset SQL is required.')
      return
    }

    setDatasetStatus('')
    setHasRunDatasetPreview(true)
    setDatasetPreviewSql(datasetSql)
  }

  const handleSave = async () => {
    const requestedSlug = slugify(dashboardSlug)
    if (!requestedSlug) {
      setSaveStatus('Please add a valid slug before saving.')
      return
    }

    const requestedLooksLikeLegacyDefault = requestedSlug === 'new-dashboard'

    const existingSlugs = new Set(savedDashboards.map((entry) => entry.slug))
    const uniqueSlug = requestedLooksLikeLegacyDefault
      ? ensureUniqueDashboardSlug(existingSlugs, hasSavedToGithub ? dashboardSlug : null)
      : ensureUniqueSlug(
          requestedSlug,
          existingSlugs,
          hasSavedToGithub ? dashboardSlug : null,
        )
    const slugWasAdjusted = uniqueSlug !== requestedSlug

    setIsSaving(true)
    setSaveStatus('Saving dashboard...')

    const payload = toSavedLayout(uniqueSlug, dashboardTitle, layout, items, datasets)
    const updatedSavedDashboards = upsertSavedLayout(payload, savedDashboards)
    setSavedDashboards(updatedSavedDashboards)
    writeSavedLayoutsToStorage(updatedSavedDashboards)
    setDashboardSlug(uniqueSlug)
    setIsDirty(false)

    try {
      const result = await saveDashboardLayout(payload)
      const commitRef = result.commitSha ? result.commitSha.slice(0, 7) : 'unknown'
      const slugAdjustmentMessage = slugWasAdjusted
        ? requestedLooksLikeLegacyDefault
          ? `Generated unique slug ${uniqueSlug}.`
          : 'Slug adjusted to avoid conflict.'
        : ''
      setSaveStatus(`Saved to ${result.path} (${commitRef})${slugAdjustmentMessage ? ` ${slugAdjustmentMessage}` : ''}`)
      setHasSavedToGithub(true)
      setGithubSyncStatus(`GitHub commit ${commitRef} updated ${result.path}`)
      setLastGithubSyncAt(new Date().toISOString())
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save dashboard to GitHub'
      setSaveStatus(`Saved locally. GitHub sync failed: ${message}`)
      setHasSavedToGithub(false)
    } finally {
      setIsSaving(false)
    }
  }

  const loadDashboardIntoBuilder = (dashboard: SavedDashboardLayout) => {
    setDashboardTitle(dashboard.title)
    setDashboardSlug(dashboard.slug)
    setItems(cloneItems(dashboard.items))
    setLayout(toLayoutItems(dashboard.layout))
    setDatasets(cloneDatasets(dashboard.datasets))
    setSelectedId(dashboard.items[0]?.id ?? null)
    setHistory([])
    setFuture([])
    setInlineEditor(null)
    setSaveStatus(`Loaded ${dashboard.title}`)
    setHasSavedToGithub(true)
    setIsDirty(false)
    setViewMode('builder')
  }

  const openPreview = (slug: string) => {
    setPreviewDashboardOverride(null)
    setActivePreviewSlug(slug)
    setEmbedStatus('')
    setViewMode('preview')
  }

  const openPreviewForCurrent = () => {
    if (!canPreviewCurrent) {
      setSaveStatus('Add at least one widget before opening preview.')
      return
    }

    const cleanSlug = slugify(dashboardSlug) || 'preview-dashboard'
    const previewLayout = toSavedLayout(cleanSlug, dashboardTitle, layout, items, datasets)
    setPreviewDashboardOverride(previewLayout)
    setActivePreviewSlug(null)
    setEmbedStatus('')
    setViewMode('preview')
  }

  const handleDownloadYaml = () => {
    const cleanSlug = slugify(dashboardSlug)
    if (!cleanSlug) {
      setSaveStatus('Please set a valid slug before exporting YAML.')
      return
    }

    const payload = toSavedLayout(cleanSlug, dashboardTitle, layout, items, datasets)
    const yaml = createYamlRecord(payload).yaml
    const blob = new Blob([yaml], { type: 'application/yaml' })
    const url = window.URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${cleanSlug}.dashboard.yaml`
    anchor.click()
    window.URL.revokeObjectURL(url)
    setSaveStatus(`Exported ${cleanSlug}.dashboard.yaml`)
  }

  const handleImportYaml = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const content = String(reader.result ?? '')
        const parsed = parseDashboardYaml(content)
        loadDashboardIntoBuilder(parsed)
        const updatedSavedDashboards = upsertSavedLayout(parsed, savedDashboards)
        setSavedDashboards(updatedSavedDashboards)
        writeSavedLayoutsToStorage(updatedSavedDashboards)
        setSaveStatus(`Imported ${parsed.slug} from YAML`)
      } catch (error) {
        setSaveStatus(error instanceof Error ? `YAML import failed: ${error.message}` : 'YAML import failed')
      }
    }

    reader.onerror = () => {
      setSaveStatus('Failed to read YAML file.')
    }

    reader.readAsText(file)
    event.target.value = ''
  }

  const openImportYamlPicker = () => {
    setIsActionsMenuOpen(false)
    window.setTimeout(() => {
      importYamlInputRef.current?.click()
    }, 0)
  }

  const handleCopyEmbedLink = async (slug: string) => {
    setIsCreatingEmbed(true)
    setEmbedStatus('')
    try {
      const response = await createEmbedToken(slug)
      await navigator.clipboard.writeText(response.embed_url)
      setEmbedStatus(`Copied embed URL for ${slug}. Expires at ${formatUpdatedAt(response.expires_at)}`)
    } catch (error) {
      setEmbedStatus(error instanceof Error ? error.message : 'Failed to generate embed URL')
    } finally {
      setIsCreatingEmbed(false)
    }
  }

  const handleDeleteSavedDashboard = async (slug: string, title: string) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${title}"? This removes the saved dashboard locally and from GitHub.`,
    )

    if (!confirmed) {
      return
    }

    const nextSavedDashboards = savedDashboards.filter((dashboard) => dashboard.slug !== slug)
    setSavedDashboards(nextSavedDashboards)
    writeSavedLayoutsToStorage(nextSavedDashboards)

    if (activePreviewSlug === slug && viewMode === 'preview' && !previewDashboardOverride) {
      setActivePreviewSlug(null)
      setViewMode('catalog')
    }

    if (dashboardSlug === slug) {
      setHasSavedToGithub(false)
    }

    setEmbedStatus('')
    setSaveStatus(`Deleted ${title} locally`)

    try {
      await deleteDashboardLayout(slug)
      setGithubSyncStatus(`Deleted dashboards/${slug}/dashboard.yaml from GitHub`)
      setLastGithubSyncAt(new Date().toISOString())
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown GitHub delete error'
      setGithubSyncStatus(`Local delete complete, but GitHub delete failed: ${message}`)
    }
  }

  useEffect(() => {
    if (viewMode !== 'builder') {
      return
    }

    const syncGridAfterViewSwitch = () => {
      const element = gridContainerRef.current
      if (!element) {
        return
      }

      const nextWidth = Math.max(320, Math.floor(element.getBoundingClientRect().width))
      setGridWidth(nextWidth)
    }

    window.requestAnimationFrame(() => {
      syncGridAfterViewSwitch()
      window.requestAnimationFrame(syncGridAfterViewSwitch)
    })
  }, [viewMode])

  const leftPanelWidth = leftPanelOpen ? LEFT_OPEN_WIDTH : LEFT_COLLAPSED_WIDTH
  const rightPanelWidth = rightPanelOpen ? RIGHT_OPEN_WIDTH : RIGHT_COLLAPSED_WIDTH
  const previewLayout = activePreviewDashboard ? toLayoutItems(activePreviewDashboard.layout) : []
  const previewCanvasHeight = getCanvasHeightPx(previewLayout, viewportHeight, maxCanvasHeight)
  const previewGridCellWidth =
    (previewGridWidth - GRID_MARGIN[0] * (GRID_COLS - 1) - GRID_CONTAINER_PADDING[0] * 2) /
    GRID_COLS
  const previewGridPitchX = previewGridCellWidth + GRID_MARGIN[0]
  const previewGridPitchY = ROW_HEIGHT + GRID_MARGIN[1]
  const previewLayoutById = useMemo(() => {
    const mapped = new Map<string, LayoutItem>()
    for (const entry of previewLayout) {
      mapped.set(entry.i, entry)
    }
    return mapped
  }, [previewLayout])
  const previewItems = useMemo(() => {
    if (!activePreviewDashboard) {
      return []
    }

    return [...activePreviewDashboard.items].sort((a, b) => {
      const aLayout = previewLayoutById.get(a.id)
      const bLayout = previewLayoutById.get(b.id)
      if (!aLayout || !bLayout) {
        return 0
      }

      if (aLayout.y === bLayout.y) {
        return aLayout.x - bLayout.x
      }

      return aLayout.y - bLayout.y
    })
  }, [activePreviewDashboard, previewLayoutById])

  const embeddedLayout = useMemo(
    () => (embeddedDashboard ? toLayoutItems(embeddedDashboard.layout) : []),
    [embeddedDashboard],
  )
  const embeddedLayoutById = useMemo(() => {
    const mapped = new Map<string, LayoutItem>()
    for (const entry of embeddedLayout) {
      mapped.set(entry.i, entry)
    }
    return mapped
  }, [embeddedLayout])
  const embeddedItems = useMemo(() => {
    if (!embeddedDashboard) {
      return []
    }

    return [...embeddedDashboard.items].sort((a, b) => {
      const aLayout = embeddedLayoutById.get(a.id)
      const bLayout = embeddedLayoutById.get(b.id)
      if (!aLayout || !bLayout) {
        return 0
      }

      if (aLayout.y === bLayout.y) {
        return aLayout.x - bLayout.x
      }

      return aLayout.y - bLayout.y
    })
  }, [embeddedDashboard, embeddedLayoutById])

  if (embedSlug) {
    const embedCanvasHeight = getCanvasHeightPx(embeddedLayout, viewportHeight, maxCanvasHeight)
    const embedGridCellWidth =
      (previewGridWidth - GRID_MARGIN[0] * (GRID_COLS - 1) - GRID_CONTAINER_PADDING[0] * 2) / GRID_COLS
    const embedGridPitchX = embedGridCellWidth + GRID_MARGIN[0]
    const embedGridPitchY = ROW_HEIGHT + GRID_MARGIN[1]

    return (
      <main className="min-h-screen bg-[#f5f7fb] px-4 py-4 text-slate-900">
        {embedLoadError ? (
          <div className="mx-auto mt-10 max-w-xl rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {embedLoadError}
          </div>
        ) : embeddedDashboard ? (
          <div className="mx-auto max-w-6xl space-y-4">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <h1 className="text-xl font-semibold text-slate-900">{embeddedDashboard.title}</h1>
            </div>

            <section
              className="relative overflow-hidden rounded-xl border border-slate-200 bg-[linear-gradient(#e8ebf1_1px,transparent_1px),linear-gradient(90deg,#e8ebf1_1px,transparent_1px)]"
              ref={previewGridContainerRef}
              style={{
                minHeight: `${embedCanvasHeight}px`,
                backgroundSize: `${embedGridPitchX}px ${embedGridPitchY}px`,
                backgroundPosition: `${GRID_CONTAINER_PADDING[0]}px ${GRID_CONTAINER_PADDING[1]}px`,
              }}
            >
              <GridLayout
                gridConfig={{
                  cols: GRID_COLS,
                  rowHeight: ROW_HEIGHT,
                  margin: GRID_MARGIN,
                  containerPadding: GRID_CONTAINER_PADDING,
                  maxRows: maxGridRows,
                }}
                dragConfig={{ enabled: false }}
                resizeConfig={{ enabled: false }}
                compactor={noCompactor}
                layout={embeddedLayout}
                width={previewGridWidth}
              >
                {embeddedItems.map((item) => (
                  <div
                    className="flex h-full flex-col rounded border border-slate-200 bg-white p-3 shadow-sm"
                    key={item.id}
                  >
                    {item.props.showTitle ? (
                      <p className="truncate text-sm font-semibold text-slate-700">
                        {item.props.title || 'Widget title'}
                      </p>
                    ) : null}
                    {item.props.showDescription ? (
                      <p className="mb-2 mt-1 text-xs text-slate-500">{item.props.description}</p>
                    ) : null}
                    <div className="min-h-0 flex-1">{renderVisualization(item, embeddedDashboard.datasets)}</div>
                  </div>
                ))}
              </GridLayout>
            </section>
          </div>
        ) : (
          <div className="mx-auto mt-10 max-w-xl rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            Loading embedded dashboard...
          </div>
        )}
      </main>
    )
  }

  return (
    <div className="min-h-screen overflow-hidden bg-[#f5f7fb] text-slate-900">
      <header className="flex min-h-[56px] items-center justify-between gap-3 border-b border-slate-200 bg-white px-4">
        <div className="flex min-w-0 items-center gap-3">
          <PanelLeft className="h-4 w-4 text-slate-500" />
          {viewMode === 'builder' ? (
            <div className="dbx-title-editor flex min-w-0 items-center rounded-lg border border-slate-200 bg-slate-50/85 px-2 py-1.5 transition hover:border-slate-300 hover:bg-white focus-within:border-sky-300 focus-within:bg-white focus-within:shadow-[0_0_0_3px_rgba(224,242,254,0.9)]">
              <input
                aria-label="Dashboard title"
                className="dbx-title-input"
                onChange={(event) => {
                  const value = event.target.value
                  setDashboardTitle(value)
                  setIsDirty(true)
                }}
                placeholder="Dashboard title"
                value={dashboardTitle}
              />
              <span className="dbx-title-hint pointer-events-none" aria-hidden="true">
                <Pencil className="h-3.5 w-3.5" />
              </span>
            </div>
          ) : (
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                {viewMode === 'catalog' ? 'Dashboards' : 'Preview'}
              </p>
              <p className="truncate text-lg font-semibold text-slate-900">
                {viewMode === 'preview' ? (activePreviewDashboard?.title ?? 'Dashboard Preview') : 'Dashboard Catalog'}
              </p>
            </div>
          )}
        </div>
        <motion.div
          className="flex max-w-[65vw] shrink-0 items-center gap-2 overflow-x-auto py-1"
          layout
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <motion.div
            className="dbx-header-mode-group flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1"
            layout
          >
            <Button
              onClick={() => setViewMode('catalog')}
              size="sm"
              variant={viewMode === 'catalog' ? 'default' : 'ghost'}
            >
              <LayoutGrid className="mr-1 h-4 w-4" />
              Dashboards
            </Button>
              <Button
                disabled={!canPreviewCurrent}
                onClick={openPreviewForCurrent}
              size="sm"
              variant={viewMode === 'preview' ? 'default' : 'ghost'}
            >
              <Eye className="mr-1 h-4 w-4" />
              Preview
            </Button>
            <Button
              onClick={() => setViewMode('builder')}
              size="sm"
              variant={viewMode === 'builder' ? 'default' : 'ghost'}
            >
              Builder
            </Button>
          </motion.div>

          <Button
            disabled={isSyncingFromGithub}
            onClick={() => {
              void syncDashboardsFromGithub(true)
            }}
            size="sm"
            variant="ghost"
          >
            <RefreshCw className={`h-4 w-4 ${isSyncingFromGithub ? 'animate-spin' : ''}`} />
            <span className="ml-1">Refresh</span>
          </Button>

          <Button className="gap-2" disabled={isSaving} onClick={handleSave} size="sm">
            <Save className="h-4 w-4" />
            {isSaving ? 'Saving...' : 'Save'}
          </Button>

          <Popover.Root onOpenChange={setIsActionsMenuOpen} open={isActionsMenuOpen}>
            <Popover.Trigger asChild>
              <Button aria-expanded={isActionsMenuOpen} aria-haspopup="menu" size="sm" variant="outline">
                File
                <motion.span
                  animate={{ rotate: isActionsMenuOpen ? 180 : 0 }}
                  className="ml-1 inline-flex"
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  <ChevronDown className="h-4 w-4" />
                </motion.span>
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <AnimatePresence>
                {isActionsMenuOpen ? (
                  <Popover.Content align="end" asChild side="bottom" sideOffset={8}>
                    <motion.div
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      className="dbx-header-menu z-40 w-44 rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg"
                      exit={{ opacity: 0, scale: 0.98, y: -6 }}
                      initial={{ opacity: 0, scale: 0.98, y: -6 }}
                      role="menu"
                      transformTemplate={({ scale }) => `scale(${scale ?? 1})`}
                      transition={{ duration: 0.14, ease: 'easeOut' }}
                    >
                      <button
                        className="dbx-header-menu-item"
                        onClick={() => {
                          setIsActionsMenuOpen(false)
                          handleDownloadYaml()
                        }}
                        role="menuitem"
                        type="button"
                      >
                        Export YAML
                      </button>
                      <button
                        className="dbx-header-menu-item"
                        onClick={openImportYamlPicker}
                        role="menuitem"
                        type="button"
                      >
                        Import YAML
                      </button>
                      <button
                        className="dbx-header-menu-item"
                        disabled={!hasSavedToGithub || isDirty}
                        onClick={() => setIsActionsMenuOpen(false)}
                        role="menuitem"
                        type="button"
                      >
                        Publish
                      </button>
                    </motion.div>
                  </Popover.Content>
                ) : null}
              </AnimatePresence>
            </Popover.Portal>
          </Popover.Root>

          <input
            accept=".yaml,.yml"
            className="hidden"
            onChange={handleImportYaml}
            ref={importYamlInputRef}
            type="file"
          />
        </motion.div>
      </header>

      {viewMode === 'builder' ? (
        <div
          className="grid min-h-[calc(100vh-56px)] overflow-hidden transition-[grid-template-columns] duration-200 ease-out"
          style={{
            gridTemplateColumns: `${leftPanelWidth}px minmax(0,1fr) ${rightPanelWidth}px`,
          }}
        >
        <aside className="overflow-hidden border-r border-slate-200 bg-white transition-all duration-200 ease-out">
          {leftPanelOpen ? (
            <>
              <div className="border-b border-slate-200 bg-slate-50/50 px-4 py-3">
                <div className="flex items-center gap-2">
                  <button
                    className={`rounded-md px-2.5 py-1.5 text-sm transition ${
                      leftTab === 'data'
                        ? 'dbx-tab-active'
                        : 'text-slate-600 hover:bg-white hover:text-slate-700'
                    }`}
                    onClick={() => setLeftTab('data')}
                    type="button"
                  >
                    Data
                  </button>
                  <button
                    className={`rounded-md px-2.5 py-1.5 text-sm transition ${
                      leftTab === 'filters'
                        ? 'dbx-tab-active'
                        : 'text-slate-600 hover:bg-white hover:text-slate-700'
                    }`}
                    onClick={() => setLeftTab('filters')}
                    type="button"
                  >
                    Filters
                  </button>
                  <div className="ml-auto">
                    <Button
                      onClick={() => setLeftPanelOpenWithTransition(false)}
                      size="sm"
                      variant="ghost"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

              {leftTab === 'filters' ? (
                <div className="px-4 py-3">
                  <div className="flex items-center gap-2 text-slate-700">
                    <Filter className="h-4 w-4" />
                    <h3 className="text-sm font-semibold">Global Filters</h3>
                  </div>
                  <p className="dbx-empty-hint mt-3 text-sm">No global filters configured.</p>
                  <Button className="mt-4" size="sm" variant="outline">
                    <Plus className="mr-1 h-4 w-4" />
                    Add filter
                  </Button>
                </div>
              ) : (
                <>
                  <div className="px-4 py-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Datasets
                      </h3>
                      <Button
                        onClick={() => {
                          setDatasetStatus('')
                          setDatasetPreviewSql('')
                          setHasRunDatasetPreview(false)
                          setShowDatasetEditor(true)
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    {datasets.length === 0 ? (
                      <p className="dbx-empty-hint mt-3 text-sm">Add datasets with stored SQL queries.</p>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {datasets.map((dataset) => (
                          <div
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
                            key={dataset.id}
                          >
                            <div className="flex items-center justify-between">
                              <p className="text-sm font-medium text-slate-700">{dataset.name}</p>
                              {dataset.validationStatus === 'valid' ? (
                                <Check className="h-4 w-4 text-emerald-600" />
                              ) : (
                                <X className="h-4 w-4 text-red-600" />
                              )}
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-slate-500">{dataset.sql}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="border-t border-slate-200 px-4 py-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Visualizations
                    </h3>
                    <div className="mt-3 space-y-2">
                      {visualizationPalette.map((entry) => {
                        const Icon = entry.icon
                        return (
                          <button
                            className="dbx-viz-option dbx-clickable group flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700"
                            key={entry.type}
                            onClick={() => addItem(entry.type)}
                            type="button"
                          >
                            <span className="dbx-viz-icon-chip rounded-md border border-slate-200 bg-slate-50 p-1.5 transition">
                              <Icon className="dbx-viz-icon h-4 w-4" />
                            </span>
                            <span className="font-medium">{entry.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="flex h-full flex-col items-center pt-3">
              <Button onClick={() => setLeftPanelOpenWithTransition(true)} size="sm" variant="ghost">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </aside>

        <section
          className={`relative h-[calc(100vh-56px)] bg-[#fafbfc] ${
            isPanelTransitioning
              ? 'overflow-x-hidden overflow-y-hidden'
              : 'overflow-x-hidden overflow-y-auto'
          }`}
        >
          <div
            ref={gridContainerRef}
            className="relative bg-[linear-gradient(#e8ebf1_1px,transparent_1px),linear-gradient(90deg,#e8ebf1_1px,transparent_1px)] [background-size:62px_62px]"
            style={{
              minHeight: `${canvasHeight}px`,
              backgroundSize: `${gridPitchX}px ${gridPitchY}px`,
              backgroundPosition: `${GRID_CONTAINER_PADDING[0]}px ${GRID_CONTAINER_PADDING[1]}px`,
            }}
          >
            <GridLayout
              gridConfig={{
                cols: GRID_COLS,
                rowHeight: ROW_HEIGHT,
                margin: GRID_MARGIN,
                containerPadding: GRID_CONTAINER_PADDING,
                maxRows: maxGridRows,
              }}
              compactor={noCompactor}
              dragConfig={{
                cancel: 'input,textarea,select,button,option',
              }}
              layout={layout}
              onDragStart={(_nextLayout, _oldItem, newItem) => {
                activeInteractionIdRef.current = newItem?.i ?? null
              }}
              onDrag={(nextLayout, _oldItem, newItem) => {
                const activeId = newItem?.i ?? activeInteractionIdRef.current
                setLayout(resolveCollisions([...nextLayout], activeId ?? null))
              }}
              onDragStop={(nextLayout, _oldItem, newItem) => {
                activeInteractionIdRef.current = null
                pushHistory()
                setIsDirty(true)
                setLayout(resolveCollisions([...nextLayout], newItem?.i ?? null))
              }}
              onLayoutChange={(nextLayout) => {
                if (activeInteractionIdRef.current) {
                  return
                }
                setLayout([...nextLayout])
              }}
              onResizeStart={(_nextLayout, _oldItem, newItem) => {
                activeInteractionIdRef.current = newItem?.i ?? null
              }}
              onResize={(nextLayout, _oldItem, newItem) => {
                const activeId = newItem?.i ?? activeInteractionIdRef.current
                setLayout(resolveCollisions([...nextLayout], activeId ?? null))
              }}
              onResizeStop={(nextLayout, _oldItem, newItem) => {
                activeInteractionIdRef.current = null
                pushHistory()
                setIsDirty(true)
                setLayout(resolveCollisions([...nextLayout], newItem?.i ?? null))
              }}
              resizeConfig={{
                enabled: true,
                handles: ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'],
              }}
              width={gridWidth}
            >
              {items.map((item) => (
                <div
                  className={`dbx-clickable flex h-full cursor-pointer flex-col rounded border bg-white p-3 shadow-sm transition ${
                    selectedId === item.id
                      ? 'dbx-selected-card'
                      : 'border-slate-200'
                  }`}
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="mb-2 flex items-center justify-between">
                    {item.props.showTitle ? (
                      selectedId === item.id && inlineEditor?.itemId === item.id && inlineEditor.field === 'title' ? (
                        <input
                          autoFocus
                          className="w-full rounded border border-slate-300 px-1 py-0.5 text-sm font-semibold text-slate-700 outline-none"
                          onBlur={() => setInlineEditor(null)}
                          onChange={(event) => {
                            setIsDirty(true)
                            setItems((previous) =>
                              previous.map((entry) =>
                                entry.id === item.id
                                  ? {
                                      ...entry,
                                      props: { ...entry.props, title: event.target.value },
                                    }
                                  : entry,
                              ),
                            )
                          }}
                          onClick={(event) => event.stopPropagation()}
                          value={item.props.title}
                        />
                      ) : (
                        <button
                          className="truncate text-left text-sm font-semibold text-slate-700 hover:underline"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedId(item.id)
                            beginInlineEdit(item.id, 'title')
                          }}
                          type="button"
                        >
                          {item.props.title || 'Widget title'}
                        </button>
                      )
                    ) : (
                      <div />
                    )}
                    <span className="text-[11px] uppercase text-slate-400">{item.type}</span>
                  </div>
                  {item.props.showDescription ? (
                    selectedId === item.id && inlineEditor?.itemId === item.id && inlineEditor.field === 'description' ? (
                      <textarea
                        autoFocus
                        className="mb-2 h-12 w-full resize-none rounded border border-slate-300 px-1 py-0.5 text-xs text-slate-500 outline-none"
                        onBlur={() => setInlineEditor(null)}
                          onChange={(event) => {
                            setIsDirty(true)
                            setItems((previous) =>
                              previous.map((entry) =>
                              entry.id === item.id
                                ? {
                                    ...entry,
                                    props: { ...entry.props, description: event.target.value },
                                  }
                                : entry,
                            ),
                          )
                        }}
                        onClick={(event) => event.stopPropagation()}
                        value={item.props.description ?? ''}
                      />
                    ) : (
                      <button
                        className="mb-2 block text-left text-xs text-slate-500 hover:underline"
                        onClick={(event) => {
                          event.stopPropagation()
                          setSelectedId(item.id)
                          beginInlineEdit(item.id, 'description')
                        }}
                        type="button"
                      >
                        {item.props.description?.trim() || 'Description'}
                      </button>
                    )
                  ) : null}
                  <div className="min-h-0 flex-1">{renderVisualization(item, datasets)}</div>
                </div>
              ))}
            </GridLayout>

            {items.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center p-6">
                <div className="dbx-empty-state relative mx-auto flex h-[90vh] w-[90vw] items-center justify-center overflow-hidden rounded-xl border border-slate-200 text-sm text-slate-600">
                  <div className="pointer-events-none absolute -left-16 top-12 h-44 w-44 rounded-full bg-white/50 blur-2xl" />
                  <div className="pointer-events-none absolute bottom-10 right-8 h-52 w-52 rounded-full bg-[rgba(217,234,251,0.7)] blur-3xl" />
                  <div className="relative z-10 w-full max-w-2xl rounded-2xl border border-white/60 bg-white/75 p-6 shadow-xl backdrop-blur">
                    <div className="mb-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                        Start Building
                      </p>
                      <h3 className="mt-2 text-2xl font-semibold text-slate-800">
                        Pick your first visualization
                      </h3>
                      <p className="mt-2 text-sm text-slate-600">
                        Add a widget from the list below, then drag and resize it directly on the canvas.
                      </p>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      {visualizationPalette.map((entry) => {
                        const Icon = entry.icon
                        return (
                          <button
                            className="dbx-clickable group flex items-center gap-3 rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-left transition hover:border-sky-400 hover:bg-sky-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
                            key={entry.type}
                            onClick={() => addItem(entry.type)}
                            type="button"
                          >
                            <span className="rounded-md border border-slate-200 bg-white p-2 text-sky-700 transition group-hover:border-sky-300 group-hover:bg-sky-100/80">
                              <Icon className="h-4 w-4" />
                            </span>
                            <span className="text-sm font-medium text-slate-700">{entry.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="pointer-events-none fixed bottom-4 left-1/2 z-20 -translate-x-1/2">
            <div className="dbx-fab pointer-events-auto flex items-center gap-2 rounded-md px-3 py-2 text-white shadow-lg">
              <Button className="dbx-fab-btn" disabled={!history.length} onClick={handleUndo} size="sm" variant="ghost">
                <RotateCcw className="h-4 w-4 text-white" />
              </Button>
              <Button className="dbx-fab-btn" disabled={!future.length} onClick={handleRedo} size="sm" variant="ghost">
                <RotateCw className="h-4 w-4 text-white" />
              </Button>
              <Button
                className="dbx-fab-btn"
                disabled={!selectedItem}
                onClick={removeSelected}
                size="sm"
                variant="ghost"
              >
                <Trash2 className="h-4 w-4 text-white/80 transition hover:text-white" />
              </Button>
            </div>
          </div>
        </section>

        <aside
          className={`h-[calc(100vh-56px)] overflow-x-hidden border-l border-slate-200 bg-white transition-all duration-200 ${
            rightPanelOpen
              ? isPanelTransitioning
                ? 'overflow-y-hidden px-4 py-3'
                : 'overflow-y-auto px-4 py-3'
              : 'overflow-y-hidden px-1 py-3'
          }`}
        >
          {rightPanelOpen ? (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-800">Widget</h2>
                <Button onClick={() => setRightPanelOpenWithTransition(false)} size="sm" variant="ghost">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
            <div className="flex items-center gap-4 text-sm text-slate-700">
              <label className="flex items-center gap-2">
                <input
                  className="dbx-check"
                  checked={selectedItem?.props.showTitle ?? false}
                  disabled={!selectedItem}
                  onChange={(event) => setShowTitle(event.target.checked)}
                  type="checkbox"
                />
                Title
              </label>
              <label className="flex items-center gap-2">
                <input
                  className="dbx-check"
                  checked={selectedItem?.props.showDescription ?? false}
                  disabled={!selectedItem}
                  onChange={(event) => setShowDescription(event.target.checked)}
                  type="checkbox"
                />
                Description
              </label>
            </div>
          </div>

          {selectedItem ? (
            <div className="space-y-4 py-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">Selected Widget</h3>
                <Button className="dbx-clickable" onClick={removeSelected} size="sm" variant="destructive">
                  <Trash2 className="mr-1 h-4 w-4" />
                  Remove
                </Button>
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-slate-700">Title</label>
                <input
                  className="dbx-field"
                  disabled={!selectedItem.props.showTitle}
                  onChange={(event) => updateSelected({ title: event.target.value }, false)}
                  onFocus={() => pushHistory()}
                  placeholder="Widget title"
                  value={selectedItem.props.title}
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-700">
                  Visualization
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {visualizationPalette.map((entry) => {
                    const Icon = entry.icon
                    const isActive = selectedItem.type === entry.type
                    return (
                      <button
                        className={`dbx-clickable group flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 ${
                          isActive
                            ? 'border-sky-500 bg-sky-50 text-sky-800 shadow-[0_0_0_1px_rgba(14,116,144,0.2)]'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-sky-400 hover:bg-sky-50/70'
                        }`}
                        key={entry.type}
                        onClick={() => switchSelectedVisualization(entry.type)}
                        type="button"
                      >
                        <span
                          className={`rounded-md border p-1.5 transition ${
                            isActive
                              ? 'border-sky-300 bg-sky-100 text-sky-700'
                              : 'border-slate-200 bg-slate-50 text-slate-600 group-hover:border-sky-300 group-hover:bg-sky-100 group-hover:text-sky-700'
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="font-medium">{entry.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {selectedItem.props.showDescription ? (
                <div>
                  <label className="mb-1 block text-sm font-semibold text-slate-700">Description</label>
                  <textarea
                    className="dbx-field h-20"
                    onChange={(event) => updateSelected({ description: event.target.value }, false)}
                    onFocus={() => pushHistory()}
                    placeholder="Description"
                    value={selectedItem.props.description ?? ''}
                  />
                </div>
              ) : null}

              {selectedItem.type === 'text-box' ? (
                <div>
                  <label className="mb-1 block text-sm font-semibold text-slate-700">
                    Text Content
                  </label>
                  <textarea
                    className="dbx-field h-36"
                    onChange={(event) => updateSelected({ textContent: event.target.value })}
                    value={selectedItem.props.textContent ?? ''}
                  />
                </div>
              ) : (
                <>
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">Dataset</label>
                    <select
                      className="dbx-field"
                      onChange={(event) =>
                        updateSelected({
                          datasetId: event.target.value,
                          coordinates: {},
                        }, false)
                      }
                      onFocus={startFormEditing}
                      onBlur={endFormEditing}
                      value={selectedItem.props.datasetId ?? ''}
                    >
                      <option value="">Select a dataset</option>
                      {datasets.map((dataset) => (
                        <option key={dataset.id} value={dataset.id}>
                          {dataset.name}
                        </option>
                      ))}
                    </select>
                    {selectedItem.props.datasetId ? (
                      selectedDatasetError ? (
                        <p className="mt-1 text-xs text-red-600">{selectedDatasetError}</p>
                      ) : datasetFieldNames.length === 0 ? (
                        <p className="mt-1 text-xs text-slate-500">
                          {selectedDatasetLoading ? 'Loading fields from query...' : 'No fields found for this dataset.'}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-slate-500">{datasetFieldNames.length} field(s) available.</p>
                      )
                    ) : null}
                  </div>

                  {selectedItem.type === 'line-chart' ? (
                    <div className="space-y-3">
                      <div>
                        <label className="mb-1 block text-sm font-semibold text-slate-700">X axis</label>
                        <select
                          className="dbx-field"
                          onChange={(event) => {
                            startFormEditing()
                            updateCoordinate('xField', event.target.value)
                          }}
                          onBlur={endFormEditing}
                          value={selectedItem.props.coordinates.xField ?? ''}
                        >
                          <option value="">Select field</option>
                          {datasetFieldNames.map((columnName) => (
                            <option key={columnName} value={columnName}>
                              {columnName}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-sm font-semibold text-slate-700">Y axis</label>
                        <select
                          className="dbx-field"
                          onChange={(event) => {
                            startFormEditing()
                            updateCoordinate('yField', event.target.value)
                          }}
                          onBlur={endFormEditing}
                          value={selectedItem.props.coordinates.yField ?? ''}
                        >
                          <option value="">Select field</option>
                          {datasetFieldNames.map((columnName) => (
                            <option key={columnName} value={columnName}>
                              {columnName}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-sm font-semibold text-slate-700">Color (optional)</label>
                        <select
                          className="dbx-field"
                          onChange={(event) => {
                            startFormEditing()
                            updateCoordinate('colorField', event.target.value)
                          }}
                          onBlur={endFormEditing}
                          value={selectedItem.props.coordinates.colorField ?? ''}
                        >
                          <option value="">None</option>
                          {datasetFieldNames.map((columnName) => (
                            <option key={columnName} value={columnName}>
                              {columnName}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ) : null}

                  {selectedItem.type === 'metric-gauge' ? (
                    <div>
                      <label className="mb-1 block text-sm font-semibold text-slate-700">Value</label>
                      <select
                        className="dbx-field"
                        onChange={(event) => {
                          startFormEditing()
                          updateCoordinate('valueField', event.target.value)
                        }}
                        onBlur={endFormEditing}
                        value={selectedItem.props.coordinates.valueField ?? ''}
                      >
                        <option value="">Select field</option>
                        {datasetFieldNames.map((columnName) => (
                          <option key={columnName} value={columnName}>
                            {columnName}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  {selectedItem.type === 'data-table' ? (
                    <div className="space-y-3">
                      <div>
                        <label className="mb-1 block text-sm font-semibold text-slate-700">Add columns</label>
                        <div className="max-h-36 space-y-1 overflow-auto rounded-lg border border-slate-200 bg-white p-2">
                          {datasetFieldNames.length === 0 ? (
                            <p className="text-xs text-slate-500">No fields available.</p>
                          ) : (
                            datasetFieldNames.map((columnName) => {
                              const checked = selectedTableColumns.includes(columnName)
                              return (
                                <label
                                  className="flex items-center gap-2 rounded px-1 py-1 text-sm text-slate-700 hover:bg-slate-50"
                                  key={`column-toggle-${columnName}`}
                                >
                                  <input
                                    checked={checked}
                                    onChange={(event) => {
                                      startFormEditing()
                                      const nextColumns = event.target.checked
                                        ? mergeUniqueColumns([...selectedTableColumns, columnName])
                                        : selectedTableColumns.filter((entry) => entry !== columnName)
                                      updateSelected(
                                        {
                                          coordinates: {
                                            ...selectedItem.props.coordinates,
                                            tableColumns: nextColumns,
                                          },
                                        },
                                        false,
                                      )
                                      endFormEditing()
                                    }}
                                    type="checkbox"
                                  />
                                  <span className="inline-flex h-5 w-5 items-center justify-center rounded border border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-500">
                                    {getFieldTypeLabel(
                                      datasetColumns.find((column) => column.name === columnName)?.type ?? 'STRING',
                                    )}
                                  </span>
                                  <span className="truncate">{columnName}</span>
                                </label>
                              )
                            })
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Columns</p>
                        <span className="text-xs text-slate-500">{selectedTableColumns.length} selected</span>
                      </div>

                      <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50/40 p-2">
                        {selectedTableColumns.length === 0 ? (
                          <p className="px-1 py-1 text-xs text-slate-500">
                            No columns selected. Table currently shows all dataset fields.
                          </p>
                        ) : (
                          selectedTableColumns.map((columnName, columnIndex) => (
                            <div
                              className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-2 py-1.5"
                              draggable
                              key={columnName}
                              onDragOver={(event) => {
                                event.preventDefault()
                              }}
                              onDragStart={() => {
                                setDraggingTableColumn(columnName)
                              }}
                              onDrop={() => {
                                if (!draggingTableColumn || draggingTableColumn === columnName) {
                                  return
                                }
                                startFormEditing()
                                const sourceIndex = selectedTableColumns.indexOf(draggingTableColumn)
                                if (sourceIndex < 0) {
                                  return
                                }
                                const nextColumns = [...selectedTableColumns]
                                nextColumns.splice(sourceIndex, 1)
                                nextColumns.splice(columnIndex, 0, draggingTableColumn)
                                updateSelected(
                                  {
                                    coordinates: {
                                      ...selectedItem.props.coordinates,
                                      tableColumns: nextColumns,
                                    },
                                  },
                                  false,
                                )
                                setDraggingTableColumn(null)
                                endFormEditing()
                              }}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="text-xs text-slate-400">::</span>
                                <span className="inline-flex h-5 w-5 items-center justify-center rounded border border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-500">
                                  {getFieldTypeLabel(
                                    datasetColumns.find((column) => column.name === columnName)?.type ?? 'STRING',
                                  )}
                                </span>
                                <span className="truncate text-sm text-slate-700">{columnName}</span>
                              </div>
                              <button
                                className="rounded px-1.5 py-0.5 text-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                                onClick={() => {
                                  startFormEditing()
                                  const nextColumns = selectedTableColumns.filter((entry) => entry !== columnName)
                                  updateSelected(
                                    {
                                      coordinates: {
                                        ...selectedItem.props.coordinates,
                                        tableColumns: nextColumns,
                                      },
                                    },
                                    false,
                                  )
                                  endFormEditing()
                                }}
                                type="button"
                              >
                                Remove
                              </button>
                            </div>
                          ))
                        )}
                      </div>

                      <div className="flex items-center justify-between">
                        <button
                          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                          onClick={() => {
                            startFormEditing()
                            updateSelected(
                              {
                                coordinates: {
                                  ...selectedItem.props.coordinates,
                                  tableColumns: datasetFieldNames,
                                },
                              },
                              false,
                            )
                            endFormEditing()
                          }}
                          type="button"
                        >
                          Add all remaining
                        </button>
                        <button
                          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                          onClick={() => {
                            startFormEditing()
                            updateSelected(
                              {
                                coordinates: {
                                  ...selectedItem.props.coordinates,
                                  tableColumns: [],
                                },
                              },
                              false,
                            )
                            endFormEditing()
                          }}
                          type="button"
                        >
                          Clear selection
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {missingRequiredAxis.length > 0 ? (
                    <div className="rounded border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                      Missing required coordinates for {selectedItem.type}:{' '}
                      {missingRequiredAxis.join(', ')}.
                    </div>
                  ) : (
                    <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                      Coordinate mapping valid for {selectedItem.type}.
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <p className="dbx-empty-hint mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-sm">
              Select a widget to configure dataset and coordinates.
            </p>
          )}

              {saveStatus ? <p className="mt-2 text-xs text-slate-500">{saveStatus}</p> : null}
              <p className="mt-3 text-[11px] text-slate-400">
                Canvas limit: {CANVAS_PAGES} pages ({Math.round(maxCanvasHeight)}px total height).
              </p>
            </>
          ) : (
            <div className="flex h-full flex-col items-center gap-3 pt-2">
              <Button onClick={() => setRightPanelOpenWithTransition(true)} size="sm" variant="ghost">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="rotate-180 text-[10px] tracking-[0.2em] text-slate-400 [writing-mode:vertical-rl]">
                WIDGET
              </span>
            </div>
          )}
        </aside>
      </div>
      ) : viewMode === 'catalog' ? (
        <main className="h-[calc(100vh-56px)] overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-6xl space-y-6">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                  Dashboards
                </p>
                <h2 className="mt-1 text-2xl font-semibold text-slate-900">Published and Draft Dashboards</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Select a dashboard to edit in Builder or open full-screen user preview.
                </p>
                {lastGithubSyncAt ? (
                  <p className="mt-1 text-xs text-slate-500">GitHub sync: {formatUpdatedAt(lastGithubSyncAt)}</p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={isSyncingFromGithub}
                  onClick={() => {
                    void syncDashboardsFromGithub(true)
                  }}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw className={`mr-1 h-4 w-4 ${isSyncingFromGithub ? 'animate-spin' : ''}`} />
                  Sync from GitHub
                </Button>
                <Button onClick={() => setViewMode('builder')} size="sm" variant="outline">
                  Open Builder
                </Button>
              </div>
            </div>

            {savedDashboards.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
                <p className="text-lg font-semibold text-slate-800">No saved dashboards yet</p>
                <p className="mt-2 text-sm text-slate-600">
                  Save a dashboard in Builder to make it available for preview and reuse.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {savedDashboards.map((dashboard) => (
                  <article
                    className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-sky-300 hover:shadow-md"
                    key={dashboard.slug}
                  >
                    <p className="text-xs font-semibold uppercase tracking-[0.11em] text-slate-500">
                      {dashboard.slug}
                    </p>
                    <h3 className="mt-1 line-clamp-2 text-lg font-semibold text-slate-900">
                      {dashboard.title}
                    </h3>
                    <p className="mt-2 text-xs text-slate-500">Updated {formatUpdatedAt(dashboard.updatedAt)}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <span className="rounded-full bg-slate-100 px-2 py-1">
                        {dashboard.items.length} widget{dashboard.items.length === 1 ? '' : 's'}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-1">
                        {dashboard.datasets.length} dataset{dashboard.datasets.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="mt-4 space-y-2">
                      <div className="flex gap-2">
                        <Button
                          className="flex-1"
                          onClick={() => loadDashboardIntoBuilder(dashboard)}
                          size="sm"
                          variant="outline"
                        >
                          Edit
                        </Button>
                        <Button
                          className="flex-1"
                          onClick={() => openPreview(dashboard.slug)}
                          size="sm"
                        >
                          <Eye className="mr-1 h-4 w-4" />
                          Preview
                        </Button>
                        <Button
                          className="flex-1"
                          disabled={isCreatingEmbed}
                          onClick={() => handleCopyEmbedLink(dashboard.slug)}
                          size="sm"
                          variant="outline"
                        >
                          <Copy className="mr-1 h-4 w-4" />
                          Embed
                        </Button>
                      </div>
                      <Button
                        className="w-full"
                        onClick={() => handleDeleteSavedDashboard(dashboard.slug, dashboard.title)}
                        size="sm"
                        variant="destructive"
                      >
                        <Trash2 className="mr-1 h-4 w-4" />
                        Delete dashboard
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {embedStatus ? (
              <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
                {embedStatus}
              </p>
            ) : null}
            {githubSyncStatus ? (
              <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
                {githubSyncStatus}
              </p>
            ) : null}
          </div>
        </main>
      ) : (
        <main className="h-[calc(100vh-56px)] overflow-y-auto bg-[#f5f7fb] px-6 py-6">
          {activePreviewDashboard ? (
            <div className="mx-auto max-w-6xl space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.11em] text-slate-500">
                    Viewer Mode
                  </p>
                  <h2 className="text-2xl font-semibold text-slate-900">{activePreviewDashboard.title}</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Last updated {formatUpdatedAt(activePreviewDashboard.updatedAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      loadDashboardIntoBuilder(activePreviewDashboard)
                    }}
                    size="sm"
                    variant="outline"
                  >
                    Edit in Builder
                  </Button>
                  <Button onClick={() => setViewMode('catalog')} size="sm" variant="outline">
                    Back to List
                  </Button>
                </div>
              </div>

              <section
                className="relative overflow-hidden rounded-xl border border-slate-200 bg-[linear-gradient(#e8ebf1_1px,transparent_1px),linear-gradient(90deg,#e8ebf1_1px,transparent_1px)] [background-size:62px_62px] p-0"
                ref={previewGridContainerRef}
                style={{
                  minHeight: `${previewCanvasHeight}px`,
                  backgroundSize: `${previewGridPitchX}px ${previewGridPitchY}px`,
                  backgroundPosition: `${GRID_CONTAINER_PADDING[0]}px ${GRID_CONTAINER_PADDING[1]}px`,
                }}
              >
                <GridLayout
                  gridConfig={{
                    cols: GRID_COLS,
                    rowHeight: ROW_HEIGHT,
                    margin: GRID_MARGIN,
                    containerPadding: GRID_CONTAINER_PADDING,
                    maxRows: maxGridRows,
                  }}
                  dragConfig={{ enabled: false }}
                  resizeConfig={{ enabled: false }}
                  compactor={noCompactor}
                  layout={previewLayout}
                  width={previewGridWidth}
                >
                  {previewItems.map((item) => (
                    <div
                      className="flex h-full flex-col rounded border border-slate-200 bg-white p-3 shadow-sm"
                      key={item.id}
                    >
                      {item.props.showTitle ? (
                        <p className="truncate text-sm font-semibold text-slate-700">
                          {item.props.title || 'Widget title'}
                        </p>
                      ) : null}
                      {item.props.showDescription ? (
                        <p className="mb-2 mt-1 text-xs text-slate-500">{item.props.description}</p>
                      ) : null}
                      <div className="min-h-0 flex-1">
                        {renderVisualization(item, activePreviewDashboard.datasets)}
                      </div>
                    </div>
                  ))}
                </GridLayout>
              </section>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
              <p className="text-lg font-semibold text-slate-900">Dashboard preview not found</p>
              <p className="mt-2 text-sm text-slate-600">
                Choose a dashboard from the list to open its user-mode preview.
              </p>
              <Button className="mt-4" onClick={() => setViewMode('catalog')} size="sm">
                Back to Dashboards
              </Button>
            </div>
          )}
        </main>
      )}

      {showDatasetEditor ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-950/35">
          <div className="w-[760px] rounded-lg border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Create Dataset</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Add a stored query for this dashboard and validate schema columns.
                </p>
              </div>
              <button
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                onClick={() => {
                  setShowDatasetEditor(false)
                  setDatasetPreviewSql('')
                  setHasRunDatasetPreview(false)
                }}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label
                  className="mb-1 block text-sm font-medium text-slate-700"
                  htmlFor="dataset-name"
                >
                  Dataset name
                </label>
                <input
                  className="dbx-field"
                  id="dataset-name"
                  onChange={(event) => setDatasetName(event.target.value)}
                  placeholder="Orders by region"
                  value={datasetName}
                />
              </div>

              <div>
                <label
                  className="mb-1 block text-sm font-medium text-slate-700"
                  htmlFor="dataset-sql"
                >
                  SQL query
                </label>
                <textarea
                  className="dbx-field h-40"
                  id="dataset-sql"
                  onChange={(event) => {
                    setDatasetSql(event.target.value)
                    setHasRunDatasetPreview(false)
                  }}
                  value={datasetSql}
                />
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Query preview</p>
                  <div className="flex items-center gap-2 text-xs text-slate-600">
                    <Button
                      disabled={datasetPreviewLoading || !datasetSql.trim()}
                      onClick={runDatasetPreview}
                      size="sm"
                      variant="outline"
                    >
                      {datasetPreviewLoading ? 'Running...' : 'Run'}
                    </Button>
                    <label htmlFor="dataset-preview-limit">Rows</label>
                    <select
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                      id="dataset-preview-limit"
                      onChange={(event) => setDatasetPreviewLimit(Number(event.target.value) || 5)}
                      value={datasetPreviewLimit}
                    >
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                    </select>
                  </div>
                </div>

                {datasetPreviewError ? (
                  <p className="text-xs text-red-600">{datasetPreviewError}</p>
                ) : datasetPreviewLoading ? (
                  <p className="text-xs text-slate-500">Running query preview...</p>
                ) : !hasRunDatasetPreview ? (
                  <p className="text-xs text-slate-500">Click Run to preview example data.</p>
                ) : datasetPreviewColumns.length === 0 ? (
                  <p className="text-xs text-slate-500">No columns returned yet. Update SQL to preview data.</p>
                ) : (
                  <div className="max-h-56 overflow-auto rounded border border-slate-200 bg-white">
                    <table className="min-w-full text-left text-xs">
                      <thead className="bg-slate-100 text-slate-600">
                        <tr>
                          {datasetPreviewColumns.map((column) => (
                            <th className="px-2 py-1.5 font-semibold" key={column}>
                              {column}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {datasetPreviewDisplayRows.length > 0 ? (
                          datasetPreviewDisplayRows.map((row, rowIndex) => (
                            <tr className="border-t border-slate-100" key={`dataset-preview-row-${rowIndex}`}>
                              {datasetPreviewColumns.map((column) => (
                                <td className="px-2 py-1.5 text-slate-700" key={`${rowIndex}-${column}`}>
                                  {String(row[column] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td className="px-2 py-2 text-slate-500" colSpan={datasetPreviewColumns.length}>
                              Query returned no rows.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Database className="h-3.5 w-3.5" />
                Query validation checks SQL and infers available columns.
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setShowDatasetEditor(false)
                    setDatasetPreviewSql('')
                    setHasRunDatasetPreview(false)
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button disabled={isValidatingDataset || !canSaveDataset} onClick={createDataset} size="sm">
                  {isValidatingDataset ? 'Saving...' : 'Save Dataset'}
                </Button>
              </div>
            </div>

            {datasetStatus ? <p className="mt-3 text-xs text-slate-500">{datasetStatus}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
