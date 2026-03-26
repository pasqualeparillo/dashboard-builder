import type { Meta, StoryObj } from '@storybook/react-vite'

import { LineChartViz } from './line-chart-viz'

const meta = {
  title: 'Visualizations/LineChartViz',
  component: LineChartViz,
  args: {
    sql: 'SELECT label, value FROM my_catalog.my_schema.metric_view LIMIT 20',
    refreshMs: 30000,
  },
  decorators: [
    (Story) => (
      <div style={{ width: '640px', height: '360px', border: '1px solid #e2e8f0', padding: '12px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LineChartViz>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
