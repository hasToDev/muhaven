/**
 * Split a linear range [0, total) into batches of `batchSize`.
 * Returns a list of { offset, size } pairs.
 */
export function paginate(total: number, batchSize: number): Array<{ offset: number; size: number }> {
  if (total <= 0) return []
  if (batchSize <= 0) throw new Error(`batchSize must be > 0, got ${batchSize}`)

  const batches: Array<{ offset: number; size: number }> = []
  for (let offset = 0; offset < total; offset += batchSize) {
    const size = Math.min(batchSize, total - offset)
    batches.push({ offset, size })
  }
  return batches
}
