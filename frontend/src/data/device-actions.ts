import type { EntryRow } from './types'

// 监测设备域的共用判断：列表、报修、停用等分支都从这一份取，不再各自维护动作逻辑。
// 模块元数据、设备页面、巡查核验列共用这里的表和函数，改规则只改这一处。

export const DEVICE_STATUS = {
  running: '正常运行',
  signalLost: '信号异常',
  lowBattery: '低电量',
  repairing: '待维修',
  stopped: '已停用',
} as const

export type DeviceActionRule = {
  /** 动作名：页面按钮、模块元数据、服务层校验都用它 */
  name: string
  /** 允许执行动作的前置状态，不在列表里就是冲突动作，必须拒绝 */
  from: string[]
  /** 动作执行后的目标状态 */
  to: string
  /** 是否异常向动作（写进 abnormal 标记，概览按它统计） */
  abnormal: boolean
}

// 共用动作表：停用设备还能恢复，待修设备可直接转正常。
export const DEVICE_ACTIONS: DeviceActionRule[] = [
  {
    name: '报修设备',
    from: [DEVICE_STATUS.running, DEVICE_STATUS.signalLost, DEVICE_STATUS.lowBattery],
    to: DEVICE_STATUS.repairing,
    abnormal: false,
  },
  {
    name: '确认修复',
    from: [DEVICE_STATUS.repairing],
    to: DEVICE_STATUS.running,
    abnormal: false,
  },
  {
    name: '停用设备',
    from: [
      DEVICE_STATUS.running,
      DEVICE_STATUS.signalLost,
      DEVICE_STATUS.lowBattery,
      DEVICE_STATUS.repairing,
    ],
    to: DEVICE_STATUS.stopped,
    abnormal: true,
  },
  {
    name: '恢复启用',
    from: [DEVICE_STATUS.stopped],
    to: DEVICE_STATUS.running,
    abnormal: false,
  },
]

export function deviceActionNames(): string[] {
  return DEVICE_ACTIONS.map((item) => item.name)
}

export function deviceActionTargets(): Record<string, string> {
  return Object.fromEntries(DEVICE_ACTIONS.map((item) => [item.name, item.to]))
}

export type DeviceDiagnosis = {
  status: string
  reason: string
}

const LOW_BATTERY_PERCENT = 20

// 诊断建议：只看通讯状态和电池余量，给出建议状态，本身不改任何数据。
export function diagnoseDevice(row: EntryRow): DeviceDiagnosis | null {
  const communication = String(row['通讯状态'] ?? '')
  if (communication.includes('离线') || communication.includes('异常')) {
    return { status: DEVICE_STATUS.signalLost, reason: `通讯状态为「${communication}」` }
  }
  const battery = Number.parseInt(String(row['电池余量'] ?? ''), 10)
  if (Number.isFinite(battery) && battery < LOW_BATTERY_PERCENT) {
    return {
      status: DEVICE_STATUS.lowBattery,
      reason: `电池余量 ${battery}% 低于 ${LOW_BATTERY_PERCENT}%`,
    }
  }
  return null
}

export type DeviceResolution = {
  status: string
  source: '人工停用' | '人工报修' | '诊断建议' | '登记状态'
  diagnosis: DeviceDiagnosis | null
}

// 裁决顺序：人工停用 > 人工报修 > 诊断建议 > 登记状态。
// 人工停用永远压过诊断建议，诊断再急也不能把人工停用的设备判回别的状态。
export function resolveDeviceStatus(row: EntryRow): DeviceResolution {
  const diagnosis = diagnoseDevice(row)
  const current = String(row.status ?? '').trim()
  if (current === DEVICE_STATUS.stopped) {
    return { status: DEVICE_STATUS.stopped, source: '人工停用', diagnosis }
  }
  if (current === DEVICE_STATUS.repairing) {
    return { status: DEVICE_STATUS.repairing, source: '人工报修', diagnosis }
  }
  if (diagnosis) {
    return { status: diagnosis.status, source: '诊断建议', diagnosis }
  }
  return { status: current || DEVICE_STATUS.running, source: '登记状态', diagnosis: null }
}

// 设备列表「诊断建议」列的文案，同样走上面的裁决，页面不再自己拼规则。
export function describeDeviceDiagnosis(row: EntryRow): string {
  const resolved = resolveDeviceStatus(row)
  if (!resolved.diagnosis) {
    return '无需处理'
  }
  const hint = `建议转${resolved.diagnosis.status}（${resolved.diagnosis.reason}）`
  if (resolved.source === '人工停用') {
    return `人工停用优先，${hint}不生效`
  }
  if (resolved.source === '人工报修') {
    return `待维修处理中，${hint}暂缓`
  }
  return hint
}

export type DeviceActionOutcome =
  | { ok: true; row: EntryRow; message: string }
  | { ok: false; message: string }

