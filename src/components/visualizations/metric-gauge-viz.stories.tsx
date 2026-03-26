import type { Meta, StoryObj } from '@storybook/react-vite'

import { MetricGaugeViz } from './metric-gauge-viz'

const meta = {
  title: 'Visualizations/MetricGaugeViz',
  component: MetricGaugeViz,
  args: {
    sql: 'SELECT metric_value FROM my_catalog.my_schema.metric_view LIMIT 1',
    refreshMs: 30000,
  },
  decorators: [
    (Story) => (
      <div style={{ width: '360px', height: '320px', border: '1px solid #e2e8f0', padding: '12px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MetricGaugeViz>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
