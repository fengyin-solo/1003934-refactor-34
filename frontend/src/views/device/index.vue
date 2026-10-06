<template>
  <section class="page" data-module="device">
    <header class="page-head">
      <div>
        <h2>监测设备管理</h2>
        <p class="page-desc">维护监测设备，围绕设备编号、设备类型、所属隐患点、安装日期做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记监测设备</button>
        <button class="btn" type="button" @click="exportRows">导出监测设备清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>诊断建议</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ describeDeviceDiagnosis(row) }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无监测设备数据，可先登记监测设备</td>
        </tr>
      </tbody>
    </table>

    <section class="ledger-block">
      <h3 class="ledger-title">隐患点设备台账</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in ledgerColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in ledger" :key="String(item.id)">
            <td v-for="column in ledgerColumns" :key="column">{{ item[column] ?? '—' }}</td>
          </tr>
          <tr v-if="!ledger.length">
            <td :colspan="ledgerColumns.length" class="empty-state">暂无隐患点设备台账数据</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条监测设备记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getHazardDeviceLedger,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { describeDeviceDiagnosis, deviceActionNames } from '@/data/device-actions'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('device')
const columns = ["设备编号", "设备类型", "所属隐患点", "安装日期", "最近维护日", "电池余量", "通讯状态", "设备状态"]
// 动作按钮直接取共用动作表，报修、停用、恢复等判断只在 device-actions.ts 维护一份
const actions = deviceActionNames()
const statuses = ["正常运行", "信号异常", "低电量", "待维修", "已停用"]
const stats = [{"label": "设备总数", "value": 0}, {"label": "正常运行数", "value": 0}, {"label": "待维修数", "value": 0}]
const ledgerColumns = ["隐患点编号", "设备总数", "正常运行数", "待维修数", "已停用数", "异常设备数", "核验结论"]

const rows = ref<EntryRow[]>([])
const ledger = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '监测设备登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 台账和巡查核验列读同一份结果，设备动作执行后这里跟着刷新
    ledger.value = getHazardDeviceLedger()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '监测设备列表读取失败'
  }
}

onMounted(reload)
</script>
