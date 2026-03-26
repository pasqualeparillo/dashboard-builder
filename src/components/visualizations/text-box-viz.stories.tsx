import type { Meta, StoryObj } from '@storybook/react-vite'

import { TextBoxViz } from './text-box-viz'

const meta = {
  title: 'Visualizations/TextBoxViz',
  component: TextBoxViz,
  args: {
    textContent: 'Narrative context: Revenue grew 12% week-over-week in the Northeast region.',
  },
  decorators: [
    (Story) => (
      <div style={{ width: '640px', height: '220px', border: '1px solid #e2e8f0', padding: '12px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TextBoxViz>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Empty: Story = {
  args: {
    textContent: '',
  },
}
