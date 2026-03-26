export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

export function createDashboardSlug(prefix = 'dashboard') {
  return `${slugify(prefix) || 'dashboard'}-${crypto.randomUUID()}`
}
