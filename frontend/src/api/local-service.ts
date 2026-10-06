import {
  availableDeviceActions,
  diagnoseDevice,
  emptyDeviceCheck,
  resolveDeviceAction,
  summarizeDevices,
  verifyDevices,
} from '@/data/device-flow'
import { allRows, commitRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']
const DEVICE_MODULE = 'device'
const PATROL_MODULE = 'patrol'
const DEVICE_CHECK_PREFIX = '设备核验：'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 列表页可执行动作统一从这里取：设备模块走共用动作表，其他模块沿用模块登记的动作清单。
export function availableActions(key: string, row: EntryRow): string[] {
  if (key === DEVICE_MODULE) {
    return availableDeviceActions(row)
  }
  return moduleMeta(key).actions
}

function findIndex(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

// 设备动作统一过动作表裁决：空设备、空动作、状态冲突都在这里明确拒绝。
// 设备动作统一过动作表裁决：空设备、空动作、状态冲突都在这里明确拒绝。
type DeviceActionOutcome = ActionResult & { updated?: EntryRow }

function runDeviceAction(action: string, row: EntryRow): DeviceActionOutcome {
  const verdict = resolveDeviceAction(action, row)
  if (!verdict.ok) {
    return { ok: false, message: verdict.message }
  }
  const rule = verdict.rule
  const updated: EntryRow = {
    ...row,
    status: rule.to,
    pending: rule.to === '待维修',
    abnormal: rule.negative,
    人工停用: rule.manualDisabled,
  }
  return { ok: true, updated, message: `监测设备已${rule.action.replace('设备', '')}，当前状态「${rule.to}」` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const actionName = action?.trim()
  if (!actionName) {
    return { ok: false, message: `${meta.entity}动作不能为空` }
  }
  const rows = listRows(key)
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  if (key === DEVICE_MODULE) {
    const result = runDeviceAction(actionName, rows[index])
    if (!result.ok || !result.updated) {
      return result
    }
    const next = [...rows]
    next[index] = result.updated
    return commitOrReject(key, next, result.message)
  }

  const target = meta.actionTargets[actionName]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${actionName}」这个动作` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => actionName.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  return commitOrReject(key, next, `${meta.entity}已${actionName}，当前状态「${target}」`)
}

// 单模块落盘：失败时返回拒绝结果，缓存与存储都保持提交前状态。
function commitOrReject(key: string, rows: EntryRow[], successMessage: string): ActionResult {
  try {
    saveRows(key, rows)
  } catch {
    return { ok: false, message: '数据写入失败，已全部回滚，未保留任何中间结果' }
  }
  return { ok: true, message: successMessage }
}

export type DeviceDiagnosisView = {
  suggestion: string
  reason: string
  blockedByManual: boolean
  adoptable: boolean
}

// 设备列表的诊断建议列：人工停用 / 待维修裁决优先，建议仅作提示不可采纳。
export function deviceDiagnosis(row: EntryRow): DeviceDiagnosisView {
  const diagnosis = diagnoseDevice(row)
  return {
    suggestion: diagnosis.suggestion,
    reason: diagnosis.reason,
    blockedByManual: diagnosis.blockedByManual,
    adoptable: !diagnosis.blockedByManual && String(row.status) !== diagnosis.suggestion,
  }
}

// 采纳诊断建议：诊断只能把正常运行设备建议成信号异常/低电量等诊断态；
// 人工停用高于诊断建议——已停用/待维修一律拒绝，不允许诊断覆盖。
export function adoptDeviceDiagnosis(id: number): ActionResult {
  const rows = listRows(DEVICE_MODULE)
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的监测设备` }
  }
  const row = rows[index]
  const diagnosis = diagnoseDevice(row)
  if (diagnosis.blockedByManual) {
    return { ok: false, message: `设备处于「${String(row.status)}」（人工裁决），诊断建议不得覆盖` }
  }
  if (String(row.status) === diagnosis.suggestion) {
    return { ok: false, message: `设备已经是「${diagnosis.suggestion}」，诊断建议无需采纳` }
  }
  const updated: EntryRow = {
    ...row,
    status: diagnosis.suggestion,
    pending: true,
    abnormal: diagnosis.suggestion !== '正常运行',
    人工停用: false,
  }
  const next = [...rows]
  next[index] = updated
  return commitOrReject(DEVICE_MODULE, next, `已采纳诊断建议，设备当前状态「${diagnosis.suggestion}」`)
}

// 隐患点设备核验：台账列与巡查列共用这一份结果，不允许两边各算各的。
export function checkHazardDevices(hazardCode: string) {
  const code = hazardCode.trim()
  if (!code) {
    return emptyDeviceCheck('未关联隐患点')
  }
  const devices = listRows(DEVICE_MODULE).filter(
    (row) => String(row['所属隐患点'] ?? '').trim() === code,
  )
  return summarizeDevices(devices)
}

// 巡查核验：对一条巡查记录所属隐患点下的异常设备统一走动作表报修，
// 设备侧与巡查侧在同一次提交里落盘，任一侧失败整体回滚，不留一半结果。
export function verifyPatrolDevices(patrolId: number): ActionResult {
  const patrolRows = listRows(PATROL_MODULE)
  const patrolIndex = findIndex(patrolRows, patrolId)
  if (patrolIndex < 0) {
    return { ok: false, message: `没有找到编号为 ${patrolId} 的巡查记录` }
  }
  const patrol = patrolRows[patrolIndex]
  const hazardCode = String(patrol['隐患点编号'] ?? '').trim()
  if (!hazardCode) {
    return { ok: false, message: '巡查记录缺少隐患点编号，无法核验设备' }
  }

  const deviceRows = listRows(DEVICE_MODULE)
  const scoped = deviceRows
    .map((row, index) => ({ row, index }))
    .filter((item) => String(item.row['所属隐患点'] ?? '').trim() === hazardCode)
  if (scoped.length === 0) {
    return { ok: false, message: `隐患点「${hazardCode}」下没有设备，明确拒绝空设备核验` }
  }

  const { updates, conflicts } = verifyDevices(scoped.map((item) => item.row))
  if (conflicts.length > 0) {
    return { ok: false, message: `设备动作冲突，已拒绝整批核验：${conflicts.join('；')}` }
  }

  // 两侧结果都在内存里先算好，再一次性原子提交。
  const nextDevices = [...deviceRows]
  for (const update of updates) {
    const globalIndex = scoped[update.index].index
    nextDevices[globalIndex] = {
      ...update.row,
      status: update.target,
      pending: true,
      abnormal: update.rule.negative,
      人工停用: update.rule.manualDisabled,
    }
  }

  const summary = summarizeDevices(
    nextDevices.filter((row) => String(row['所属隐患点'] ?? '').trim() === hazardCode),
  )
  const previousMeasure = String(patrol['处置措施'] ?? '').trim()
  const measureNote = `${DEVICE_CHECK_PREFIX}${summary.verdict}`
  const nextPatrolRows = [...patrolRows]
  nextPatrolRows[patrolIndex] = {
    ...patrol,
    '处置措施': previousMeasure
      ? previousMeasure.includes(DEVICE_CHECK_PREFIX)
        ? previousMeasure.replace(/设备核验：.*$/, measureNote)
        : `${previousMeasure}；${measureNote}`
      : measureNote,
  }

  try {
    commitRows({ [DEVICE_MODULE]: nextDevices, [PATROL_MODULE]: nextPatrolRows })
  } catch {
    return { ok: false, message: '巡查核验写入失败，设备与巡查记录已全部回滚，未保留任何中间结果' }
  }
  return {
    ok: true,
    message:
      updates.length > 0
        ? `核验完成：${updates.length}台异常设备已报修，${measureNote}`
        : `核验完成，未发现新异常，${measureNote}`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `${String.fromCharCode(0xfeff)}${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
