import type { EntryRow } from './types'

// 监测设备域：动作表、动作裁决、诊断建议、旧数据迁移与设备核验汇总全部收口在这里。
// 列表页（可执行动作）、本地服务（写入裁决）、隐患点台账与巡查核验列都只能引用这一份，
// 不允许再各自维护一份判断分支。

export const DEVICE_STATUSES = ['正常运行', '信号异常', '低电量', '待维修', '已停用'] as const
export type DeviceStatus = (typeof DEVICE_STATUSES)[number]

export const DEVICE_ACTIONS = ['报修设备', '确认修复', '停用设备', '恢复启用'] as const
export type DeviceAction = (typeof DEVICE_ACTIONS)[number]

// 人工动作状态：诊断建议不能覆盖这些状态。「已停用」代表人工停用，裁决优先级最高；
// 「待维修」已转人工处理，同样不允许诊断建议回写。
const MANUAL_STATUSES: DeviceStatus[] = ['已停用', '待维修']

export type DeviceActionRule = {
  action: DeviceAction
  // 允许发起该动作的源状态；列表页展示与写入裁决共用这份约束。
  from: DeviceStatus[]
  to: DeviceStatus
  // 人工停用标记的落位：停用置上，恢复/修复解除。
  manualDisabled: boolean
  negative: boolean
}

// 同一份共用动作表：停用设备可以恢复（恢复后回正常运行），待修设备可确认修复直接转正常。
export const DEVICE_ACTION_TABLE: DeviceActionRule[] = [
  {
    action: '报修设备',
    from: ['正常运行', '信号异常', '低电量'],
    to: '待维修',
    manualDisabled: false,
    negative: true,
  },
  {
    action: '确认修复',
    from: ['待维修'],
    to: '正常运行',
    manualDisabled: false,
    negative: false,
  },
  {
    action: '停用设备',
    from: ['正常运行', '信号异常', '低电量', '待维修'],
    to: '已停用',
    manualDisabled: true,
    negative: true,
  },
  {
    action: '恢复启用',
    from: ['已停用'],
    to: '正常运行',
    manualDisabled: false,
    negative: false,
  },
]

// 动作 → 目标状态，供模块元数据复用，避免动作表外再写一份流转目标。
export const DEVICE_ACTION_TARGETS: Record<string, DeviceStatus> = Object.fromEntries(
  DEVICE_ACTION_TABLE.map((rule) => [rule.action, rule.to]),
)

export function isDeviceStatus(value: string): value is DeviceStatus {
  return (DEVICE_STATUSES as readonly string[]).includes(value)
}

export function isDeviceAction(value: string): value is DeviceAction {
  return (DEVICE_ACTIONS as readonly string[]).includes(value)
}

export function deviceRule(action: string): DeviceActionRule | undefined {
  return DEVICE_ACTION_TABLE.find((rule) => rule.action === action)
}

export type DeviceActionVerdict =
  | { ok: true; rule: DeviceActionRule }
  | { ok: false; message: string }

// 空设备 / 空动作 / 冲突动作必须明确拒绝：动作不在表里、设备状态不在动作允许的源状态集合内都算冲突。
export function resolveDeviceAction(action: string, row: EntryRow | null | undefined): DeviceActionVerdict {
  const actionName = action?.trim()
  if (!actionName) {
    return { ok: false, message: '设备动作不能为空' }
  }
  if (!row) {
    return { ok: false, message: '设备不存在，无法执行动作' }
  }
  const rule = deviceRule(actionName)
  if (!rule) {
    return { ok: false, message: `监测设备没有登记「${actionName}」这个动作` }
  }
  const status = String(row.status)
  if (!isDeviceStatus(status)) {
    return { ok: false, message: `设备状态「${status}」无法识别，拒绝执行「${actionName}」` }
  }
  if (status === rule.to) {
    return { ok: false, message: `监测设备已经是「${rule.to}」，不用重复操作` }
  }
  if (!rule.from.includes(status)) {
    return { ok: false, message: `设备当前为「${status}」，与「${actionName}」动作冲突，已拒绝` }
  }
  return { ok: true, rule }
}

// 列表页按当前状态给出可执行动作，与写入端共用同一张表。
export function availableDeviceActions(row: EntryRow): DeviceAction[] {
  const status = String(row.status)
  if (!isDeviceStatus(status)) {
    return []
  }
  return DEVICE_ACTION_TABLE.filter((rule) => rule.from.includes(status)).map((rule) => rule.action)
}

export type DeviceDiagnosis = {
  suggestion: DeviceStatus
  reason: string
  // 人工停用（或已转人工维修）时诊断仅作提示，调用方不得据此覆盖设备状态。
  blockedByManual: boolean
}

