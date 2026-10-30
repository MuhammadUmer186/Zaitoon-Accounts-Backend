import { z } from 'zod'

// Zod 4 applies defaults even inside optional fields. A partial update must
// preserve omitted database values rather than reapply creation defaults.
export function updateSchema<T extends z.ZodObject>(schema: T): ReturnType<T['partial']> {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, value]) => {
    let field = value as z.ZodType
    while (field instanceof z.ZodOptional || field instanceof z.ZodDefault) {
      field = (field instanceof z.ZodDefault ? field.removeDefault() : field.unwrap()) as z.ZodType
    }
    return [key, field.optional()]
  }))
  return schema.partial().extend(shape) as ReturnType<T['partial']>
}
