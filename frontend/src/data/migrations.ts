import {
  buildHazardDeviceLedger,
  HAZARD_DEVICE_LEDGER_KEY,
  migrateDeviceRows,
} from './device-actions'
import type { EntryRow } from './types'

// 启动时跑的旧数据迁移：目前只有监测设备一类，以后新增模块的迁移也挂在这里。
export function runMigrations(data: Record<string, EntryRow[]>): {
  rows: Record<string, EntryRow[]>
  changed: boolean
} {
  let changed = false
  const next = { ...data }

  // 缺维护时间的旧设备按安装时间补齐
  const devices = migrateDeviceRows(next.device ?? [])
  if (devices.changed) {
    next.device = devices.rows
    changed = true
  }

  // 隐患点设备台账由设备数据派生，每次启动都按最新设备数据重建，
  // 保证设备台账和巡查核验列看到的始终是同一份结果。
  const ledger = buildHazardDeviceLedger(next.device ?? [])
  if (JSON.stringify(next[HAZARD_DEVICE_LEDGER_KEY] ?? null) !== JSON.stringify(ledger)) {
    next[HAZARD_DEVICE_LEDGER_KEY] = ledger
    changed = true
  }

  return { rows: changed ? next : data, changed }
}
