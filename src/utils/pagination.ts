export function paginate(page: number, limit: number) {
  const skip = (page - 1) * limit
  return { skip, take: limit }
}

export function paginatedResponse<T>(data: T[], total: number, page: number, limit: number) {
  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  }
}

export function parsePageParams(query: Record<string, unknown>): { page: number; limit: number } {
  const page = Math.max(1, parseInt(String(query.page || '1')))
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || '20'))))
  return { page, limit }
}
