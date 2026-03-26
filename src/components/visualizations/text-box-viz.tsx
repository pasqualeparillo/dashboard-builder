interface TextBoxVizProps {
  textContent?: string
}

export function TextBoxViz({ textContent }: TextBoxVizProps) {
  return (
    <div className="flex h-full items-start rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
      {textContent?.trim() || 'Add text from the right panel to describe this section.'}
    </div>
  )
}
