// Presentation only: preserve branch IDs, permissions, stored names and amounts.
// A restaurant with multiBranch disabled still uses its branch internally.
export function restaurantPresentation(value: unknown, restaurantName: string, context = ''): unknown {
  if (Array.isArray(value)) return value.map(item => restaurantPresentation(item, restaurantName, context === 'branches' ? 'branch' : context))
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['oldData', 'newData'].includes(key)) return [key, item]
    if (['label', 'header'].includes(key) && item === 'Branch') return [key, 'Restaurant']
    if (['branchName', 'fromBranchName', 'toBranchName'].includes(key)) return [key, restaurantName]
    if (key === 'name' && ['branch', 'fromBranch', 'toBranch'].includes(context)) return [key, restaurantName]
    if (key === 'branch' && typeof item === 'string') return [key, restaurantName]
    return [key, restaurantPresentation(item, restaurantName, key)]
  }))
}
