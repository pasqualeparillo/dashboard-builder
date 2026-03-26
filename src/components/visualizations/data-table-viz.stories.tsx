import type { Meta, StoryObj } from '@storybook/react-vite'

import { DataTableViz } from './data-table-viz'

const meta = {
  title: 'Visualizations/DataTableViz',
  component: DataTableViz,
  args: {
    sql: 'SELECT metric_name, metric_value, observed_at FROM my_catalog.my_schema.metric_view LIMIT 20',
    refreshMs: 30000,
  },
  decorators: [
    (Story) => (
      <div style={{ width: '700px', height: '360px', border: '1px solid #e2e8f0', padding: '12px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DataTableViz>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
