import { migrateDeviceMaintenance } from './device-flow'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 旧数据迁移：缺维护时间的设备按安装日期补齐。纯函数可重复执行，每次读取都跑一遍也安全。
function migrate(snapshot: Record<string, EntryRow[]>): {
  snapshot: Record<string, EntryRow[]>
  migrated: number
} {
  const deviceRows = snapshot.device ?? []
  const { rows, migrated } = migrateDeviceMaintenance(deviceRows)
  if (migrated === 0) {
    return { snapshot, migrated: 0 }
  }
  return { snapshot: { ...snapshot, device: rows }, migrated }
}

function persist(snapshot: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    // 单次写入：localStorage 容量超限等异常会在这里抛出，由调用方决定回滚。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = migrate(clone(SEED_ROWS)).snapshot
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    try {
      persist(fallback)
    } catch {
      // 首次播种写不进去时退回内存态，不影响页面渲染。
    }
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...clone(SEED_ROWS), ...parsed }
    const { snapshot, migrated } = migrate(merged)
    if (migrated > 0) {
      try {
        persist(snapshot)
      } catch {
        // 迁移结果无法落盘时仅作用于本次内存态，不能阻断页面读取。
      }
    }
    return snapshot
  } catch {
    const reseeded = migrate(clone(SEED_ROWS)).snapshot
    try {
      persist(reseeded)
    } catch {
      // 同上：存储不可用时退回内存态。
    }
    return reseeded
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 单模块提交：先在内存里构造整份快照，落盘成功才替换缓存；落盘失败缓存原样保留，
// 不会出现 localStorage 已改、内存没改（或反过来）的一半结果。
export function saveRows(key: string, rows: EntryRow[]): void {
  const previous = allRows()
  const next = { ...previous, [key]: rows }
  persist(next)
  cache = next
}

// 多模块原子提交：任一侧写入失败时两侧都不落，缓存回滚到提交前，杜绝一半结果。
export function commitRows(updates: Record<string, EntryRow[]>): void {
  const previous = allRows()
  const next = { ...previous, ...updates }
  persist(next)
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