// 执行设备动作：空设备、未登记动作、冲突动作都明确拒绝，通过才返回新行。
export function applyDeviceAction(
  row: EntryRow | undefined,
  actionName: string,
): DeviceActionOutcome {
  if (!row) {
    return { ok: false, message: '没有选中的监测设备，动作被拒绝' }
  }
  const rule = DEVICE_ACTIONS.find((item) => item.name === actionName)
  if (!rule) {
    return { ok: false, message: `监测设备没有登记「${actionName}」这个动作` }
  }
  const current = String(row.status ?? '').trim()
  if (!current) {
    return { ok: false, message: '监测设备缺少当前状态，无法判定动作，已拒绝' }
  }
  if (current === rule.to) {
    return { ok: false, message: `监测设备已经是「${rule.to}」，不用重复操作` }
  }
  if (!rule.from.includes(current)) {
    return {
      ok: false,
      message: `监测设备当前状态「${current}」与动作「${actionName}」冲突，允许的前置状态：${rule.from.join('、')}`,
    }
  }
  const next: EntryRow = {
    ...row,
    status: rule.to,
    设备状态: rule.to,
    pending: rule.to === DEVICE_STATUS.repairing,
    abnormal: rule.abnormal,
  }
  return { ok: true, row: next, message: `监测设备已${actionName}，当前状态「${rule.to}」` }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/

// 旧设备缺维护时间的按安装时间补齐；安装时间也不可用的保持原样，下次再处理。
export function migrateDeviceRows(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const next = rows.map((row) => {
    const maintained = String(row['最近维护日'] ?? '').trim()
    if (DATE_PATTERN.test(maintained)) {
      return row
    }
    const installed = String(row['安装日期'] ?? '').trim()
    if (!DATE_PATTERN.test(installed)) {
      return row
    }
    changed = true
    return { ...row, 最近维护日: installed }
  })
  return { rows: changed ? next : rows, changed }
}

// 隐患点设备台账在本地存储里的 key：台账由设备数据派生，和设备数据同事务写入。
export const HAZARD_DEVICE_LEDGER_KEY = 'hazard_device_ledger'

type LedgerCounts = {
  running: number
  repairing: number
  stopped: number
  abnormal: number
}

function ledgerVerdict(counts: LedgerCounts): string {
  if (counts.stopped > 0) {
    return '存在人工停用设备，需复核'
  }
  if (counts.repairing > 0) {
    return '存在待维修设备'
  }
  if (counts.abnormal > 0) {
    return '存在异常设备，建议报修'
  }
  return '设备运行正常'
}

// 隐患点设备台账：按所属隐患点汇总裁决后的状态，设备台账和巡查核验列共用这一份结果。
export function buildHazardDeviceLedger(deviceRows: EntryRow[]): EntryRow[] {
  const groups = new Map<string, EntryRow[]>()
  for (const row of deviceRows) {
    const point = String(row['所属隐患点'] ?? '').trim()
    if (!point) {
      continue
    }
    const list = groups.get(point) ?? []
    list.push(row)
    groups.set(point, list)
  }
  return [...groups.entries()].map(([point, rows], index) => {
    const resolved = rows.map((row) => resolveDeviceStatus(row).status)
    const counts: LedgerCounts = {
      running: resolved.filter((status) => status === DEVICE_STATUS.running).length,
      repairing: resolved.filter((status) => status === DEVICE_STATUS.repairing).length,
      stopped: resolved.filter((status) => status === DEVICE_STATUS.stopped).length,
      abnormal: resolved.filter(
        (status) => status === DEVICE_STATUS.signalLost || status === DEVICE_STATUS.lowBattery,
      ).length,
    }
    const verdict = ledgerVerdict(counts)
    return {
      id: index + 1,
      status: verdict,
      pending: counts.repairing > 0 || counts.abnormal > 0,
      abnormal: counts.stopped > 0 || counts.abnormal > 0,
      隐患点编号: point,
      设备总数: rows.length,
      正常运行数: counts.running,
      待维修数: counts.repairing,
      已停用数: counts.stopped,
      异常设备数: counts.abnormal,
      核验结论: verdict,
    }
  })
}

export type HazardDeviceVerdict = {
  ok: boolean
  verdict: string
}

// 巡查核验：从共用台账里取结论，隐患点为空或名下没有设备都明确拒绝。
export function verifyHazardDevices(
  ledgerRows: EntryRow[],
  hazardPoint: string,
): HazardDeviceVerdict {
  const point = hazardPoint.trim()
  if (!point) {
    return { ok: false, verdict: '隐患点编号为空，无法核验设备' }
  }
  const row = ledgerRows.find((item) => String(item['隐患点编号']) === point)
  if (!row) {
    return { ok: false, verdict: `隐患点 ${point} 下没有监测设备，无法核验` }
  }
  return { ok: true, verdict: String(row['核验结论']) }
}
