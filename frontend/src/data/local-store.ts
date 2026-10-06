import { runMigrations } from './migrations'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function persist(payload: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  let data = fallback
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      persist(fallback)
    } else {
      try {
        const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
        data = { ...fallback, ...parsed }
      } catch {
        persist(fallback)
        data = fallback
      }
    }
  }
  // 旧数据迁移：缺维护时间的设备按安装时间补齐，隐患点设备台账按最新设备数据重建。
  const migrated = runMigrations(data)
  if (migrated.changed) {
    try {
      persist(migrated.rows)
    } catch {
      // 迁移写回失败不影响本次读取；迁移是幂等的，下次打开会再跑一遍。
    }
  }
  return migrated.rows
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

// 多模块一起写：先落 localStorage 再换内存缓存，任一侧失败都保持原样，不留一半结果。
export function saveRowsBatch(entries: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...entries }
  persist(next)
  cache = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveRowsBatch({ [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
