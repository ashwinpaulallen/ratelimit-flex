function swap(arr: number[], i: number, j: number): void {
  const t = arr[i]!;
  arr[i] = arr[j]!;
  arr[j] = t;
}

/**
 * Hoare partition. Returns index `j` such that elements can be split around the pivot region.
 * Mutates `arr` between `left` and `right` inclusive.
 */
function hoarePartition(arr: number[], left: number, right: number): number {
  const pivot = arr[left + ((right - left) >> 1)]!;
  let i = left - 1;
  let j = right + 1;
  for (;;) {
    do {
      i++;
    } while (arr[i]! < pivot);
    do {
      j--;
    } while (arr[j]! > pivot);
    if (i >= j) return j;
    swap(arr, i, j);
  }
}

/**
 * Returns the k-th smallest element (0-indexed) in arr[left..right] using Hoare-style partitioning.
 * Mutates `arr` in place.
 */
function quickselect(arr: number[], left: number, right: number, k: number): number {
  for (;;) {
    if (left === right) {
      return arr[left]!;
    }
    const p = hoarePartition(arr, left, right);
    if (k <= p) {
      right = p;
    } else {
      left = p + 1;
    }
  }
}

/**
 * Nearest-rank p-th percentile (0–100) via quickselect / nth_element. Average **O(n)** time.
 *
 * **Mutates `arr`** (partitions in place). Pass a copy if the original order must be preserved.
 */
export function percentile(arr: number[], p: number): number {
  const n = arr.length;
  if (n === 0) return 0;
  const k = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return quickselect(arr, 0, n - 1, k);
}