// 诊断建议：通讯异常优先于低电量；人工停用裁决高于诊断建议。
export function diagnoseDevice(row: EntryRow): DeviceDiagnosis {
  const communication = String(row['通讯状态'] ?? '').trim()
  const battery = parseBattery(row['电池余量'])
  const manual = String(row.status) === '已停用' || row['人工停用'] === true

  if (manual || String(row.status) === '待维修') {
    return {
      suggestion: String(row.status) as DeviceStatus,
      reason: manual ? '人工停用，诊断建议不覆盖' : '已转人工维修，诊断建议不覆盖',
      blockedByManual: true,
    }
  }
  if (communication.includes('离线') || communication.includes('中断') || communication.includes('异常')) {
    return { suggestion: '信号异常', reason: '通讯状态异常', blockedByManual: false }
  }
  if (battery !== null && battery <= 20) {
    return { suggestion: '低电量', reason: `电池余量 ${battery}%`, blockedByManual: false }
  }
  return { suggestion: '正常运行', reason: '各项指标正常', blockedByManual: false }
}

function parseBattery(value: string | number | boolean | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const matched = String(value ?? '').match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return null
  }
  const num = Number(matched[0])
  return Number.isFinite(num) ? num : null
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

// 按安装时间迁移缺维护时间的旧设备：最近维护日不是合法日期时，用安装日期补齐。
// 纯函数、可重复执行：补过之后再跑不会再改。
export function migrateDeviceMaintenance(rows: EntryRow[]): { rows: EntryRow[]; migrated: number } {
  let migrated = 0
  const next = rows.map((row) => {
    const installed = String(row['安装日期'] ?? '').trim()
    const maintained = String(row['最近维护日'] ?? '').trim()
    if (!DATE_ONLY.test(installed) || DATE_ONLY.test(maintained)) {
      return row
    }
    migrated += 1
    return { ...row, '最近维护日': installed }
  })
  return { rows: next, migrated }
}

export type DeviceCheckSummary = {
  total: number
  normal: number
  abnormal: number
  disabled: number
  repair: number
  verdict: string
}

export function emptyDeviceCheck(reason = '无设备'): DeviceCheckSummary {
  return { total: 0, normal: 0, abnormal: 0, disabled: 0, repair: 0, verdict: reason }
}

// 隐患点设备台账与巡查核验列共用的同一份结果：按所属隐患点汇总设备，结论口径只此一处。
export function summarizeDevices(devices: EntryRow[]): DeviceCheckSummary {
  if (!devices.length) {
    return emptyDeviceCheck()
  }
  const summary: DeviceCheckSummary = {
    total: devices.length,
    normal: 0,
    abnormal: 0,
    disabled: 0,
    repair: 0,
    verdict: '',
  }
  for (const row of devices) {
    switch (String(row.status)) {
      case '正常运行':
        summary.normal += 1
        break
      case '已停用':
        summary.disabled += 1
        break
      case '待维修':
        summary.repair += 1
        break
      case '信号异常':
      case '低电量':
        summary.abnormal += 1
        break
    }
  }
  if (summary.abnormal > 0) {
    summary.verdict = `异常${summary.abnormal}台（共${summary.total}台）`
  } else if (summary.repair > 0) {
    summary.verdict = `待维修${summary.repair}台（共${summary.total}台）`
  } else if (summary.disabled > 0 && summary.normal === 0) {
    summary.verdict = `全部停用${summary.disabled}台（共${summary.total}台）`
  } else if (summary.disabled > 0) {
    summary.verdict = `正常${summary.normal}台，停用${summary.disabled}台（共${summary.total}台）`
  } else {
    summary.verdict = `正常${summary.normal}台（共${summary.total}台）`
  }
  return summary
}

// 巡查时对一个隐患点下的设备做核验：诊断出异常的设备统一走动作表里的「报修设备」转待维修，
// 不绕过动作表直接改状态；人工停用 / 已待维修的裁决保留不动。核验只升级异常，不自动消警。
// 返回冲突明细，调用方必须在所有设备均无冲突时才允许整体提交，保证两侧不留一半结果。
export function verifyDevices(devices: EntryRow[]): {
  updates: { index: number; row: EntryRow; target: DeviceStatus; rule: DeviceActionRule }[]
  conflicts: string[]
} {
  const updates: { index: number; row: EntryRow; target: DeviceStatus; rule: DeviceActionRule }[] = []
  const conflicts: string[] = []
  devices.forEach((row, index) => {
    const diagnosis = diagnoseDevice(row)
    if (diagnosis.blockedByManual) {
      return
    }
    if (diagnosis.suggestion !== '信号异常' && diagnosis.suggestion !== '低电量') {
      return
    }
    const verdict = resolveDeviceAction('报修设备', row)
    if (!verdict.ok) {
      conflicts.push(`设备「${String(row['设备编号'] ?? row.id)}」${verdict.message}`)
      return
    }
    updates.push({ index, row, target: verdict.rule.to, rule: verdict.rule })
  })
  return { updates, conflicts }
}

// 启动期自检：动作表本身配置错误（重复动作、目标状态非法、空源状态）要立刻暴露。
for (const rule of DEVICE_ACTION_TABLE) {
  if (!rule.from.length) {
    throw new Error(`设备动作「${rule.action}」没有允许的源状态，动作表配置不完整`)
  }
  if (!isDeviceStatus(rule.to)) {
    throw new Error(`设备动作「${rule.action}」的目标状态「${rule.to}」非法`)
  }
}
const tableActionNames = DEVICE_ACTION_TABLE.map((rule) => rule.action)
if (new Set(tableActionNames).size !== tableActionNames.length) {
  throw new Error('设备动作表存在重复动作，拒绝启动')
}
