# Databricks Custom Dashboard Builder

This project is the dashboard builder app (Vite + React + Storybook) that lets users compose dashboards, bind SQL queries, and save dashboard YAML specs into GitHub slug folders.

## What is implemented in this step

- Databricks-style builder layout with top command bar and three-pane editor.
- Four visualization blocks: line chart, data table, metric gauge, text box.
- Resizable/reorderable dashboard widgets using `react-grid-layout`.
- Dataset manager with SQL validation endpoint before adding datasets.
- Coordinate mapping controls (X axis, Y axis, Value) per visualization widget.
- Coordinate requirement validation based on visualization type.
- Dashboard title + slug editing.
- Save flow to GitHub path: `dashboards/{slug}/dashboard.yaml`.
- YAML import/export in the builder toolbar.
- Embed link generation from catalog cards (tokenized URL via backend).
- FastAPI backend proxy scaffold for Databricks SQL statement execution.
- Storybook setup with stories for all current visualization components.
- Shared visualization registry so dashboard + Storybook stay in sync.

## Project structure

- `src/App.tsx` - Main builder UI.
- `src/components/visualizations/*` - Reusable visualization components.
- `src/components/visualizations/registry.tsx` - Visualization catalog and runtime renderer used by the builder.
- `src/lib/github.ts` - GitHub save integration through Octokit.
- `src/lib/types.ts` - Layout and widget schema.
- `backend/app.py` - FastAPI backend with `/api/query` and `/api/validate-query` endpoints.
- `.github/workflows/deploy-dashboard.yml` - Workflow dispatch scaffold.

## Environment variables

Copy `.env.example` to `.env` and fill in values.

Frontend values (Vite):

- `VITE_GITHUB_TOKEN`
- `VITE_GITHUB_OWNER`
- `VITE_GITHUB_REPO`
- `VITE_GITHUB_BRANCH` (optional, default `main`)
- `VITE_API_BASE_URL` (optional, defaults to relative path)

Backend values:

- `DATABRICKS_HOST`
- `DATABRICKS_TOKEN`
- `DATABRICKS_WAREHOUSE_ID`

If backend Databricks env vars are missing, `/api/query` returns mock data so UI development can continue.
`/api/validate-query` also falls back to mock schema columns in that case.

## Run locally

Install frontend dependencies:

```bash
npm install
```

Run frontend:

```bash
npm run dev
```

Run Storybook:

```bash
npm run storybook
```

## Storybook visualization workflow

- Add or update visualization components in `src/components/visualizations`.
- Add a matching `*.stories.tsx` file so designers can iterate in Storybook.
- Register the visualization in `src/components/visualizations/registry.tsx` to expose it in the dashboard builder palette.

### Add a new visualization (template)

1. Create component file:

```tsx
// src/components/visualizations/my-viz.tsx
interface MyVizProps {
  sql: string
  refreshMs: number
}

export function MyViz({ sql, refreshMs }: MyVizProps) {
  return <div>TODO visualization using {sql} ({refreshMs}ms)</div>
}
```

2. Create Storybook story:

```tsx
// src/components/visualizations/my-viz.stories.tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { MyViz } from './my-viz'

const meta = {
  title: 'Visualizations/MyViz',
  component: MyViz,
  args: {
    sql: 'SELECT * FROM my_catalog.my_schema.my_table LIMIT 20',
    refreshMs: 30000,
  },
  decorators: [
    (Story) => (
      <div style={{ width: '640px', height: '360px', border: '1px solid #e2e8f0', padding: '12px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MyViz>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
```

3. Register in `src/components/visualizations/registry.tsx`:

- Add a new `visualizationPalette` entry (`type`, `label`, `icon`, `requiredCoordinates`).
- Add a render branch in `renderVisualization(...)` to mount the component.

4. Wire type definitions:

- Add the new type to `VizType` in `src/lib/types.ts`.
- Add any new coordinate fields to `VizCoordinates` in `src/lib/types.ts` if needed.
- Add default values in `createDefaultItem(...)` in `src/lib/dashboard.ts`.

5. Validate locally:

```bash
npm run storybook
npm run build
```

Set up backend Python dependencies:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r backend/requirements.txt
```

Run backend:

```bash
npm run backend:dev
```

The backend command loads `.env` automatically, so Databricks credentials are picked up for live query mode.

## Save behavior

When you click **Save Dashboard**, the app serializes:

- `layout` positions/sizes from `react-grid-layout`
- widget definitions and query props

Then commits `dashboards/{slug}/dashboard.yaml` using the GitHub REST API.

Saved YAML includes:

- dashboard layout coordinates
- visualization widgets and their dataset/coordinate bindings
- dataset definitions (stored SQL + inferred columns + validation metadata)
- metadata and spec version for CI validation

## Dashboard spec and CI/CD

- Canonical report artifact: `dashboards/{slug}/dashboard.yaml`
- GitHub workflow: `.github/workflows/deploy-dashboard.yml`
- Workflow behavior:
  - detects only changed `dashboards/*/dashboard.yaml`
  - validates each changed YAML spec
  - runs deploy step per changed slug (matrix job)
- Runtime model target: one shared dashboard runtime app, many report specs by slug.

## Embed links

- Backend endpoint: `POST /api/embed-token`
- Returns:
  - signed embed token
  - embeddable URL (`/embed/{slug}?token=...`)
  - ready-to-paste iframe HTML snippet
- Embedded report payload endpoint: `GET /api/embed-dashboard/{slug}?token=...`
- Configure:
  - `EMBED_TOKEN_SECRET` (required in non-dev)
  - `EMBED_BASE_URL` (public base URL for embed links)

### Embed usage

1. Generate token + URL from the catalog `Embed` action.
2. Paste the returned URL into an iframe in another app.
3. The runtime verifies token signature + expiry + slug scope before serving report config.

## Next step

Next we can add dashboard load/edit listing from GitHub plus workflow dispatch from the UI to trigger deploys for each slug.
