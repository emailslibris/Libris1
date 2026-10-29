/* Updated script.js — DOM blindagem e limpeza imediata de subscriptions ao signOut.
   Preserva obrigatoriedade schoolId, validações de estoque e regras de autenticação. */

import { auth, signInWithEmailAndPassword, signOut } from './firebase.js'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { open } from '@tauri-apps/plugin-shell'
import { createLocalStore } from './local-store.mjs'
import { createLocalDataApi } from './local-data.mjs'
import { createCoordinationEmailHtml, createStudentEmailHtml } from './email-templates.mjs'
import { backupCollectionFiles, optionalBackupCollectionFiles, backupRecordFromRow, parseBackupCell, resolveLegacyCategory } from './csv-backup.mjs'
import * as XLSX from 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm'

const localStore = createLocalStore()
const localData = createLocalDataApi(localStore)
const { db, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, query, where, onSnapshot, runTransaction, writeBatch, serverTimestamp, Timestamp, increment } = localData
const config = {
  organizationName: 'Libris',
  currentSchoolId: 'escola-padrao',
  schoolName: 'Biblioteca escolar',
  coordinationEmail: '',
  reminderDays: 1,
  coordinationDays: 7,
  maxBooksStudent: 2,
  maxBooksTeacher: 35,
  studentLoanDays: 7,
  teacherLoanDays: 21,
  smtp: { host: '', port: 587, username: '' }
}

function getMaxLoanDaysForReader(reader) {
  if (isTeacherReader(reader)) return Math.min(180, Math.max(1, Math.trunc(Number(config.teacherLoanDays) || 21)))
  if (isStudentReader(reader)) return Math.min(180, Math.max(1, Math.trunc(Number(config.studentLoanDays) || 7)))
  return null
}

function updateLoanDaysLimit(reader, resetToMaximum = false) {
  const input = $('#loanDays')
  if (!input) return
  const maximum = getMaxLoanDaysForReader(reader)
  const help = $('#loanDaysHelp')
  if (maximum === null) {
    input.removeAttribute('max')
    if (help) {
      help.textContent = ''
      help.hidden = true
    }
    if (resetToMaximum) input.value = String(config.studentLoanDays || 7)
    return
  }

  input.max = String(maximum)
  const currentDays = Number(input.value)
  if (resetToMaximum || !Number.isInteger(currentDays) || currentDays < 1 || currentDays > maximum) input.value = String(maximum)
  if (help) {
    const profile = isTeacherReader(reader) ? 'professor' : 'aluno'
    help.textContent = `Prazo máximo para ${profile}: ${maximum} dias. Informe um valor entre 1 e ${maximum}.`
    help.hidden = false
  }
}

const defaultCategories = []
const categories = [{ id: 'all', name: 'Todas' }, ...defaultCategories]
const LOCAL_SESSION_KEY = 'libris-local-session'

const state = {
  user: null,
  profile: null,
  books: [],
  readers: [],
  loans: [],
  csv: [],
  categories: [...defaultCategories],
  acervoQuery: '',
  readerQuery: '',
  readerFilter: 'all',
  loanQuery: '',
  adminUnsubs: [],
  loanFilter: 'all'
}

let pendingCsvImport = null
const selectedLabelQuantities = new Map()
let schoolSetupRequired = false

/* -------------------------
   DOM helpers & utilities (blindados)
   ------------------------- */
const $ = (s) => (typeof document !== 'undefined' ? document?.querySelector?.(s) ?? null : null)
const $$ = (s) => (typeof document !== 'undefined' ? Array.from(document?.querySelectorAll?.(s) || []) : [])
const esc = (v = '') => String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c])
const getCategoryOptions = () => (state.categories.length ? state.categories : defaultCategories)
const label = (id) => getCategoryOptions().find((x) => x.id === id)?.name || categories.find((x) => x.id === id)?.name || 'Geral'
function getThemePreference() {
  try {
    const preference = localStorage.getItem('libris-theme')
    return ['light', 'dark'].includes(preference) ? preference : 'system'
  } catch (err) {
    console.warn('Não foi possível ler a preferência de aparência.', err)
    return 'system'
  }
}

function applyThemePreference(preference, persist = false) {
  if (!['system', 'light', 'dark'].includes(preference)) {
    throw new Error(`Preferência de aparência inválida: ${preference}`)
  }
  if (preference === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.dataset.theme = preference

  if (persist) {
    try {
      if (preference === 'system') localStorage.removeItem('libris-theme')
      else localStorage.setItem('libris-theme', preference)
      toast('Aparência atualizada neste dispositivo.')
    } catch (err) {
      console.error('Não foi possível salvar a preferência de aparência.', err)
      toast('A aparência mudou, mas não foi possível salvar a preferência neste dispositivo.', 'error')
    }
  }
}

function bookCategoryName(book = {}) {
  const options = getCategoryOptions()
  const prefix = String(book.code || '').match(/^([A-Z0-9]{1,4})-\d{4}$/i)?.[1]
  const candidates = [book.categoryId, book.categoryName, prefix]
    .filter(Boolean)
    .map((value) => String(value).trim().toLocaleLowerCase('pt-BR'))

  for (const candidate of candidates) {
    const category = options.find((item) => [item.id, item.docId, item.code, item.name]
      .some((value) => String(value || '').trim().toLocaleLowerCase('pt-BR') === candidate))
    if (category?.name) return category.name
  }
  return String(book.categoryName || book.categoryId || prefix || 'Geral')
}
const available = (b) => Number(b.available || 0) > 0
const bookStatus = (b) => available(b) ? 'disponivel' : 'emprestado'
const date = (v) => v?.toDate ? v.toDate() : v ? new Date(v) : null
const formatDate = (v) => date(v)?.toLocaleDateString('pt-BR') || '—'
const overdue = (l) => {
  const dueDate = date(l.dueAt)
  return l.status === 'active' && dueDate instanceof Date && !Number.isNaN(dueDate.getTime()) && dueDate < new Date()
}

function toast(message, type = 'success') { const el = $('#toast'); if (!el) return; el.textContent = message; el.className = `toast ${type}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.className = 'toast hidden' }, 4000) }
function error(err, message = 'Não foi possível conectar ao servidor. Verifique sua conexão.') { console.error(err); toast(err?.code === 'auth/invalid-credential' ? 'E-mail ou senha inválidos.' : message, 'error') }
function loading(button, value, text = 'Aguarde…') { if (!button) return; button.disabled = value; if (value) { button.dataset.text = button.textContent; button.textContent = text } else button.textContent = button.dataset.text || button.textContent }

/* Modal helper with accessibility blur on close */
function modal(id, open) { 
  const el = typeof document !== 'undefined' ? document.getElementById(id) : null
  if (el) { 
    if (!open) {
      const activeElement = el.querySelector(':focus')
      if (activeElement) activeElement.blur()
    }
    el.classList.toggle('hidden', !open)
    el.setAttribute('aria-hidden', String(!open))
  }
}

/* -------------------------
   Metadata lookup (admin)
   ------------------------- */
async function lookupBookMetadata(title, author, publisher) {
  const query = [title, author, publisher].filter(Boolean).join(' ')
  if (!query) return { synopsis: '', coverUrl: '' }

  try {
    const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1&langRestrict=pt`)
    if (response.ok) {
      const volume = (await response.json()).items?.[0]?.volumeInfo
      if (volume) {
        const coverUrl = volume.imageLinks?.thumbnail?.replace('http://', 'https://') || volume.imageLinks?.smallThumbnail?.replace('http://', 'https://') || ''
        const synopsis = String(volume.description || '').replace(/<[^>]*>/g, '').trim().slice(0, 700)
        if (coverUrl || synopsis) return { synopsis, coverUrl }
      }
    }
  } catch (error) {
    console.warn('Não foi possível buscar dados no Google Books:', error)
  }

  try {
    const response = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}&publisher=${encodeURIComponent(publisher || '')}&limit=1`)
    if (!response.ok) return { synopsis: '', coverUrl: '' }
    const doc = (await response.json()).docs?.[0]
    if (!doc) return { synopsis: '', coverUrl: '' }
    const synopsis = Array.isArray(doc.first_sentence) ? doc.first_sentence.join(' ') : String(doc.first_sentence || '')
    const coverId = doc.cover_i || doc.covers?.[0]
    return { synopsis: synopsis.slice(0, 700), coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : '' }
  } catch (error) {
    console.warn('Não foi possível buscar dados na Open Library:', error)
    return { synopsis: '', coverUrl: '' }
  }
}

/* -------------------------
   UI renderers (admin)
   ------------------------- */
function renderCategorySelect() {
  const select = $('#bookCategoryInput')
  if (!select) return
  const categoriesList = state?.categories || []
  select.innerHTML = categoriesList.map((c) => {
    const codeVal = String(c.code || c.id || '').toUpperCase()
    return `<option value="${codeVal}">${esc(c.name)}</option>`
  }).join('')
}

function renderCategoryList() {
  const list = $('#categoryList')
  if (!list) return
  list.innerHTML = getCategoryOptions().length ? getCategoryOptions().map((c) => `<div class="category-item"><span>${esc(c.name)}</span><small>${esc(c.code || c.id)}</small><button type="button" class="small-btn danger" data-del-category="${esc(c.docId || c.id)}">Apagar</button></div>`).join('') : '<p class="empty-state">Nenhuma categoria cadastrada.</p>'
  $$('[data-del-category]').forEach((b) => b.onclick = () => removeCategory(b.dataset.delCategory))
}

function renderBooks() { 
  const body = $('#bookTableBody')
  if (!body) return;
  const q = state.acervoQuery.toLowerCase().trim()
  const list = state.books.filter((b) => !q || [b.title, b.author, b.code].some((x) => String(x || '').toLowerCase().includes(q)))
  body.innerHTML = list.length ? list.map((b) => `<tr><td>${esc(b.code)}</td><td>${esc(b.title)}</td><td>${esc(bookCategoryName(b))}</td><td>${esc(b.tombamento || 'Não informado')}</td><td>${Number(b.total || 0)}</td><td>${esc(b.shelf || '—')}</td><td><span class="badge ${bookStatus(b) === 'disponivel' ? 'available' : 'borrowed'}">${bookStatus(b) === 'disponivel' ? 'Disponível' : 'Emprestado'}</span></td><td><div class="action-row"><button class="small-btn primary" type="button" data-edit-book="${b.id}">Editar</button><button class="small-btn danger" type="button" data-del-book="${b.id}">Apagar</button></div></td></tr>`).join('') : '<tr><td colspan="8">Nenhum livro cadastrado.</td></tr>';
  $$('[data-edit-book]').forEach((b) => b.onclick = () => editBook(b.dataset.editBook)); 
  $$('[data-del-book]').forEach((b) => b.onclick = () => removeBook(b.dataset.delBook))
}

function renderReaderSelector() {
  const input = $('#readerInput')
  const suggestions = $('#readerSuggestions')
  if (!input || !suggestions) return

  const queryText = input.value.trim().toLocaleLowerCase('pt-BR')
  if (!queryText || $('#loanReaderIdInput')?.value) {
    suggestions.replaceChildren()
    suggestions.hidden = true
    input.setAttribute('aria-expanded', 'false')
    return
  }

  const matches = state.readers.filter((reader) => [
    reader.name,
    reader.matricula,
    reader.email,
    reader.phone,
    reader.course,
    reader.class,
    reader.type
  ].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(queryText))).slice(0, 8)

  suggestions.innerHTML = matches.length ? matches.map((reader) => `
    <button class="reader-suggestion" type="button" role="option" data-select-loan-reader="${esc(reader.id)}">
      <span class="reader-suggestion-main">${esc(reader.name || 'Leitor sem nome')}</span>
      <span class="reader-suggestion-meta">${esc(reader.matricula || reader.type || reader.role || 'Leitor')} · ${esc(reader.course || reader.class || reader.email || '')}</span>
    </button>
  `).join('') : '<p class="reader-suggestions-empty">Nenhum leitor encontrado nesta escola.</p>'
  suggestions.hidden = false
  input.setAttribute('aria-expanded', 'true')
}

function selectLoanReader(readerId) {
  const reader = state.readers.find((item) => item.id === readerId)
  const input = $('#readerInput')
  const selectedId = $('#loanReaderIdInput')
  const suggestions = $('#readerSuggestions')
  if (!reader || !input || !selectedId) return

  input.value = `${reader.name || ''}${reader.matricula ? ` · ${reader.matricula}` : ''}`
  selectedId.value = reader.id
  updateLoanDaysLimit(reader)
  updateLoanQuantityLimit(reader)
  if (suggestions) {
    suggestions.replaceChildren()
    suggestions.hidden = true
  }
  input.setAttribute('aria-expanded', 'false')
}

function renderReaders() { 
  const body = $('#readersTableBody')
  if (!body) return;
  const q = state.readerQuery.toLowerCase().trim()
  const list = state.readers.filter((reader) => {
    const student = isStudentReader(reader)
    const teacher = isTeacherReader(reader)
    const matchesFilter = state.readerFilter === 'students'
      ? student
      : state.readerFilter === 'teachers'
        ? teacher
        : state.readerFilter === 'others'
          ? !student && !teacher
          : true
    return matchesFilter && (!q || [reader.name, reader.type, reader.role, reader.matricula].some((x) => String(x || '').toLowerCase().includes(q)))
  })
  body.innerHTML = list.length ? list.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.type || r.role || 'Aluno')}</td><td>${esc(r.course || r.class || 'Não se aplica')}</td><td>${esc(r.type === 'Aluno' ? r.matricula : r.cpf || 'Não informado')}</td><td>${esc(r.email || '—')}<br><small>${esc(r.phone || '')}</small></td><td><div class="action-row"><button class="small-btn primary" type="button" data-edit-reader="${r.id}">Editar</button><button class="small-btn danger" type="button" data-del-reader="${r.id}">Apagar</button></div></td></tr>`).join('') : '<tr><td colspan="6">Nenhum leitor cadastrado.</td></tr>';
  $$('[data-edit-reader]').forEach((b) => b.onclick = () => editReader(b.dataset.editReader)); 
  $$('[data-del-reader]').forEach((b) => b.onclick = () => removeReader(b.dataset.delReader)); 
  renderReaderSelector()
}

function isStudentReader(reader) {
  const type = String(reader?.type || '').toLocaleLowerCase('pt-BR')
  const role = String(reader?.role || '').toLocaleLowerCase('pt-BR')
  return type === 'aluno' || role === 'student' || (!type && !role)
}

function isTeacherReader(reader) {
  const type = String(reader?.type || '').toLocaleLowerCase('pt-BR')
  const role = String(reader?.role || '').toLocaleLowerCase('pt-BR')
  return type === 'professor' || role === 'teacher'
}

function count(list, key) { const map = new Map(); list.forEach((x) => { const k = key(x); map.set(k, (map.get(k) || 0) + 1) }); return [...map].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value) }

function loanQuantity(loan) {
  const quantity = Number(loan?.quantity || 1)
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1
}

function countLoanCopies(loans, key) {
  const map = new Map()
  loans.forEach((loan) => {
    const label = key(loan)
    map.set(label, (map.get(label) || 0) + loanQuantity(loan))
  })
  return [...map].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
}

function activeLoanCopiesForReader(readerId) {
  return state.loans
    .filter((loan) => loan.readerId === readerId && loan.status === 'active')
    .reduce((total, loan) => total + loanQuantity(loan), 0)
}

function updateLoanQuantityLimit(reader = null) {
  const field = $('#loanQuantityField')
  const input = $('#loanQuantity')
  const help = $('#loanQuantityHelp')
  const checkoutForm = field?.closest('.checkout-form')
  if (!field || !input) return

  if (!isTeacherReader(reader)) {
    field.hidden = true
    checkoutForm?.classList.remove('has-loan-quantity')
    input.value = '1'
    input.removeAttribute('max')
    if (help) help.hidden = true
    return
  }

  field.hidden = false
  checkoutForm?.classList.add('has-loan-quantity')
  const bookCode = $('#bookCodeInput')?.value.trim().toUpperCase()
  const book = state.books.find((item) => item.code?.toUpperCase() === bookCode)
  const remainingLimit = Math.max(0, getLoanLimitForReader(reader) - activeLoanCopiesForReader(reader.id))
  const maximum = Math.min(book?.available ?? remainingLimit, remainingLimit)
  input.max = String(maximum)
  input.disabled = maximum < 1
  input.value = String(Math.max(1, Math.min(Number(input.value) || 1, maximum || 1)))
  if (help) {
    help.textContent = maximum < 1
      ? book && Number(book.available || 0) < 1
        ? 'Este livro não tem exemplares disponíveis no momento.'
        : 'O leitor já atingiu o limite de empréstimos configurado.'
      : book
        ? `Informe de 1 a ${maximum} exemplares, respeitando o estoque e o limite configurado.`
        : `Limite restante: ${remainingLimit} exemplares. Informe o livro para conferir o estoque.`
    help.hidden = false
  }
}

function renderBars(target, data) { if (!target) return; if (!data.length) { target.innerHTML = '<p class="empty-state">Sem dados.</p>'; return }; const max = Math.max(...data.map((x) => x.value), 1); target.innerHTML = data.map((x) => `<div class="bar-row"><span>${esc(x.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${x.value / max * 100}%"></div></div><strong>${x.value}</strong></div>`).join('') }

function renderDashboard() {
  const active = state.loans.filter((l) => l.status === 'active')
  const activeCount = active.reduce((total, loan) => total + loanQuantity(loan), 0)
  const overdueCount = active.filter(overdue).reduce((total, loan) => total + loanQuantity(loan), 0)

  const values = [
    ['Total de Livros', state.books.reduce((n, b) => n + Number(b.total || 0), 0), '📚', 'acervo', ''],
    ['Exemplares Emprestados', activeCount, '📖', 'checkout', 'all'],
    ['Exemplares em Atraso', overdueCount, '⚠️', 'checkout', 'overdue'],
    ['Leitores Cadastrados', state.readers.length, '👥', 'leitores', '']
  ]

  const kpiGrid = $('#kpiGrid')
  if (kpiGrid) {
    kpiGrid.innerHTML = values.map(([name, value, icon, targetTab, targetFilter]) => `
      <div
        class="kpi-card panel clickable-kpi"
        data-target-tab="${targetTab}"
        data-target-filter="${targetFilter}"
        style="cursor: pointer;"
      >
        <div class="kpi-card-head">
          <span>${esc(name)}</span>
          <span class="kpi-icon">${icon}</span>
        </div>
        <div class="kpi-value">${value}</div>
      </div>
    `).join('')

    $$('.clickable-kpi').forEach((card) => {
      card.onclick = () => {
        const targetTab = card.dataset.targetTab
        if (!targetTab) return

        setAdminTab(targetTab)

        if (targetTab === 'checkout') {
          const filterSelect = $('#loanFilterSelect')
          const targetFilter = card.dataset.targetFilter || 'all'

          if (filterSelect) {
            filterSelect.value = targetFilter
            filterSelect.dispatchEvent(new Event('change', { bubbles: true }))
          } else {
            state.loanFilter = targetFilter
            renderLoans()
          }
        }

        $('.admin-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
  }

  const categoryNames = new Map()

  getCategoryOptions().forEach((category) => {
    const name = String(category.name || category.code || category.id || '').trim()
    if (!name) return

    for (const key of [category.id, category.code, category.name]) {
      if (key) categoryNames.set(String(key).trim().toLocaleLowerCase('pt-BR'), name)
    }
  })

  const booksByGenre = new Map()

  state.books.forEach((book) => {
    const categoryKey = String(book.categoryId || '').trim().toLocaleLowerCase('pt-BR')
    const categoryName = String(book.categoryName || '').trim()
    const codePrefix = String(book.code || '').match(/^([A-Z0-9]{1,4})-\d{4}$/i)?.[1]
    const genre =
      categoryNames.get(categoryKey) ||
      (categoryName && categoryName !== categoryKey ? categoryName : '') ||
      categoryNames.get(String(codePrefix || '').toLocaleLowerCase('pt-BR')) ||
      categoryName ||
      codePrefix ||
      'Sem categoria'

    booksByGenre.set(genre, (booksByGenre.get(genre) || 0) + 1)
  })

  const topGenres = [...booksByGenre]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, 'pt-BR'))
    .slice(0, 5)

  renderBars($('#genreChart'), topGenres)
  const total = state.books.reduce((n, b) => n + Number(b.total || 0), 0)
  const free = state.books.reduce((n, b) => n + Number(b.available || 0), 0)
  const percent = total ? Math.round(free / total * 100) : 0
  if ($('#statusDonut')) $('#statusDonut').innerHTML = `<div class="donut" style="background:conic-gradient(var(--success) 0 ${percent}%,var(--warning) ${percent}% 100%)"><div class="donut-center">${percent}%</div></div>`
  if ($('#statusLegend')) $('#statusLegend').innerHTML = `<div class="legend-item"><span class="legend-dot success"></span>Disponíveis: ${free}</div><div class="legend-item"><span class="legend-dot warning"></span>Emprestados: ${Math.max(0, total - free)}</div>`
  renderBars($('#courseChart'), countLoanCopies(active, (l) => l.readerCourse || 'Não informado').slice(0, 5))
  const top = countLoanCopies(state.loans, (l) => l.readerName || 'Leitor').slice(0, 5)
  if ($('#readerChart')) $('#readerChart').innerHTML = top.length ? top.map((x) => `<div class="list-item"><strong>${esc(x.label)}</strong><span>${x.value} exemplares</span></div>`).join('') : '<p class="empty-state">Sem dados.</p>'

  const currentYear = new Date().getFullYear()
  const monthCounts = Array.from({ length: 12 }, (_, index) => {
    const monthDate = new Date(currentYear, index, 1)
    return {
      key: `${monthDate.getFullYear()}-${monthDate.getMonth()}`,
      label: monthDate.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''),
      value: 0
    }
  })
  const monthCountByKey = new Map(monthCounts.map((month) => [month.key, month]))
  state.loans.forEach((loan) => {
    const createdAt = date(loan.createdAt)
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return
    const month = monthCountByKey.get(`${createdAt.getFullYear()}-${createdAt.getMonth()}`)
    if (month)     month.value += loanQuantity(loan)
  })
  renderBars($('#monthlyLoanChart'), monthCounts.some((month) => month.value > 0) ? monthCounts : [])

  const readerTypeCounts = new Map([
    ['Alunos', 0],
    ['Professores', 0],
    ['Outros', 0]
  ])
  state.readers.forEach((reader) => {
    const type = String(reader.type || reader.role || '').toLocaleLowerCase('pt-BR')
    const label = isStudentReader(reader)
      ? 'Alunos'
      : type === 'professor' || type === 'teacher'
        ? 'Professores'
        : 'Outros'
    readerTypeCounts.set(label, readerTypeCounts.get(label) + 1)
  })
  const readerTypeSegments = [...readerTypeCounts].map(([label, value], index) => ({
    label,
    value,
    color: ['var(--success)', 'var(--warning)', 'var(--primary)'][index]
  }))
  const readerTypeTotal = readerTypeSegments.reduce((sum, segment) => sum + segment.value, 0)
  let readerTypeDegrees = 0
  const readerTypeGradient = readerTypeTotal
    ? readerTypeSegments.map((segment, index) => {
      const start = readerTypeDegrees
      readerTypeDegrees += index === readerTypeSegments.length - 1
        ? 360 - readerTypeDegrees
        : segment.value / readerTypeTotal * 360
      return `${segment.color} ${start}deg ${readerTypeDegrees}deg`
    }).join(',')
    : 'var(--panel-muted) 0deg 360deg'
  if ($('#readerTypeDonut')) {
    $('#readerTypeDonut').innerHTML = `<div class="donut" style="background:conic-gradient(${readerTypeGradient})"><div class="donut-center">${readerTypeTotal}</div></div>`
  }
  if ($('#readerTypeLegend')) {
    $('#readerTypeLegend').innerHTML = readerTypeSegments.map((segment, index) => `<div class="legend-item"><span class="legend-dot ${['success', 'warning', 'reader-other'][index]}"></span>${segment.label}: ${segment.value}</div>`).join('')
  }

  renderBars(
    $('#topBooksChart'),
    countLoanCopies(state.loans, (loan) => loan.bookTitle || loan.bookCode || 'Livro sem título').slice(0, 5)
  )

  const readersById = new Map(state.readers.map((reader) => [reader.id, reader]))
  const activeLoansByReaderType = count(active, (loan) => {
    const reader = readersById.get(loan.readerId)
    return reader && isStudentReader(reader) ? 'Alunos' : 'Professores e outros'
  })
  renderBars($('#loansByReaderTypeChart'), activeLoansByReaderType)
}

function dashboardExportPeriod() {
  const selected = $('#dashboardExportPeriod')?.value || '30'
  const now = new Date()
  const start = selected === 'all'
    ? new Date(0)
    : new Date(now.getTime() - Number(selected) * 86400000)
  const loans = state.loans.filter((loan) => {
    if (selected === 'all') return true
    const createdAt = date(loan.createdAt)
    return createdAt instanceof Date && !Number.isNaN(createdAt.getTime()) && createdAt >= start && createdAt <= now
  })
  const returns = state.loans.filter((loan) => {
    const returnedAt = date(loan.returnedAt)
    return returnedAt instanceof Date && !Number.isNaN(returnedAt.getTime()) &&
      (selected === 'all' || (returnedAt >= start && returnedAt <= now))
  })
  return {
    now,
    start,
    period: selected,
    loans,
    returns,
    label: selected === 'all'
      ? 'Todo o período'
      : `${start.toLocaleDateString('pt-BR')} a ${now.toLocaleDateString('pt-BR')}`
  }
}

function dashboardExportData() {
  const period = dashboardExportPeriod()
  const readerById = new Map(state.readers.map((reader) => [reader.id, reader]))
  const groupLoans = (keyForLoan) => countLoanCopies(period.loans, keyForLoan).slice(0, 5)
  const loanReaderType = (loan) => {
    const reader = readerById.get(loan.readerId)
    if (isStudentReader(reader)) return 'Alunos'
    if (isTeacherReader(reader)) return 'Professores'
    return 'Outros'
  }
  const genreData = count(state.books, (book) => bookCategoryName(book)).slice(0, 5)
  const monthlyBuckets = Array.from({ length: 6 }, (_, index) => {
    const start = new Date(period.now.getFullYear(), period.now.getMonth() - 5 + index, 1)
    return {
      label: start.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''),
      value: 0
    }
  })
  const monthlyByKey = new Map(monthlyBuckets.map((bucket, index) => {
    const start = new Date(period.now.getFullYear(), period.now.getMonth() - 5 + index, 1)
    return [`${start.getFullYear()}-${start.getMonth()}`, bucket]
  }))
  period.loans.forEach((loan) => {
    const createdAt = date(loan.createdAt)
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return
    const bucket = monthlyByKey.get(`${createdAt.getFullYear()}-${createdAt.getMonth()}`)
    if (bucket) bucket.value += loanQuantity(loan)
  })
  return {
    ...period,
    readerById,
    charts: [
      { title: 'Top 5 Gêneros', kind: 'bars', data: genreData },
      { title: 'Status do Acervo', kind: 'donut', data: [
        { label: 'Disponíveis', value: state.books.reduce((sum, book) => sum + Number(book.available || 0), 0) },
        { label: 'Emprestados', value: Math.max(0, state.books.reduce((sum, book) => sum + Number(book.total || 0), 0) - state.books.reduce((sum, book) => sum + Number(book.available || 0), 0)) }
      ] },
      { title: 'Empréstimos por Curso/Turma', kind: 'bars', data: groupLoans((loan) => loan.readerCourse || 'Não informado') },
      { title: 'Top Leitores', kind: 'bars', data: groupLoans((loan) => loan.readerName || 'Leitor') },
      { title: 'Empréstimos por mês', kind: 'bars', data: monthlyBuckets.filter((bucket) => bucket.value > 0) },
      { title: 'Perfil dos leitores', kind: 'donut', data: [
        { label: 'Alunos', value: state.readers.filter(isStudentReader).length },
        { label: 'Professores', value: state.readers.filter(isTeacherReader).length },
        { label: 'Outros', value: state.readers.filter((reader) => !isStudentReader(reader) && !isTeacherReader(reader)).length }
      ] },
      { title: 'Livros mais emprestados', kind: 'bars', data: groupLoans((loan) => loan.bookTitle || loan.bookCode || 'Livro sem título') },
      { title: 'Exemplares emprestados por perfil', kind: 'bars', data: groupLoans(loanReaderType) }
    ]
  }
}

function createDashboardExportCanvas(data) {
  const canvas = document.createElement('canvas')
  canvas.width = 1600
  canvas.height = 2263
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Não foi possível preparar a imagem dos gráficos.')
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const palette = dark
    ? { page: '#10161e', panel: '#18212b', text: '#eef3f8', muted: '#b3bfca', line: '#364453', track: '#303d4c', colors: ['#4778f5', '#4fdb93', '#ffca6e', '#c09aff', '#ff8389'] }
    : { page: '#f3f7f4', panel: '#ffffff', text: '#17251c', muted: '#4d5d52', line: '#c7d8cc', track: '#e8efea', colors: ['#2457d6', '#087a49', '#e99424', '#8b4bd8', '#c33d4b'] }
  context.fillStyle = palette.page
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = palette.text
  context.font = '700 42px Arial'
  context.fillText('Libris — Gráficos gerais', 64, 76)
  context.fillStyle = palette.muted
  context.font = '24px Arial'
  context.fillText(`${config.schoolName || 'Biblioteca escolar'} · ${data.label}`, 64, 120)
  const columns = 2
  const margin = 64
  const gapX = 28
  const gapY = 24
  const top = 158
  const cardWidth = (canvas.width - margin * 2 - gapX) / columns
  const cardHeight = (canvas.height - top - margin - gapY * 3) / 4
  data.charts.forEach((chart, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = margin + column * (cardWidth + gapX)
    const y = top + row * (cardHeight + gapY)
    context.fillStyle = palette.panel
    context.strokeStyle = palette.line
    context.lineWidth = 2
    context.fillRect(x, y, cardWidth, cardHeight)
    context.strokeRect(x, y, cardWidth, cardHeight)
    context.fillStyle = palette.text
    context.font = '700 24px Arial'
    context.fillText(chart.title, x + 24, y + 44, cardWidth - 48)

    if (chart.kind === 'donut') {
      const total = chart.data.reduce((sum, item) => sum + item.value, 0)
      const centerX = x + cardWidth / 2
      const centerY = y + cardHeight * 0.53
      const radius = Math.min(115, cardWidth * 0.22)
      let angle = -Math.PI / 2
      chart.data.forEach((item, itemIndex) => {
        if (total <= 0 || !item.value) return
        const nextAngle = angle + item.value / total * Math.PI * 2
        context.beginPath()
        context.moveTo(centerX, centerY)
        context.arc(centerX, centerY, radius, angle, nextAngle)
        context.closePath()
        context.fillStyle = palette.colors[itemIndex % palette.colors.length]
        context.fill()
        angle = nextAngle
      })
      context.beginPath()
      context.arc(centerX, centerY, radius * 0.58, 0, Math.PI * 2)
      context.fillStyle = palette.panel
      context.fill()
      context.fillStyle = palette.text
      context.textAlign = 'center'
      context.font = '700 28px Arial'
      context.fillText(String(total), centerX, centerY + 10)
      context.textAlign = 'start'
      chart.data.forEach((item, itemIndex) => {
        const legendY = y + cardHeight - 70 + itemIndex * 28
        context.fillStyle = palette.colors[itemIndex % palette.colors.length]
        context.fillRect(x + 35, legendY - 14, 18, 18)
        context.fillStyle = palette.muted
        context.font = '18px Arial'
        context.fillText(`${item.label}: ${item.value}`, x + 64, legendY, cardWidth - 90)
      })
      if (!total) {
        context.fillStyle = palette.muted
        context.textAlign = 'center'
        context.font = '20px Arial'
        context.fillText('Sem dados.', centerX, centerY + radius + 42)
        context.textAlign = 'start'
      }
      return
    }

    if (!chart.data.length) {
      context.fillStyle = palette.muted
      context.font = '20px Arial'
      context.textAlign = 'center'
      context.fillText('Sem dados no período.', x + cardWidth / 2, y + cardHeight / 2)
      context.textAlign = 'start'
      return
    }
    const items = chart.data.slice(0, 6)
    const max = Math.max(...items.map((item) => item.value), 1)
    const rowHeight = Math.min(54, (cardHeight - 90) / items.length)
    items.forEach((item, itemIndex) => {
      const rowY = y + 86 + itemIndex * rowHeight
      const labelWidth = cardWidth * 0.34
      const trackX = x + labelWidth + 36
      const trackWidth = cardWidth - labelWidth - 105
      context.fillStyle = palette.text
      context.font = '18px Arial'
      context.fillText(item.label, x + 24, rowY + 20, labelWidth - 40)
      context.fillStyle = palette.track
      context.fillRect(trackX, rowY, trackWidth, 18)
      context.fillStyle = palette.colors[0]
      context.fillRect(trackX, rowY, Math.max(item.value ? 4 : 0, trackWidth * item.value / max), 18)
      context.fillStyle = palette.text
      context.textAlign = 'right'
      context.font = '700 18px Arial'
      context.fillText(String(item.value), x + cardWidth - 24, rowY + 18)
      context.textAlign = 'start'
    })
  })
  return canvas
}

function dashboardExportFilename(suffix, extension) {
  const schoolId = String(config.currentSchoolId || 'escola').replace(/[^a-z0-9_-]/gi, '_')
  return `libris-${suffix}-${schoolId}-${new Date().toISOString().slice(0, 10)}.${extension}`
}

async function downloadDashboardChartsJpg() {
  const button = $('#downloadDashboardJpgBtn')
  const filename = dashboardExportFilename('graficos', 'jpg')
  loading(button, true, 'Preparando JPG…')
  try {
    const target = await chooseSaveTarget(filename, 'Imagem JPG', ['jpg'])
    if (!target) return
    const canvas = createDashboardExportCanvas(dashboardExportData())
    await saveBlobToTarget(await canvasToBlob(canvas), target)
  } catch (err) {
    console.error('Falha ao exportar gráficos JPG:', err)
    error(err, 'Não foi possível baixar os gráficos em JPG.')
  } finally {
    loading(button, false)
  }
}

async function downloadDashboardChartsPdf() {
  const button = $('#downloadDashboardPdfBtn')
  const filename = dashboardExportFilename('graficos', 'pdf')
  loading(button, true, 'Preparando PDF…')
  try {
    const target = await chooseSaveTarget(filename, 'Documento PDF', ['pdf'])
    if (!target) return
    const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
    const canvas = createDashboardExportCanvas(dashboardExportData())
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.94), 'JPEG', 0, 0, 210, 297)
    pdf.setProperties({ title: `Gráficos gerais - ${config.schoolName}`, author: 'Libris' })
    await saveBlobToTarget(pdf.output('blob'), target)
  } catch (err) {
    console.error('Falha ao exportar gráficos PDF:', err)
    error(err, 'Não foi possível baixar os gráficos em PDF.')
  } finally {
    loading(button, false)
  }
}

async function downloadDashboardReport() {
  const button = $('#downloadDashboardReportBtn')
  const filename = dashboardExportFilename('relatorio', 'pdf')
  loading(button, true, 'Preparando relatório…')
  try {
    const target = await chooseSaveTarget(filename, 'Documento PDF', ['pdf'])
    if (!target) return
    const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
    const data = dashboardExportData()
    const active = data.loans.filter((loan) => loan.status === 'active')
    const overdueCount = active.filter(overdue).reduce((total, loan) => total + loanQuantity(loan), 0)
    const profileCounts = countLoanCopies(data.loans, (loan) => {
      const reader = data.readerById.get(loan.readerId)
      if (isStudentReader(reader)) return 'Alunos'
      if (isTeacherReader(reader)) return 'Professores'
      return 'Outros'
    })
    const topBooks = countLoanCopies(data.loans, (loan) => loan.bookTitle || loan.bookCode || 'Livro sem título').slice(0, 5)
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
    const left = 18
    const width = 174
    let y = 22
    const addLine = (text, options = {}) => {
      pdf.setFont('helvetica', options.bold ? 'bold' : 'normal')
      pdf.setFontSize(options.size || 11)
      const lines = pdf.splitTextToSize(String(text), width)
      const height = lines.length * (options.lineHeight || 6)
      if (y + height > 280) {
        pdf.addPage()
        y = 20
      }
      pdf.text(lines, left, y)
      y += height + (options.gap ?? 2)
    }
    addLine('Libris — Relatório da biblioteca', { bold: true, size: 18, lineHeight: 9, gap: 2 })
    addLine(config.schoolName || 'Biblioteca escolar', { bold: true, size: 13, lineHeight: 7 })
    addLine(`Período: ${data.label}`)
    addLine(`Gerado em: ${new Date().toLocaleString('pt-BR')}`)
    y += 3
    addLine('Resumo do período', { bold: true, size: 14, lineHeight: 7 })
    addLine(`Exemplares emprestados no período: ${data.loans.reduce((total, loan) => total + loanQuantity(loan), 0)}`)
    addLine(`Exemplares devolvidos no período: ${data.returns.reduce((total, loan) => total + loanQuantity(loan), 0)}`)
    addLine(`Exemplares ativos referentes ao período: ${active.reduce((total, loan) => total + loanQuantity(loan), 0)}`)
    addLine(`Exemplares em atraso entre os ativos: ${overdueCount}`)
    addLine(`Leitores cadastrados atualmente: ${state.readers.length}`)
    addLine(`Exemplares no acervo atualmente: ${state.books.reduce((sum, book) => sum + Number(book.total || 0), 0)}`)
    y += 3
    addLine('Exemplares emprestados por perfil', { bold: true, size: 14, lineHeight: 7 })
    if (profileCounts.length) profileCounts.forEach((item) => addLine(`${item.label}: ${item.value}`))
    else addLine('Sem empréstimos registrados no período.')
    y += 3
    addLine('Livros mais emprestados no período', { bold: true, size: 14, lineHeight: 7 })
    if (topBooks.length) topBooks.forEach((item, index) => addLine(`${index + 1}. ${item.label}: ${item.value}`))
    else addLine('Sem empréstimos registrados no período.')
    pdf.setProperties({ title: `Relatório Libris - ${config.schoolName}`, author: 'Libris' })
    await saveBlobToTarget(pdf.output('blob'), target)
  } catch (err) {
    console.error('Falha ao gerar relatório:', err)
    error(err, 'Não foi possível gerar o relatório PDF.')
  } finally {
    loading(button, false)
  }
}

/* -------------------------
   CRUD Admin actions
   ------------------------- */
function normalizeBookCode(value) {
  return String(value ?? '').replace(/\D+/g, '').slice(0, 4).padStart(4, '0')
}

function getLastBookSequence(prefix) {
  return state.books.reduce((lastCode, book) => {
    const [bookPrefix, sequence] = String(book.code || '').split('-')
    const numericSequence = Number(sequence)
    return bookPrefix === prefix && Number.isInteger(numericSequence) ? Math.max(lastCode, numericSequence) : lastCode
  }, 0)
}

function getLoanLimitForReader(reader = {}) {
  return isTeacherReader(reader) ? Number(config.maxBooksTeacher || 35) : Number(config.maxBooksStudent || 2)
}

async function logAudit(action, details = {}, actorUid = null) {
  if (!db) return
  try {
    await addDoc(collection(db, 'audit_logs'), {
      actorUid: actorUid || state.user?.uid || null,
      schoolId: config.currentSchoolId,
      action,
      details: details || {},
      timestamp: serverTimestamp()
    })
  } catch (err) {
    console.warn('Não foi possível registrar auditoria:', err)
  }
}

/* Book form: add / edit */
async function addBook(event) {
  event.preventDefault()
  const button = $('#bookForm button[type="submit"]')
  const editingId = $('#bookIdInput')?.value
  const categoryId = $('#bookCategoryInput')?.value
  const selectedCategory = getCategoryOptions().find((c) => c.id === categoryId || c.code === categoryId)
  const title = $('#bookTitleInput')?.value.trim()
  const author = $('#bookAuthorInput')?.value.trim()
  const publisher = $('#bookPublisherInput')?.value.trim()
  const existingBook = editingId ? state.books.find((item) => item.id === editingId) : null
  const existingMeta = editingId ? { synopsis: existingBook?.synopsis || '', coverUrl: existingBook?.coverUrl || '' } : await lookupBookMetadata(title, author, publisher)
  const book = {
    title,
    author,
    publisher,
    categoryId,
    year: Number($('#bookYearInput')?.value || 2026),
    shelf: $('#bookShelfInput')?.value.trim() || '',
    total: Number($('#bookQuantityInput')?.value || 1),
    tombamento: $('#bookTombamentoInput')?.value.trim() || '',
    synopsis: existingMeta.synopsis,
    coverUrl: existingMeta.coverUrl
  }
  const borrowedCopies = existingBook ? Number(existingBook.total || 0) - Number(existingBook.available || 0) : 0
  if (!book.title || !book.author || !Number.isInteger(book.total) || book.total < 1 || book.total < borrowedCopies) return toast(book.total < borrowedCopies ? `A quantidade não pode ser menor que os ${borrowedCopies} exemplares emprestados.` : 'Preencha título, autor, categoria e quantidade válida.', 'error')

  loading(button, true, 'Salvando…')

  try {
    if (editingId) {
      const availableCopies = book.total - borrowedCopies
      await updateDoc(doc(db, 'books', editingId), { ...book, available: availableCopies, status: availableCopies ? 'disponivel' : 'emprestado', categoryName: selectedCategory?.name || categoryId, schoolId: config.currentSchoolId, updatedAt: serverTimestamp() })
      await logAudit('book_updated', { bookId: editingId, total: book.total }, state.user?.uid || null)
      resetBookForm()
      modal('bookFormModal', false)
      toast('Livro atualizado com sucesso.')
      return
    }

    const prefix = String(categoryId || 'GE').trim().toUpperCase()
    const categoryName = selectedCategory?.name || prefix
    const counterRef = doc(db, 'counters', `${encodeURIComponent(config.currentSchoolId)}_books_${prefix}`)
    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const lastCode = Math.max(Number(counterSnap.exists() ? counterSnap.data().lastCode || 0 : 0), getLastBookSequence(prefix))
      const nextCodeNumber = lastCode + 1
      const numberCode = normalizeBookCode(nextCodeNumber)
      const code = `${prefix}-${numberCode}`
      tx.set(counterRef, {
        prefix,
        schoolId: config.currentSchoolId,
        lastCode: nextCodeNumber,
        updatedAt: serverTimestamp()
      }, { merge: true })
      tx.set(doc(collection(db, 'books')), {
        ...book,
        code,
        categoryId: prefix,
        categoryName: categoryName,
        schoolId: config.currentSchoolId,
        available: book.total,
        total: book.total,
        status: 'disponivel',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    })
    
    await logAudit('book_created', { title: book.title, categoryId: book.categoryId, total: book.total }, state.user?.uid || null)
    resetBookForm()
    modal('bookFormModal', false)
    toast('Livro cadastrado com sucesso.')
  } catch (err) { error(err, 'Não foi possível salvar o livro.') } finally { loading(button, false) }
}

/* Categories */
async function addCategory(event) {
  event.preventDefault()
  const button = $('#categoryForm button[type="submit"]')
  const name = $('#categoryNameInput')?.value.trim()
  const code = $('#categoryCodeInput')?.value.trim()
  if (!name || !code) return toast('Informe nome e código da categoria.', 'error')
  const normalizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
  if (!normalizedCode) return toast('Código inválido para categoria.', 'error')
  if (getCategoryOptions().some((category) => category.name.toLowerCase() === name.toLowerCase() || category.code?.toLowerCase() === normalizedCode.toLowerCase())) return toast('Essa categoria já existe.', 'error')
  loading(button, true, 'Salvando…')
  try {
    const categoryRef = doc(db, 'categories', `${encodeURIComponent(config.currentSchoolId)}__${normalizedCode}`)
    await setDoc(categoryRef, { id: normalizedCode, name, code: normalizedCode, schoolId: config.currentSchoolId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true })
    if ($('#categoryForm')) $('#categoryForm').reset(); 
    renderCategorySelect(); 
    renderCategoryList(); 
    modal('categoryModal', false);
    toast('Categoria salva com sucesso.')
  } catch (err) { error(err, 'Não foi possível salvar a categoria.') } finally { loading(button, false) }
}

async function removeCategory(id) {
  if (!confirm('Apagar esta categoria?')) return
  try {
    await deleteDoc(doc(db, 'categories', id))
    toast('Categoria apagada.')
  } catch (err) { error(err, 'Não foi possível apagar a categoria.') }
}

/* Readers */
async function addReader(event) {
  event.preventDefault()
  const button = $('#readerForm button[type="submit"]')
  const editingId = $('#readerIdInput')?.value
  const type = $('#readerTypeInput')?.value || 'Aluno'
  const role = type === 'Aluno' ? 'student' : type === 'Professor' ? 'teacher' : 'other'
  const reader = {
    schoolId: config.currentSchoolId,
    name: $('#readerNameInput')?.value.trim(),
    type,
    role,
    class: type === 'Aluno' ? $('#readerCourseInput')?.value.trim() : '',
    course: type === 'Aluno' ? $('#readerCourseInput')?.value.trim() : '',
    matricula: type === 'Aluno' ? $('#readerRegistrationInput')?.value.trim() : '',
    cpf: type !== 'Aluno' ? $('#readerCpfInput')?.value.trim() : '',
    email: $('#readerEmailInput')?.value.trim(),
    phone: $('#readerPhoneInput')?.value.trim()
  }
  if (!reader.name || !reader.email || !reader.phone || (type === 'Aluno' && (!reader.course || !reader.matricula)) || (type !== 'Aluno' && !reader.cpf)) return toast('Preencha todos os campos obrigatórios.', 'error')
  loading(button, true, editingId ? 'Atualizando…' : 'Salvando…')
  try {
    if (editingId) {
      await updateDoc(doc(db, 'readers', editingId), { ...reader, updatedAt: serverTimestamp() })
      resetReaderForm()
      modal('readerFormModal', false)
      toast('Leitor atualizado com sucesso.')
    } else {
      await addDoc(collection(db, 'readers'), { ...reader, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
      resetReaderForm()
      modal('readerFormModal', false)
      toast('Leitor cadastrado com sucesso.')
    }
  } catch (err) { error(err, 'Não foi possível salvar o leitor.') } finally { loading(button, false) }
}

/* Remove book / reader */
async function removeBook(id) {
  if (state.loans.some((loan) => loan.bookId === id && loan.status === 'active')) return toast('Não é possível apagar um livro com empréstimo ativo.', 'error')
  if (!confirm('Apagar este livro?')) return
  try { await deleteDoc(doc(db, 'books', id)); toast('Livro apagado.') } catch (err) { error(err, 'Não foi possível apagar o livro.') }
}

async function removeReader(id) {
  if (state.loans.some((loan) => loan.readerId === id && loan.status === 'active')) return toast('Não é possível apagar um leitor com empréstimo ativo.', 'error')
  if (!confirm('Apagar este leitor?')) return
  try { await deleteDoc(doc(db, 'readers', id)); toast('Leitor apagado.') } catch (err) { error(err, 'Não foi possível apagar o leitor.') }
}

/* Loans */
async function registerLoan() {
  const button = $('#registerLoanBtn')
  const code = $('#bookCodeInput')?.value.trim().toUpperCase()
  const text = $('#readerInput')?.value.trim()
  const selectedReaderId = $('#loanReaderIdInput')?.value
  const days = Number($('#loanDays')?.value)
  const book = state.books.find((b) => b.code?.toUpperCase() === code)
  const reader = selectedReaderId ? state.readers.find((r) => r.id === selectedReaderId) : state.readers.find((r) => r.matricula === text || r.name?.toLocaleLowerCase('pt-BR') === text?.toLocaleLowerCase('pt-BR'))

  if (!book || !reader) {
    return toast(!book ? 'Livro não encontrado.' : 'Leitor não encontrado.', 'error')
  }

  const quantity = isTeacherReader(reader) ? Number($('#loanQuantity')?.value || 1) : 1
  const activeLoansForReader = activeLoanCopiesForReader(reader.id)
  const loanLimit = getLoanLimitForReader(reader)

  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return toast('Informe uma quantidade inteira de exemplares maior que zero.', 'error')
  }

  if (activeLoansForReader + quantity > loanLimit) {
    return toast(`O limite para ${reader.role || reader.type || 'este perfil'} é de ${loanLimit} exemplares ativos. Já possui ${activeLoansForReader}; pode emprestar mais ${Math.max(0, loanLimit - activeLoansForReader)}.`, 'error')
  }

  const duplicateLoansSnap = await getDocs(query(
    collection(db, 'loans'),
    where('schoolId', '==', config.currentSchoolId),
    where('readerId', '==', reader.id),
    where('bookId', '==', book.id),
    where('status', '==', 'active')
  ))

  if (!duplicateLoansSnap.empty) {
    return toast('Este leitor já possui um empréstimo ativo para este mesmo livro!', 'error')
  }

  const maxLoanDays = getMaxLoanDaysForReader(reader)
  if (!Number.isSafeInteger(days) || days < 1 || (maxLoanDays !== null && days > maxLoanDays)) {
    updateLoanDaysLimit(reader)
    const message = maxLoanDays === null
      ? 'Informe um prazo em dias como número inteiro maior que zero.'
      : `O prazo deve ser entre 1 e ${maxLoanDays} dias para este perfil.`
    return toast(message, 'error')
  }

  loading(button, true, 'Registrando…')

  try {
    await runTransaction(db, async (tx) => {
      const bookRef = doc(db, 'books', book.id)
      const bookSnap = await tx.get(bookRef)

      const availableCopies = Number(bookSnap.data()?.available || 0)
      if (!bookSnap.exists() || availableCopies < quantity) {
        throw new Error('indisponível')
      }

      const due = new Date()
      const effectiveDays = days
      due.setDate(due.getDate() + effectiveDays)
      if (Number.isNaN(due.getTime())) throw new Error('prazo inválido')

      tx.update(bookRef, {
        available: increment(-quantity),
        status: availableCopies - quantity > 0 ? 'disponivel' : 'emprestado',
        schoolId: bookSnap.data().schoolId || config.currentSchoolId,
        updatedAt: serverTimestamp()
      })

      tx.set(doc(collection(db, 'loans')), {
        schoolId: config.currentSchoolId,
        bookId: book.id,
        bookCode: book.code,
        bookTitle: book.title,
        readerId: reader.id,
        readerName: reader.name,
        readerCourse: reader.course || 'Não se aplica',
        readerEmail: reader.email || '',
        quantity,
        days: effectiveDays,
        dueAt: Timestamp.fromDate(due),
        status: 'active',
        notices: {},
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    })

    await logAudit('loan_created', { bookId: book.id, readerId: reader.id, quantity, days }, state.user?.uid || null)
    if ($('#bookCodeInput')) $('#bookCodeInput').value = ''
    if ($('#readerInput')) $('#readerInput').value = ''
    if ($('#loanReaderIdInput')) $('#loanReaderIdInput').value = ''
    updateLoanQuantityLimit(null)
    updateLoanDaysLimit(null, true)
    if ($('#readerSuggestions')) $('#readerSuggestions').hidden = true
    if ($('#bookCodeInput')) $('#bookCodeInput').focus()
    toast('Empréstimo registrado.')
  } catch (err) {
    if (err.message === 'indisponível') {
      toast('Livro indisponível.', 'error')
      return
    }
    error(err, 'Não foi possível registrar o empréstimo.')
  } finally {
    loading(button, false)
  }
}

async function returnLoan(id) {
  try {
    await runTransaction(db, async (tx) => {
      const loanRef = doc(db, 'loans', id)
      const loanSnap = await tx.get(loanRef)
      if (!loanSnap.exists() || loanSnap.data().status !== 'active') throw new Error('inválido')
      const quantity = loanQuantity(loanSnap.data())
      const bookRef = doc(db, 'books', loanSnap.data().bookId)
      const bookSnap = await tx.get(bookRef)

      tx.update(loanRef, { status: 'returned', returnedAt: serverTimestamp(), updatedAt: serverTimestamp(), schoolId: loanSnap.data().schoolId || config.currentSchoolId })

      if (bookSnap.exists()) {
        const free = Math.min(Number(bookSnap.data().available || 0) + quantity, Number(bookSnap.data().total || 0))
        tx.update(bookRef, { available: free, status: free ? 'disponivel' : 'emprestado', updatedAt: serverTimestamp(), schoolId: bookSnap.data().schoolId || config.currentSchoolId })
      }
    })
    await logAudit('loan_returned', { loanId: id }, state.user?.uid || null)
    toast('Livro devolvido.')
  } catch (err) {
    error(err, 'Não foi possível registrar a devolução.')
  }
}

async function renewLoan(id) {
  const loan = state.loans.find((l) => l.id === id)
  if (!loan) return
  const select = document.querySelector?.(`[data-renew-days="${id}"]`)
  const days = Number(select?.value || loan.days || 7)
  const reader = state.readers.find((item) => item.id === loan.readerId)
  const maximum = getMaxLoanDaysForReader(reader)
  if (!Number.isSafeInteger(days) || days < 1 || (maximum !== null && days > maximum)) {
    toast(maximum === null
      ? 'Informe um prazo em dias como número inteiro maior que zero.'
      : `A renovação deve ser entre 1 e ${maximum} dias para este perfil.`, 'error')
    return
  }
  try {
    const due = date(loan.dueAt) ? new Date(date(loan.dueAt)) : new Date()
    due.setDate(due.getDate() + days)
    if (Number.isNaN(due.getTime())) throw new Error('prazo inválido')
    await updateDoc(doc(db, 'loans', id), { days, dueAt: Timestamp.fromDate(due), notices: {}, schoolId: config.currentSchoolId, updatedAt: serverTimestamp() })
    await logAudit('loan_renewed', { loanId: id, days }, state.user?.uid || null)
    toast(`Renovação concluída por ${days} dias.`)
  } catch (err) { error(err, 'Não foi possível renovar o empréstimo.') }
}

/* Notifications */
function normalizePhone(phone = '') {
  return String(phone || '').replace(/\D/g, '')
}

async function openWhatsAppMessage(reader, message) {
  let phone = normalizePhone(reader?.phone)
  if (!phone) {
    toast('Este leitor não possui telefone cadastrado para WhatsApp.', 'error')
    return false
  }

  if (phone.length === 10 || phone.length === 11) {
    phone = `55${phone}`
  } else if (!phone.startsWith('55') || ![12, 13].includes(phone.length)) {
    toast('O telefone precisa incluir um número brasileiro válido com DDD.', 'error')
    return false
  }

  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
  try {
    if (isTauri()) {
      await open(url)
    } else {
      const openedWindow = window.open(url, '_blank')
      if (!openedWindow) throw new Error('A janela do WhatsApp foi bloqueada pelo navegador.')
    }
    return true
  } catch (err) {
    console.error('Falha ao abrir o WhatsApp:', err)
    toast('Não foi possível abrir o link do WhatsApp.', 'error')
    return false
  }
}

const EMAIL_AUDIT_LIMIT = 100

async function logSentEmail(recipient, subject) {
  const sentAt = new Date()
  await localStore.put('email_logs', {
    id: `${sentAt.getTime()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2)}`,
    schoolId: config.currentSchoolId,
    recipient,
    subject,
    sentAt: sentAt.toISOString(),
    status: 'sent'
  })

  const schoolLogs = (await localStore.list('email_logs'))
    .filter((record) => record.schoolId === config.currentSchoolId)
    .sort((left, right) => new Date(right.sentAt).getTime() - new Date(left.sentAt).getTime())
  await Promise.all(schoolLogs.slice(EMAIL_AUDIT_LIMIT).map((record) => localStore.remove('email_logs', record.id)))
}

async function sendEmailNotification(recipient, subject, message, htmlBody) {
  const email = String(recipient || '').trim()
  const smtp = config.smtp || {}
  if (!email) {
    toast('Endereço de e-mail não informado.', 'error')
    return { sent: false, audited: false }
  }
  if (!isTauri()) {
    toast('O envio SMTP está disponível apenas no aplicativo desktop Libris.', 'error')
    return { sent: false, audited: false }
  }
  if (!smtp.host || !smtp.username || ![465, 587].includes(Number(smtp.port))) {
    toast('Configure host, porta e usuário SMTP na administração CREDE.', 'error')
    return { sent: false, audited: false }
  }

  try {
    await invoke('send_email', {
      schoolId: config.currentSchoolId,
      smtpHost: smtp.host,
      smtpPort: Number(smtp.port),
      smtpUsername: smtp.username,
      recipient: email,
      subject,
      body: message,
      htmlBody
    })
  } catch (err) {
    console.error('Falha no envio SMTP:', err)
    toast(typeof err === 'string' ? err : 'Não foi possível enviar o e-mail. Verifique a configuração SMTP e a conexão.', 'error')
    return { sent: false, audited: false }
  }

  try {
    await logSentEmail(email, subject)
    return { sent: true, audited: true }
  } catch (err) {
    console.error('E-mail enviado, mas a auditoria local falhou:', err)
    return { sent: true, audited: false }
  }
}

async function sendEmailFromButton(button, recipient, subject, message, htmlBody) {
  loading(button, true, 'Enviando…')
  try {
    return await sendEmailNotification(recipient, subject, message, htmlBody)
  } finally {
    loading(button, false)
  }
}

async function updateEmailCredentialStatus(elementId, schoolId = config.currentSchoolId) {
  const status = $(`#${elementId}`)
  if (!status) return
  if (!isTauri()) {
    status.textContent = 'Configure e envie e-mails pelo aplicativo desktop Libris.'
    return
  }
  if (elementId === 'notificationEmailStatus' && (!config.smtp?.host || !config.smtp?.username)) {
    status.textContent = 'Servidor SMTP não configurado. Solicite a configuração à administração CREDE.'
    return
  }
  if (!schoolId) {
    status.textContent = 'Cadastre a escola para consultar o cofre seguro.'
    return
  }

  try {
    const saved = await invoke('has_smtp_password', { schoolId })
    status.textContent = saved
      ? 'Senha de app guardada no cofre seguro do sistema.'
      : 'Nenhuma senha SMTP salva no cofre seguro.'
  } catch (err) {
    console.error('Falha ao consultar a senha SMTP:', err)
    status.textContent = 'Não foi possível consultar o cofre seguro do sistema.'
  }
}

async function removeSmtpPassword() {
  const schoolId = $('#librisConfigForm')?.dataset.schoolId || ''
  if (!schoolId) return toast('Cadastre a escola antes de remover a senha salva.', 'error')
  if (!isTauri()) return toast('O cofre de credenciais só está disponível no aplicativo desktop Libris.', 'error')
  if (!confirm('Remover a senha SMTP salva no cofre seguro deste computador?')) return

  try {
    await invoke('delete_smtp_password', { schoolId })
    await updateEmailCredentialStatus('librisSmtpCredentialStatus', schoolId)
    toast('Senha SMTP removida do cofre seguro.')
  } catch (err) {
    error(err, 'Não foi possível remover a senha SMTP do cofre seguro.')
  }
}

async function triggerNotification(type) {
  const notificationModal = $('#notificationModal')
  const loanId = notificationModal?.dataset.loanId
  const loan = state.loans.find((item) => item.id === loanId)
  const reader = state.readers.find((item) => item.id === loan?.readerId)
  const message = $('#notificationMessage')?.value.trim()

  if (!loan || !reader || !message) {
    return toast('Não foi possível enviar a notificação. Empréstimo ou leitor não encontrado.', 'error')
  }

  if (type === 'coordination') {
    const coordEmail = (config.coordinationEmail || $('#coordinationEmailInput')?.value || '').trim()

    if (!coordEmail) {
      return toast('Cadastre e salve o e-mail da coordenação nas configurações da escola.', 'error')
    }

    const coordination = { 
      name: 'Coordenação', 
      email: coordEmail 
    }

    const subject = `Empréstimo em atraso - ${config.schoolName}`
    const coordinationMessage = `Olá, coordenação. O empréstimo de ${loanQuantity(loan)} exemplar(es) do livro "${loan.bookTitle}" para o(a) leitor(a) ${loan.readerName} está em atraso desde ${formatDate(loan.dueAt)}.`
    const dueDate = date(loan.dueAt)
    const daysOverdue = dueDate && !Number.isNaN(dueDate.getTime())
      ? Math.max(0, Math.ceil((Date.now() - dueDate.getTime()) / 86400000))
      : 0
    const htmlBody = createCoordinationEmailHtml({
      subject,
      schoolName: config.schoolName,
      message: coordinationMessage,
      readerName: loan.readerName,
      bookTitle: loan.bookTitle,
      dueDate: formatDate(loan.dueAt),
      daysOverdue
    })
    const result = await sendEmailFromButton($('#sendCoordinationBtn'), coordination.email, subject, coordinationMessage, htmlBody)

    if (!result.sent) return
    toast(result.audited ? 'Aviso enviado à coordenação com sucesso!' : 'Aviso enviado, mas o registro local de auditoria falhou.')
    modal('notificationModal', false)
    return
  }

  if (type === 'whatsapp') {
    const sent = await openWhatsAppMessage(reader, message)
    if (!sent) return

    toast('WhatsApp aberto com a mensagem.')
    modal('notificationModal', false)
    return
  }

  if (!reader.email || !reader.email.trim()) {
    return toast(`O leitor ${reader.name} não possui e-mail cadastrado na aba Leitores.`, 'error')
  }

  const subject = `Aviso da biblioteca - ${config.schoolName}`
  const htmlBody = createStudentEmailHtml({
    subject,
    schoolName: config.schoolName,
    message,
    bookTitle: loan.bookTitle,
    dueDate: formatDate(loan.dueAt),
    loanDays: Number(loan.days || 7)
  })
  const result = await sendEmailFromButton($('#sendEmailBtn'), reader.email, subject, message, htmlBody)

  if (!result.sent) return
  toast(result.audited ? 'E-mail enviado ao leitor com sucesso!' : 'E-mail enviado, mas o registro local de auditoria falhou.')
  modal('notificationModal', false)
}

/* -------------------------
   CSV import / export
   ------------------------- */
const bookExportFields = [
  ['ID do documento', 'documentId'],
  ['Código', 'code'],
  ['Título', 'title'],
  ['Autor', 'author'],
  ['Editora', 'publisher'],
  ['ID da categoria', 'categoryId'],
  ['Categoria', 'categoryName'],
  ['Sinopse', 'synopsis'],
  ['URL da capa', 'coverUrl'],
  ['Ano', 'year'],
  ['Localização', 'shelf'],
  ['Disponíveis', 'available'],
  ['Total', 'total'],
  ['Tombamento', 'tombamento'],
  ['Status', 'status'],
  ['ID da escola', 'schoolId'],
  ['Nome da escola', 'schoolName'],
  ['Criado em', 'createdAt'],
  ['Atualizado em', 'updatedAt']
]

function exportValue(value) {
  if (value?.toDate) return value.toDate().toISOString()
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') return JSON.stringify(value, (_, nested) => nested?.toDate ? nested.toDate().toISOString() : nested)
  return value ?? ''
}

const bookExportRows = () => [
  bookExportFields.map(([header]) => header),
  ...state.books.map((book) => bookExportFields.map(([, field]) => {
    if (field === 'documentId') return book.id || ''
    if (field === 'categoryName') return book.categoryName || label(book.categoryId)
    if (field === 'status') return bookStatus(book)
    if (field === 'schoolName') return config.schoolName
    return exportValue(book[field])
  }))
]

function recordsToExportRows(records = [], excludedFields = []) {
  const excluded = new Set(excludedFields)
  const fields = [...new Set(records.flatMap((record) => Object.keys(record)))].filter((field) => !excluded.has(field)).sort()
  return [fields, ...records.map((record) => fields.map((field) => exportValue(record[field])))]
}

async function schoolBackupTables() {
  if (!state.profile || state.profile.role !== 'admin' || !config.currentSchoolId) throw new Error('Acesse com um administrador vinculado a uma escola.')

  const collectionNames = ['readers', 'reservations', 'counters', 'audit_logs', 'email_logs']
  const [schoolSnapshot, ...snapshots] = await Promise.all([
    getDoc(doc(db, 'schools', config.currentSchoolId)),
    ...collectionNames.map((name) => getDocs(query(collection(db, name), where('schoolId', '==', config.currentSchoolId))))
  ])
  const schoolData = schoolSnapshot.exists() ? schoolSnapshot.data() : {}
  const collectionRecords = Object.fromEntries(collectionNames.map((name, index) => [
    name,
    snapshots[index].docs.map((item) => ({ id: item.id, ...item.data() }))
  ]))

  return [
    ['Acervo', bookExportRows()],
    ['Emprestimos', recordsToExportRows(state.loans)],
    ['Leitores', recordsToExportRows(collectionRecords.readers)],
    ['Categorias', recordsToExportRows(state.categories)],
    ['Reservas', recordsToExportRows(collectionRecords.reservations)],
    ['Contadores', recordsToExportRows(collectionRecords.counters)],
    ['Auditoria', recordsToExportRows(collectionRecords.audit_logs)],
    ['E-mails enviados', recordsToExportRows(collectionRecords.email_logs)],
    ['Escola', recordsToExportRows([{ id: config.currentSchoolId, ...schoolData, schoolId: config.currentSchoolId }])]
  ]
}

function csvFromRows(rows) {
  return rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(';')).join('\n')
}

function backupFileBaseName() {
  const schoolId = String(config.currentSchoolId || 'escola').replace(/[^a-z0-9_-]/gi, '_')
  return `libris-backup-${schoolId}-${new Date().toISOString().slice(0, 10)}`
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.94) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Não foi possível converter a imagem para download.'))
        return
      }
      resolve(blob)
    }, type, quality)
  })
}

function fileMimeType(extension) {
  return ({
    jpg: 'image/jpeg',
    pdf: 'application/pdf',
    zip: 'application/zip'
  })[extension] || 'application/octet-stream'
}

async function chooseSaveTarget(filename, filterName, extensions) {
  if (isTauri()) {
    const path = await save({
      title: 'Salvar arquivo do Libris',
      defaultPath: filename,
      filters: [{ name: filterName, extensions }]
    })
    return path ? { kind: 'tauri', path } : null
  }

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: filterName,
          accept: { [fileMimeType(extensions[0])]: extensions.map((extension) => `.${extension}`) }
        }]
      })
      return { kind: 'web', handle }
    } catch (err) {
      if (err.name === 'AbortError') return null
      throw err
    }
  }

  return { kind: 'browser', filename }
}

async function saveBlobToTarget(blob, target) {
  if (!target) return false

  if (target.kind === 'tauri') {
    await writeFile(target.path, new Uint8Array(await blob.arrayBuffer()))
    toast(`Arquivo salvo em: ${target.path}`)
    return true
  }

  if (target.kind === 'web') {
    const writable = await target.handle.createWritable()
    await writable.write(blob)
    await writable.close()
    toast(`Arquivo salvo: ${target.handle.name}`)
    return true
  }

  downloadBlob(blob, target.filename)
  toast(`Download de ${target.filename} iniciado. A localização depende das configurações de downloads do navegador.`)
  return true
}

async function exportCsv() {
  const button = $('#exportCsvOption')
  const filename = `${backupFileBaseName()}.zip`
  loading(button, true, 'Preparando backup…')
  try {
    const target = await chooseSaveTarget(filename, 'Backup Libris', ['zip'])
    if (!target) return
    const blob = await createCsvBackupArchive()
    const saved = await saveBlobToTarget(blob, target)
    if (saved) {
      modal('exportModal', false)
    }
  } catch (err) {
    console.error('Falha ao exportar backup CSV:', err)
    error(err, 'Não foi possível gerar o backup CSV da escola.')
  } finally {
    loading(button, false)
  }
}

async function createCsvBackupArchive() {
  const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')
  const collectionsByTable = {
    Acervo: 'books',
    Emprestimos: 'loans',
    Leitores: 'readers',
    Categorias: 'categories',
    Reservas: 'reservations',
    Contadores: 'counters',
    Auditoria: 'audit_logs',
    'E-mails enviados': 'email_logs',
    Escola: 'schools'
  }
  const tables = await schoolBackupTables()
  const zip = new JSZip()
  tables.forEach(([name, rows]) => {
    const collectionName = collectionsByTable[name]
    const filename = Object.entries({ ...backupCollectionFiles, ...optionalBackupCollectionFiles }).find(([, value]) => value === collectionName)?.[0]
    if (!filename) throw new Error(`Não há arquivo CSV definido para ${name}.`)
    zip.file(filename, `\ufeff${csvFromRows(rows)}`)
  })
  zip.file('LEIA-ME.txt', `Backup escolar Libris\nEscola: ${config.schoolName}\nID: ${config.currentSchoolId}\nGerado em: ${new Date().toISOString()}\n\nCada arquivo CSV corresponde a uma coleção. Para restaurar, use Importar e selecione este ZIP. As credenciais locais nao sao exportadas; a restauracao preserva as contas cadastradas neste computador.`)
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

async function restoreCsvBackup(file) {
  if (!state.user || !config.currentSchoolId) throw new Error('Entre no painel da escola antes de restaurar um backup.')
  if (!confirm(`O backup CSV substituirá os dados locais de ${config.schoolName}. Deseja continuar?`)) return

  const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')
  const zip = await JSZip.loadAsync(file)
  const missingFiles = Object.keys(backupCollectionFiles).filter((filename) => !zip.file(filename))
  if (missingFiles.length) throw new Error(`Backup incompleto. Arquivos ausentes: ${missingFiles.join(', ')}.`)
  const collections = {}
  for (const [filename, collectionName] of Object.entries({ ...backupCollectionFiles, ...optionalBackupCollectionFiles })) {
    const entry = zip.file(filename)
    if (!entry) continue
    const workbook = XLSX.read(await entry.async('arraybuffer'), { type: 'array', raw: false })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) : []
    const headers = (rows[0] || []).map((value) => String(value ?? '').replace(/^\uFEFF/, '').trim())
    collections[collectionName] = rows.slice(1)
      .filter((row) => row.some((value) => String(value ?? '').trim()))
      .map((row) => {
        const record = collectionName === 'books'
          ? backupRecordFromRow(headers, row, collectionName)
          : Object.fromEntries(headers.map((header, index) => [header, parseBackupCell(row[index])]).filter(([key]) => key))
        record.schoolId = config.currentSchoolId
        if (collectionName === 'categories') record.id = `${encodeURIComponent(config.currentSchoolId)}__${record.code || record.id}`
        if (collectionName === 'counters') record.id = `${encodeURIComponent(config.currentSchoolId)}_books_${record.prefix}`
        if (collectionName === 'email_usage') record.id = `${config.currentSchoolId}_${record.month}`
        if (collectionName === 'schools') {
          record.id = config.currentSchoolId
          record.name = record.name || config.schoolName
        }
        return record
      })
  }
  if (!collections.schools?.length) throw new Error('O arquivo não contém escola.csv; selecione um backup completo do Libris.')
  collections.users = (await localStore.list('users')).filter((user) => user.schoolId === config.currentSchoolId)

  await localStore.replaceSchool(config.currentSchoolId, {
    schemaVersion: 1,
    schoolId: config.currentSchoolId,
    exportedAt: new Date().toISOString(),
    collections
  })
  if (!await loadSchoolData(config.currentSchoolId)) throw new Error('Não foi possível carregar as configurações restauradas.')
  await subscribeAdmin()
  toast('Backup CSV restaurado nesta máquina.')
}

const normalizeCsvHeader = (value) => String(value ?? '').replace(/^\uFEFF/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const csvHeaderAliases = {
  documentId: ['id do documento', 'document id', 'documentid', 'firestore id'],
  codigo: ['codigo', 'codigo do livro', 'codigo do acervo', 'id', 'id do livro', 'cod'],
  titulo: ['titulo', 'titulo do livro', 'nome do livro', 'livro'],
  autor: ['autor', 'nome do autor'],
  editora: ['editora', 'publisher'],
  categoriaId: ['id da categoria', 'categoria id', 'category id', 'categoryid'],
  categoriaNome: ['nome da categoria', 'category name', 'categoryname'],
  categoria: ['categoria', 'genero', 'assunto', 'category'],
  ano: ['ano', 'ano de publicacao', 'ano publicacao'],
  localizacao: ['localizacao', 'estante', 'prateleira', 'local'],
  disponiveis: ['disponiveis', 'quantidade disponivel', 'exemplares disponiveis'],
  total: ['total', 'quantidade', 'quantidade total', 'quantidade de exemplares', 'exemplares'],
  tombamento: ['tombamento', 'numero de tombamento', 'patrimonio'],
  sinopse: ['sinopse', 'synopsis'],
  capa: ['url da capa', 'capa url', 'cover url', 'coverurl'],
  schoolId: ['id da escola', 'school id', 'schoolid'],
  schoolName: ['nome da escola', 'school name', 'schoolname'],
  criadoEm: ['criado em', 'created at', 'createdat'],
  atualizadoEm: ['atualizado em', 'updated at', 'updatedat']
}

function mapCsvColumns(headers) {
  const columns = {}
  headers.forEach((header, index) => {
    const normalized = normalizeCsvHeader(header)
    const field = Object.entries(csvHeaderAliases).find(([, aliases]) => aliases.includes(normalized))?.[0]
    if (field && columns[field] === undefined) columns[field] = index
  })
  return columns
}

function parseCsvInteger(value) { const text = String(value ?? '').trim(); if (!/^\d+$/.test(text)) return null; const number = Number(text); return Number.isSafeInteger(number) ? number : null }
function parseCsvDate(value) { const text = String(value ?? '').trim(); if (!text) return null; const parsed = new Date(text); return Number.isNaN(parsed.getTime()) ? null : parsed }

async function importCsv(event) {
  const input = event.target
  const file = input?.files?.[0]
  if (!file) return
  toast(`Lendo arquivo: ${file.name}`)
  modal('importCsvFileModal', false)
  if (!db || !state.user) { if (input) input.value = ''; return toast('Entre no painel administrativo para importar dados.', 'error') }
  if (file.name.toLowerCase().endsWith('.zip')) {
    try {
      await restoreCsvBackup(file)
    } catch (err) {
      error(err, 'Não foi possível restaurar o backup CSV.')
    } finally {
      if (input) input.value = ''
    }
    return
  }

  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) : []
    if (rows.length < 2) return toast('O CSV está vazio ou não contém linhas de livros.', 'error')

    const headerRowIndex = rows.findIndex((row) => {
      const columns = mapCsvColumns(row)
      return columns.codigo !== undefined && columns.titulo !== undefined
    })
    if (headerRowIndex < 0) {
      const preview = rows.slice(0, 3).map((row) => row.filter(Boolean).join(', ')).filter(Boolean).join(' / ')
      if (input) input.value = ''
      return toast(`Não encontrei as colunas Código e Título. Cabeçalhos lidos: ${preview || 'nenhum'}.`, 'error')
    }

    const columns = mapCsvColumns(rows[headerRowIndex])
    const required = ['codigo', 'titulo', 'autor', 'total']
    const missing = required.filter((header) => columns[header] === undefined)
    if (missing.length) {
      const detected = rows[headerRowIndex].filter(Boolean).join(', ')
      if (input) input.value = ''
      return toast(`Colunas obrigatórias ausentes: ${missing.join(', ')}. Cabeçalhos lidos: ${detected}.`, 'error')
    }

    const existingCodes = new Set(state.books.map((book) => String(book.code || '').trim().toUpperCase()))
    const existingDocumentIds = new Set(state.books.map((book) => book.id).filter(Boolean))
    const seenCodes = new Set()
    const booksToImport = []
    const countersToUpdate = new Map()
    const categoriesToCreate = new Map()
    const skipped = []
    const errors = []
    const valueAt = (row, key) => columns[key] === undefined ? '' : String(row[columns[key]] ?? '').trim()

    rows.slice(headerRowIndex + 1).forEach((row, index) => {
      if (!row.some((value) => String(value ?? '').trim())) return
      const line = headerRowIndex + index + 2
      const code = valueAt(row, 'codigo').toUpperCase()
      const sourceDocumentId = valueAt(row, 'documentId')
      const codeParts = code.match(/^([A-Z0-9]{1,4})-(\d{4})$/)
      const title = valueAt(row, 'titulo')
      const author = valueAt(row, 'autor')
      const categoryName = valueAt(row, 'categoria') || valueAt(row, 'categoriaNome')
      const categoryId = valueAt(row, 'categoriaId')
      const categoryResolution = resolveLegacyCategory({
        name: categoryName,
        categoryId,
        code,
        categories: [...getCategoryOptions(), ...categoriesToCreate.values()]
      })
      const category = categoryResolution.category
      const total = parseCsvInteger(valueAt(row, 'total'))
      const availableValue = valueAt(row, 'disponiveis')
      const available = availableValue ? parseCsvInteger(availableValue) : total
      const yearValue = valueAt(row, 'ano')
      const year = yearValue ? parseCsvInteger(yearValue) : 0
      const sourceSchoolId = valueAt(row, 'schoolId')
      const createdAtValue = valueAt(row, 'criadoEm')
      const updatedAtValue = valueAt(row, 'atualizadoEm')
      const createdAt = parseCsvDate(createdAtValue)
      const updatedAt = parseCsvDate(updatedAtValue)

      const rowErrors = []
      if (!codeParts) rowErrors.push('código deve seguir PREFIXO-0001')
      if (!title) rowErrors.push('título ausente')
      if (!author) rowErrors.push('autor ausente')
      if (!categoryName && !categoryId) rowErrors.push('categoria ausente')
      else if (categoryResolution.error) rowErrors.push(categoryResolution.error)
      if (total === null || total < 1) rowErrors.push('total inválido')
      if (available === null || available > total) rowErrors.push('disponíveis deve estar entre 0 e o total')
      if (year === null) rowErrors.push('ano inválido')
      if (createdAtValue && !createdAt) rowErrors.push('data de criação inválida')
      if (updatedAtValue && !updatedAt) rowErrors.push('data de atualização inválida')
      if (sourceDocumentId && (sourceDocumentId.includes('/') || sourceDocumentId.length > 1500)) rowErrors.push('ID do documento inválido')
      if (rowErrors.length) {
        errors.push(`linha ${line} (${rowErrors.join(', ')})`)
        return
      }
      if (seenCodes.has(code)) {
        errors.push(`linha ${line} (código repetido no arquivo: ${code})`)
        return
      }
      seenCodes.add(code)
      if (categoryResolution.create) categoriesToCreate.set(category.code, category)
      if (existingCodes.has(code)) {
        skipped.push(code)
        return
      }

      const documentId = sourceDocumentId && !existingDocumentIds.has(sourceDocumentId) ? sourceDocumentId : ''
      if (documentId) existingDocumentIds.add(documentId)

      booksToImport.push({
        documentId,
        code,
        title,
        author,
        publisher: valueAt(row, 'editora'),
        categoryId: String(category.code || category.id),
        categoryName: category.name || categoryName || categoryId,
        year,
        shelf: valueAt(row, 'localizacao'),
        available,
        total,
        tombamento: valueAt(row, 'tombamento'),
        synopsis: valueAt(row, 'sinopse'),
        coverUrl: valueAt(row, 'capa'),
        status: available > 0 ? 'disponivel' : 'emprestado',
        createdAt: createdAt ? Timestamp.fromDate(createdAt) : null,
        updatedAt: updatedAt ? Timestamp.fromDate(updatedAt) : null,
        schoolId: config.currentSchoolId,
        importedFromSchoolId: sourceSchoolId || ''
      })
      const [prefix, codeNumber] = [codeParts[1], Number(codeParts[2])]
      countersToUpdate.set(prefix, Math.max(countersToUpdate.get(prefix) || 0, codeNumber))
    })

    if (errors.length) { if (input) input.value = ''; return toast(`Corrija as linhas inválidas: ${errors.slice(0, 4).join('; ')}${errors.length > 4 ? '; …' : ''}. Nada foi importado.`, 'error') }
    if (!booksToImport.length) { if (input) input.value = ''; return toast(skipped.length ? `Nenhum livro novo. ${skipped.length} código(s) já existiam no acervo.` : 'Nenhum livro válido para importar.', 'error') }
    pendingCsvImport = { books: booksToImport, counters: countersToUpdate, categories: [...categoriesToCreate.values()], skippedCount: skipped.length }
    if ($('#importCsvSummary')) $('#importCsvSummary').textContent = `Importar ${booksToImport.length} livro(s) e criar ${categoriesToCreate.size} categoria(s) ausentes? O arquivo será vinculado à escola atual. Códigos existentes serão ignorados.`
    modal('importCsvConfirmModal', true)
  } catch (err) {
    error(err, 'Não foi possível ler ou validar o CSV.')
  } finally {
    if (input) input.value = ''
  }
}

async function confirmCsvImport() {
  const pending = pendingCsvImport
  if (!pending || !state.user || !db) return
  const button = $('#confirmCsvImportBtn')
  loading(button, true, 'Importando…')

  try {
    for (const category of pending.categories || []) {
      await setDoc(doc(db, 'categories', `${encodeURIComponent(config.currentSchoolId)}__${category.code}`), {
        ...category,
        schoolId: config.currentSchoolId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true })
    }

    for (const [prefix, importedLastCode] of pending.counters) {
      const counterRef = doc(db, 'counters', `${encodeURIComponent(config.currentSchoolId)}_books_${prefix}`)
      await runTransaction(db, async (transaction) => {
        const counter = await transaction.get(counterRef)
        const lastCode = Number(counter.exists() ? counter.data().lastCode || 0 : 0)
        if (importedLastCode > lastCode) transaction.set(counterRef, { prefix, schoolId: config.currentSchoolId, lastCode: importedLastCode, updatedAt: serverTimestamp() }, { merge: true })
      })
    }

    for (let offset = 0; offset < pending.books.length; offset += 450) {
      const batch = writeBatch(db)
      pending.books.slice(offset, offset + 450).forEach((book) => {
        const { documentId, ...bookData } = book
        const bookRef = documentId ? doc(db, 'books', documentId) : doc(collection(db, 'books'))
        batch.set(bookRef, { ...bookData, createdAt: bookData.createdAt || serverTimestamp(), updatedAt: bookData.updatedAt || serverTimestamp() })
      })
      await batch.commit()
    }

    await logAudit('books_imported', { count: pending.books.length }, state.user.uid)
    toast(`${pending.books.length} livro(s) importado(s). ${pending.skippedCount} código(s) já existente(s) ignorado(s).`)
    pendingCsvImport = null
    modal('importCsvConfirmModal', false)
  } catch (err) {
    error(err, 'Não foi possível importar o CSV.')
  } finally {
    loading(button, false)
  }
}

/* -------------------------
   Subscriptions (admin-only)
   ------------------------- */
function clearAdminSubscriptions() { while (state.adminUnsubs.length) try { state.adminUnsubs.pop()() } catch (e) { console.warn('erro ao limpar subscription:', e) } }

function resetAdminState() {
  clearAdminSubscriptions()
  selectedLabelQuantities.clear()
  schoolSetupRequired = false
  state.user = null
  state.profile = null
  state.readers = []
  state.loans = []
  state.books = []
  state.categories = []
  if ($('#librisAdminView')) $('#librisAdminView').hidden = true
  if ($('#adminView')) $('#adminView').hidden = true
  if ($('#openSettingsBtn')) $('#openSettingsBtn').hidden = true
  if ($('#logoutBtn')) $('#logoutBtn').hidden = true
  if ($('#settingsModalTitle')) $('#settingsModalTitle').textContent = 'Configurações da escola'
  modal('settingsModal', false)
  renderReaders()
  renderLoans()
  renderBooks()
  renderCategoryList()
  renderDashboard()
}

  function selectedLabelBooks() {
    return state.books.filter((book) => selectedLabelQuantities.has(book.id))
  }

  function selectedLabelEntries() {
    return selectedLabelBooks().map((book) => ({
      book,
      quantity: selectedLabelQuantities.get(book.id)
    }))
  }

  function selectedLabelCopyCount() {
    return selectedLabelBooks().reduce((total, book) => total + selectedLabelQuantities.get(book.id), 0)
  }

  function labelQrPayload(book) {
    return JSON.stringify({ v: 1, s: config.currentSchoolId, b: book.id, c: book.code })
  }

  function drawWrappedLabelText(context, text, x, y, maxWidth, lineHeight, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean)
    const lines = []
    let line = ''

    words.forEach((word) => {
      const candidate = line ? `${line} ${word}` : word
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    })
    if (line) lines.push(line)

    const visibleLines = lines.slice(0, maxLines)
    if (lines.length > maxLines && visibleLines.length) {
      let lastLine = visibleLines[visibleLines.length - 1]
      while (lastLine && context.measureText(`${lastLine}...`).width > maxWidth) lastLine = lastLine.slice(0, -1)
      visibleLines[visibleLines.length - 1] = `${lastLine.trimEnd()}...`
    }
    visibleLines.forEach((visibleLine, index) => context.fillText(visibleLine, x, y + index * lineHeight))
  }

  async function createBookLabelCanvas(book) {
    const qrModule = await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm')
    const toDataURL = qrModule.toDataURL || qrModule.default?.toDataURL
    if (!toDataURL) throw new Error('O gerador QR não está disponível.')

    const qrDataUrl = await toDataURL(labelQrPayload(book), {
      errorCorrectionLevel: 'H',
      margin: 4,
      width: 420,
      color: { dark: '#173e2b', light: '#ffffff' }
    })
    const qrImage = new Image()
    qrImage.src = qrDataUrl
    await qrImage.decode()

    const canvas = document.createElement('canvas')
    canvas.width = 1104
    canvas.height = 600
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Não foi possível preparar a etiqueta.')

    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.strokeStyle = '#d8e3da'
    context.lineWidth = 4
    context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4)
    context.fillStyle = '#1e5b3d'
    context.fillRect(0, 0, 18, canvas.height)
    context.fillStyle = '#1e5b3d'
    context.font = '700 34px Georgia, serif'
    context.fillText('LIBRIS', 58, 72)
    context.fillStyle = '#718078'
    context.font = '600 24px Arial, sans-serif'
    context.fillText(String(config.schoolName || 'Biblioteca escolar').toLocaleUpperCase('pt-BR').slice(0, 48), 58, 108, 650)
    context.strokeStyle = '#e2e9e4'
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(58, 132)
    context.lineTo(720, 132)
    context.stroke()

    context.fillStyle = '#24352b'
    context.font = '700 60px Georgia, serif'
    drawWrappedLabelText(context, book.title || 'Livro sem título', 58, 198, 650, 68, 2)
    context.fillStyle = '#4f6256'
    context.font = '500 38px Arial, sans-serif'
    drawWrappedLabelText(context, book.author || 'Autoria não informada', 58, 326, 650, 46, 2)

    context.fillStyle = '#1e5b3d'
    context.font = '700 29px Arial, sans-serif'
    context.fillText(String(book.categoryName || label(book.categoryId) || '').toLocaleUpperCase('pt-BR').slice(0, 42), 58, 424, 650)
    context.fillStyle = '#4f6256'
    context.font = '600 28px Arial, sans-serif'
    context.fillText(`TOMB.: ${String(book.tombamento || '—').toLocaleUpperCase('pt-BR').slice(0, 32)}`, 58, 466, 650)
    context.fillStyle = '#718078'
    context.font = '600 22px Arial, sans-serif'
    context.fillText('CÓDIGO DO ACERVO', 58, 508)
    context.fillStyle = '#24352b'
    context.font = '700 52px Arial, sans-serif'
    context.fillText(String(book.code || '').toLocaleUpperCase('pt-BR').slice(0, 18), 58, 566, 650)

    context.fillStyle = '#ffffff'
    context.fillRect(744, 140, 350, 390)
    context.drawImage(qrImage, 750, 146, 338, 338)
    context.fillStyle = '#718078'
    context.font = '700 20px Arial, sans-serif'
    context.textAlign = 'center'
    context.fillText('IDENTIFICAÇÃO DIGITAL', 919, 512)
    context.fillStyle = '#1e5b3d'
    context.font = '700 22px Arial, sans-serif'
    context.fillText('ESCANEIE PARA CONFERIR', 919, 542)
    context.textAlign = 'start'

    return canvas
  }

  let labelPreviewRequest = 0

  function renderLabelBookList() {
    const list = $('#labelBookList')
    if (!list) return
    const queryText = ($('#labelBookSearchInput')?.value || '').trim().toLocaleLowerCase('pt-BR')
    const books = state.books.filter((book) => !queryText || [book.title, book.author, book.code].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(queryText)))

    list.innerHTML = books.length ? books.map((book) => {
      const quantity = selectedLabelQuantities.get(book.id) || 1
      const selected = selectedLabelQuantities.has(book.id)
      return `
        <div class="label-book-option">
          <input type="checkbox" data-label-book="${esc(book.id)}" aria-label="Selecionar ${esc(book.title || 'livro sem título')}" ${selected ? 'checked' : ''} />
          <span><strong>${esc(book.title || 'Livro sem título')}</strong><small>${esc(book.code || 'Sem código')} · ${esc(book.author || 'Autoria não informada')}</small></span>
          <label class="label-book-quantity">
            <span>Qtd.</span>
            <input type="number" min="1" value="${quantity}" data-label-quantity="${esc(book.id)}" aria-label="Quantidade de etiquetas para ${esc(book.title || 'livro sem título')}" ${selected ? '' : 'disabled'} />
          </label>
        </div>
      `
    }).join('') : '<p class="label-book-empty">Nenhum livro encontrado nesta escola.</p>'
  }

  async function updateLabelPreview() {
    const books = selectedLabelBooks()
    const empty = $('#labelPreviewEmpty')
    const canvas = $('#labelPreviewCanvas')
    const caption = $('#labelPreviewCaption')
    const count = $('#labelSelectionCount')
    const jpgButton = $('#downloadLabelsJpgBtn')
    const pdfButton = $('#downloadLabelsPdfBtn')
    const requestId = ++labelPreviewRequest

    const copyCount = selectedLabelCopyCount()
    if (count) count.textContent = `${copyCount} etiqueta${copyCount === 1 ? '' : 's'} · ${books.length} livro${books.length === 1 ? '' : 's'}`
    if (jpgButton) {
      jpgButton.disabled = copyCount === 0 || copyCount > 10
      jpgButton.title = copyCount > 10 ? 'A folha A4 JPG comporta até 10 etiquetas. Reduza as quantidades ou use PDF.' : ''
    }
    if (pdfButton) pdfButton.disabled = copyCount === 0

    if (!books.length) {
      if (empty) empty.hidden = false
      if (canvas) canvas.hidden = true
      if (caption) caption.hidden = true
      return
    }

    if (empty) empty.hidden = true
    if (canvas) canvas.hidden = false
    if (caption) caption.hidden = false
    if (caption) caption.textContent = 'Gerando a prévia em alta resolução…'

    try {
      const labelCanvas = await createBookLabelCanvas(books[0])
      if (requestId !== labelPreviewRequest || !canvas) return
      const context = canvas.getContext('2d')
      context?.clearRect(0, 0, canvas.width, canvas.height)
      context?.drawImage(labelCanvas, 0, 0, canvas.width, canvas.height)
      if (caption) caption.textContent = copyCount > 1
        ? `Prévia de ${books[0].title || 'livro selecionado'}. Serão geradas ${copyCount} etiquetas.`
        : 'Etiqueta no formato pronto para impressão.'
    } catch (err) {
      console.error('Falha ao gerar prévia QR:', err)
      if (caption) caption.textContent = 'Não foi possível gerar o QR. Confira sua conexão e tente novamente.'
    }
  }

  function renderLabelSelection() {
    renderLabelBookList()
    updateLabelPreview()
  }

  async function downloadLabelSheetJpg() {
    const entries = selectedLabelEntries()
    const copyCount = selectedLabelCopyCount()
    if (!copyCount || copyCount > 10) return
    const button = $('#downloadLabelsJpgBtn')
    const filename = `etiquetas-${String(config.currentSchoolId).replace(/[^a-z0-9_-]/gi, '_')}.jpg`
    loading(button, true, 'Gerando JPG…')
    try {
      const target = await chooseSaveTarget(filename, 'Imagem JPG', ['jpg'])
      if (!target) return
      const labels = []
      for (const { book, quantity } of entries) {
        const labelCanvas = await createBookLabelCanvas(book)
        for (let copy = 0; copy < quantity; copy += 1) labels.push(labelCanvas)
      }
      const columns = 2
      const dpi = 300
      const pxPerMm = dpi / 25.4
      const cardWidth = Math.round(90 * pxPerMm)
      const cardHeight = Math.round(cardWidth * 600 / 1104)
      const columnGap = Math.round(10 * pxPerMm)
      const rowGap = Math.round(5 * pxPerMm)
      const leftMargin = Math.round(10 * pxPerMm)
      const topMargin = Math.round(14 * pxPerMm)
      const sheet = document.createElement('canvas')
      sheet.width = 2480
      sheet.height = 3508
      const context = sheet.getContext('2d')
      if (!context) throw new Error('Não foi possível preparar a folha JPG.')
      context.fillStyle = '#f1f4f1'
      context.fillRect(0, 0, sheet.width, sheet.height)
      labels.forEach((labelCanvas, index) => {
        const column = index % columns
        const row = Math.floor(index / columns)
        const x = leftMargin + column * (cardWidth + columnGap)
        const y = topMargin + row * (cardHeight + rowGap)
        context.drawImage(labelCanvas, x, y, cardWidth, cardHeight)
      })
      await saveBlobToTarget(await canvasToBlob(sheet), target)
    } catch (err) {
      console.error('Falha ao gerar etiquetas JPG:', err)
      toast('Não foi possível gerar o JPG. Tente novamente.', 'error')
    } finally {
      loading(button, false)
    }
  }

  async function downloadLabelSheetPdf() {
    const entries = selectedLabelEntries()
    if (!selectedLabelCopyCount()) return
    const button = $('#downloadLabelsPdfBtn')
    const filename = `etiquetas-${String(config.currentSchoolId).replace(/[^a-z0-9_-]/gi, '_')}.pdf`
    loading(button, true, 'Gerando PDF…')
    try {
      const target = await chooseSaveTarget(filename, 'Documento PDF', ['pdf'])
      if (!target) return
      const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
      const cardWidth = 90
      const cardHeight = cardWidth * 600 / 1104
      const columnGap = 10
      const rowGap = 5
      const leftMargin = 10
      const topMargin = 14

      let index = 0
      for (const { book, quantity } of entries) {
        const labelCanvas = await createBookLabelCanvas(book)
        const image = labelCanvas.toDataURL('image/jpeg', 0.95)
        for (let copy = 0; copy < quantity; copy += 1) {
          if (index > 0 && index % 10 === 0) pdf.addPage()
          const position = index % 10
          const column = position % 2
          const row = Math.floor(position / 2)
          const x = leftMargin + column * (cardWidth + columnGap)
          const y = topMargin + row * (cardHeight + rowGap)
          pdf.addImage(image, 'JPEG', x, y, cardWidth, cardHeight, undefined, 'FAST')
          index += 1
        }
      }

      pdf.setProperties({ title: `Etiquetas de ${config.schoolName}`, subject: `Acervo ${config.currentSchoolId}`, author: 'Libris' })
      await saveBlobToTarget(pdf.output('blob'), target)
    } catch (err) {
      console.error('Falha ao gerar etiquetas PDF:', err)
      toast('Não foi possível gerar o PDF. Tente novamente.', 'error')
    } finally {
      loading(button, false)
    }
  }

function watchAdminCollection(name, schoolId, onData) {
  return new Promise((resolve, reject) => {
    let waitingForFirstSnapshot = true
    const unsubscribe = onSnapshot(
      query(collection(db, name), where('schoolId', '==', schoolId)),
      (snap) => {
        onData(snap)
        if (waitingForFirstSnapshot) {
          waitingForFirstSnapshot = false
          resolve()
        }
      },
      (err) => {
        if (waitingForFirstSnapshot) {
          waitingForFirstSnapshot = false
          reject(err)
        } else {
          error(err)
        }
      }
    )
    state.adminUnsubs.push(unsubscribe)
  })
}

async function subscribeAdmin() {
  if (!db) return
  clearAdminSubscriptions()
  const activeSchoolId = config.currentSchoolId

  await Promise.all([
    watchAdminCollection('books', activeSchoolId, (snap) => {
      state.books = snap.docs.map((d) => {
        const data = d.data()
        const total = Number(data.total || 0)
        const available = Number(data.available ?? total)
        return { id: d.id, ...data, total, available, status: available > 0 ? 'disponivel' : 'emprestado' }
      })
      renderBooks(); renderDashboard()
      updateLoanQuantityLimit(state.readers.find((reader) => reader.id === $('#loanReaderIdInput')?.value))
    }),
    watchAdminCollection('categories', activeSchoolId, (snap) => {
      state.categories = snap.docs.map((d) => ({ ...d.data(), id: d.data().id || d.id, docId: d.id }))
      renderCategorySelect(); renderCategoryList(); renderBooks(); renderDashboard()
    }),
    watchAdminCollection('readers', activeSchoolId, (snap) => {
      state.readers = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      renderReaders(); renderDashboard()
    }),
    watchAdminCollection('loans', activeSchoolId, (snap) => {
      state.loans = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      renderLoans(); renderDashboard()
      updateLoanQuantityLimit(state.readers.find((reader) => reader.id === $('#loanReaderIdInput')?.value))
    })
  ])
}

/* -------------------------
   Forms / modals helpers
   ------------------------- */
function resetBookForm() { 
  const form = $('#bookForm')
  if (form) form.reset()
  if ($('#bookIdInput')) $('#bookIdInput').value = ''
  const titleHeader = $('#bookModalTitle')
  if (titleHeader) titleHeader.textContent = 'Cadastrar livro'
  if ($('#saveBookBtn')) $('#saveBookBtn').textContent = 'Salvar livro'
  renderCategorySelect()
  if ($('#bookYearInput')) $('#bookYearInput').value = new Date().getFullYear()
  if ($('#bookQuantityInput')) $('#bookQuantityInput').value = 1
}

function resetReaderForm() { 
  const form = $('#readerForm')
  if (form) form.reset()
  if ($('#readerIdInput')) $('#readerIdInput').value = ''
  const titleHeader = $('#readerModalTitle')
  if (titleHeader) titleHeader.textContent = 'Cadastrar leitor'
  if ($('#saveReaderBtn')) $('#saveReaderBtn').textContent = 'Salvar leitor'
  updateReaderFields()
}

function editBook(id) { 
  const book = state.books.find((item) => item.id === id)
  if (!book) return
  if ($('#bookIdInput')) $('#bookIdInput').value = id
  if ($('#bookTitleInput')) $('#bookTitleInput').value = book.title || ''
  if ($('#bookAuthorInput')) $('#bookAuthorInput').value = book.author || ''
  if ($('#bookPublisherInput')) $('#bookPublisherInput').value = book.publisher || ''
  if ($('#bookCategoryInput')) $('#bookCategoryInput').value = book.categoryId || ''
  if ($('#bookYearInput')) $('#bookYearInput').value = book.year || ''
  if ($('#bookShelfInput')) $('#bookShelfInput').value = book.shelf || ''
  if ($('#bookQuantityInput')) $('#bookQuantityInput').value = Number(book.total || 1)
  if ($('#bookTombamentoInput')) $('#bookTombamentoInput').value = book.tombamento || ''
  
  const titleHeader = $('#bookModalTitle')
  if (titleHeader) titleHeader.textContent = 'Editar livro'
  if ($('#saveBookBtn')) $('#saveBookBtn').textContent = 'Atualizar livro'
  modal('bookFormModal', true)
}

function editReader(id) { 
  const reader = state.readers.find((item) => item.id === id)
  if (!reader) return
  if ($('#readerIdInput')) $('#readerIdInput').value = id
  if ($('#readerNameInput')) $('#readerNameInput').value = reader.name || ''
  if ($('#readerTypeInput')) $('#readerTypeInput').value = reader.type || 'Aluno'
  if ($('#readerCourseInput')) $('#readerCourseInput').value = reader.course || ''
  if ($('#readerRegistrationInput')) $('#readerRegistrationInput').value = reader.matricula || ''
  if ($('#readerCpfInput')) $('#readerCpfInput').value = reader.cpf || ''
  if ($('#readerEmailInput')) $('#readerEmailInput').value = reader.email || ''
  if ($('#readerPhoneInput')) $('#readerPhoneInput').value = reader.phone || ''
  
  const titleHeader = $('#readerModalTitle')
  if (titleHeader) titleHeader.textContent = 'Editar leitor'
  if ($('#saveReaderBtn')) $('#saveReaderBtn').textContent = 'Atualizar leitor'
  updateReaderFields()
  modal('readerFormModal', true)
}

function updateReaderFields() { 
  const typeSelect = $('#readerTypeInput')
  if (!typeSelect) return
  const student = typeSelect.value === 'Aluno'
  ;[['#readerCourseField', student], ['#readerRegistrationField', student], ['#readerCpfField', !student]].forEach(([s, visible]) => {
    const f = $(s)
    if (f) {
      f.hidden = !visible
      f.classList.toggle('hidden', !visible)
    }
  })
  if ($('#readerCourseInput')) $('#readerCourseInput').required = student
  if ($('#readerRegistrationInput')) $('#readerRegistrationInput').required = student
  if ($('#readerCpfInput')) $('#readerCpfInput').required = !student
}

/* Loans rendering */
function renderLoans() {
  const tbody = $('#loansTableBody')
  if (!tbody) return
  const queryText = state.loanQuery.trim().toLocaleLowerCase('pt-BR')

  const list = state.loans.filter((l) => {
    if (l.status !== 'active') return false

    const reader = state.readers.find((r) => r.id === l.readerId)
    const role = String(reader?.role || reader?.type || '').toLowerCase()
    const matchesFilter = state.loanFilter === 'student'
      ? role === 'student' || role === 'aluno'
      : state.loanFilter === 'teacher'
        ? role === 'teacher' || role === 'professor'
        : state.loanFilter === 'other'
          ? !isStudentReader(reader) && role !== 'teacher' && role !== 'professor'
          : state.loanFilter === 'overdue'
            ? overdue(l)
            : true
    if (!matchesFilter) return false

    const searchFields = [
      l.bookTitle,
      l.bookCode,
      l.readerName,
      reader?.name,
      reader?.email,
      reader?.phone,
      reader?.matricula,
      reader?.course,
      reader?.class
    ]
    return !queryText || searchFields.some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(queryText))
  }).sort((left, right) => {
    const daysLate = (loan) => overdue(loan) ? Math.ceil((Date.now() - date(loan.dueAt).getTime()) / 86400000) : 0
    const studentPriority = (loan) => {
      const reader = state.readers.find((item) => item.id === loan.readerId)
      return isStudentReader(reader) && overdue(loan) ? 1 : 0
    }
    return studentPriority(right) - studentPriority(left) || daysLate(right) - daysLate(left)
  })

  tbody.innerHTML = list.length ? list.map((l) => {
    const selectedDays = Number(l.days || 7)
    const reader = state.readers.find((item) => item.id === l.readerId)
    const maximum = getMaxLoanDaysForReader(reader)
    const renewalDays = Math.max(1, maximum === null ? selectedDays : Math.min(selectedDays, maximum))
    const maximumAttribute = maximum === null ? '' : `max="${maximum}"`
    const renewalLabel = maximum === null ? 'Dias para renovar' : `Dias para renovar (máximo ${maximum})`
    const copyCount = loanQuantity(l)
    return `<tr><td>${esc(l.bookTitle)}<br><small>${esc(l.bookCode)}${copyCount > 1 ? ` · ${copyCount} exemplares` : ''}</small></td><td>${esc(l.readerName)}</td><td><div>${formatDate(l.dueAt)}</div><small>Prazo: ${selectedDays} dias</small></td><td><span class="badge ${overdue(l) ? 'borrowed' : 'available'}">${overdue(l) ? 'Em atraso' : 'Em dia'}</span></td><td><div class="action-row"><input class="renew-days" type="number" min="1" ${maximumAttribute} value="${renewalDays}" data-renew-days="${esc(l.id)}" aria-label="${renewalLabel}"><button class="small-btn primary" data-return="${esc(l.id)}" type="button">Devolver</button><button class="small-btn warning" data-renew="${esc(l.id)}" type="button">Renovar</button><button class="small-btn danger" data-notify="${esc(l.id)}" type="button">Notificar</button></div></td></tr>`
  }).join('') : '<tr><td colspan="5" class="text-center">Nenhum empréstimo corresponde à busca e aos filtros.</td></tr>'

  $$('[data-return]').forEach((b) => b.onclick = () => returnLoan(b.dataset.return))
  $$('[data-renew]').forEach((b) => b.onclick = () => renewLoan(b.dataset.renew))
  $$('[data-notify]').forEach((b) => b.onclick = () => notify(b.dataset.notify))

  const filterSelect = $('#loanFilterSelect')
  if (filterSelect) {
    filterSelect.value = state.loanFilter || 'all'
    filterSelect.onchange = (evt) => {
      state.loanFilter = evt.target.value
      renderLoans()
    }
  }
}

/* Notification helper used in table actions */
async function notify(id) {
  const loan = state.loans.find((l) => l.id === id)
  const reader = state.readers.find((r) => r.id === loan?.readerId)
  if (!loan) return
  if ($('#notificationContact')) {
    const emailTarget = reader?.email || loan.readerEmail || 'E-mail não informado'
    $('#notificationContact').textContent = `${emailTarget} · ${reader?.phone || 'Telefone não informado'}`
  }
  if ($('#notificationMessage')) $('#notificationMessage').value = `Olá, ${loan.readerName}. O empréstimo de ${loanQuantity(loan)} exemplar(es) do livro "${loan.bookTitle}" vence em ${formatDate(loan.dueAt)}. Por favor, procure a biblioteca escolar.`
  const modalEl = $('#notificationModal')
  if (modalEl) modalEl.dataset.loanId = String(id)
  modal('notificationModal', true)
  await updateEmailCredentialStatus('notificationEmailStatus')
}

let qrScannerStream = null
let qrScannerControls = null
let cameraPermissionPending = false

function stopQrScanner() {
  try {
    qrScannerControls?.stop()
  } catch (err) {
    console.warn('Não foi possível parar os controles do leitor QR:', err)
  }
  qrScannerControls = null
  const video = $('#qrScannerVideo')
  const stream = qrScannerStream || video?.srcObject
  stream?.getTracks().forEach((track) => track.stop())
  qrScannerStream = null
  if (video) {
    video.pause()
    video.srcObject = null
  }
  if (isTauri() && cameraPermissionPending) {
    cameraPermissionPending = false
    invoke('clear_camera_permission_request').catch((err) => {
      console.warn('Não foi possível limpar o pedido de permissão da câmera:', err)
    })
  }
}

function openQrScanner() {
  stopQrScanner()
  if ($('#qrScannerStatus')) $('#qrScannerStatus').textContent = 'Solicitando acesso à câmera…'
  modal('qrScannerModal', true)
  startQrCamera()
}

function acceptScannedBook(rawValue) {
  const normalizedValue = String(rawValue || '').trim()
  if (!normalizedValue) return false

  let payload = null
  try {
    payload = JSON.parse(normalizedValue)
  } catch {
    payload = null
  }

  const payloadSchoolId = payload?.schoolId || payload?.s
  const payloadBookId = payload?.bookId || payload?.b
  const payloadCode = payload?.code || payload?.c
  const matchedCode = String(payloadCode || normalizedValue.match(/(?:^|[^A-Z0-9])([A-Z0-9]{1,4}-\d{4})(?:$|[^A-Z0-9])/i)?.[1] || normalizedValue).trim().toUpperCase()
  const bookById = payloadBookId
    ? state.books.find((item) => String(item.id) === String(payloadBookId))
    : null
  const bookByCode = state.books.find((item) => String(item.code || '').trim().toUpperCase() === matchedCode)
  const book = bookById || bookByCode
  const scannedSchoolId = String(payloadSchoolId || '').trim().toLocaleLowerCase('pt-BR')
  const currentSchoolId = String(config.currentSchoolId || '').trim().toLocaleLowerCase('pt-BR')

  if (payloadSchoolId && scannedSchoolId !== currentSchoolId) {
    const message = 'Esta etiqueta pertence a outra escola ou está desatualizada. Gere uma nova etiqueta para este acervo.'
    if ($('#qrScannerStatus')) $('#qrScannerStatus').textContent = message
    toast(message, 'error')
    return false
  }

  if (!book) {
    const message = matchedCode
      ? `Livro ${matchedCode} não encontrado no acervo desta escola.`
      : 'O leitor não enviou um código reconhecível. Confira a etiqueta e tente novamente.'
    if ($('#qrScannerStatus')) $('#qrScannerStatus').textContent = message
    toast(message, 'error')
    return false
  }

  if ($('#bookCodeInput')) $('#bookCodeInput').value = String(book.code || matchedCode).toUpperCase()
  stopQrScanner()
  modal('qrScannerModal', false)
  $('#readerInput')?.focus()
  toast(`Livro encontrado: ${book.title}. Selecione o leitor para continuar.`)
  return true
}

async function startQrCamera() {
  const status = $('#qrScannerStatus')
  const video = $('#qrScannerVideo')
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = 'A câmera não está disponível neste contexto. Use o aplicativo instalado ou acesse pelo HTTPS.'
    if (status) status.textContent = message
    toast(message, 'error')
    return
  }
  if (!video) {
    toast('A janela do leitor de câmera não está disponível.', 'error')
    return
  }

  try {
    if (isTauri()) {
      await invoke('begin_camera_permission_request')
      cameraPermissionPending = true
    }
    qrScannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    video.muted = true
    video.playsInline = true
    video.srcObject = qrScannerStream
    await video.play()

    const { BrowserQRCodeReader } = await import('@zxing/browser')
    const reader = new BrowserQRCodeReader()
    qrScannerControls = await reader.decodeFromStream(
      qrScannerStream,
      video,
      (result, scanError, controls) => {
        if (result && acceptScannedBook(result.getText())) controls.stop()
        if (scanError && scanError.name !== 'NotFoundException') {
          console.warn('Falha durante a leitura do QR code:', scanError)
        }
      }
    )
    if (isTauri() && cameraPermissionPending) {
      await invoke('clear_camera_permission_request')
      cameraPermissionPending = false
    }
    qrScannerStream = video.srcObject
    if (status) status.textContent = 'Aponte a câmera para o QR code do livro.'
  } catch (err) {
    if (isTauri() && cameraPermissionPending) {
      cameraPermissionPending = false
      try {
        await invoke('clear_camera_permission_request')
      } catch (permissionError) {
        console.warn('Não foi possível limpar o pedido de permissão da câmera:', permissionError)
      }
    }
    stopQrScanner()
    console.error('Falha ao iniciar a câmera ou o leitor QR:', err)
    const message = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
      ? 'A câmera foi bloqueada. Feche outros aplicativos que a estejam usando e permita o acesso nas configurações do sistema.'
      : err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError'
        ? 'Nenhuma câmera foi encontrada neste dispositivo.'
        : 'Erro ao acessar a câmera. Verifique as permissões ou use o leitor USB.'
    if (status) status.textContent = message
    toast('Erro ao acessar a câmera. Verifique as permissões ou use o leitor USB.', 'error')
  }
}

function handleBookCodeEntry(event) {
  if (event.key !== 'Enter') return

  event.preventDefault()

  const input = event.currentTarget
  const scannedValue = String(input.value || '').trim()
  if (!scannedValue) return

  if (!acceptScannedBook(scannedValue)) {
    input.select()
  }
}

function focusBookCodeInput() {
  requestAnimationFrame(() => $('#bookCodeInput')?.focus())
}

function setAdminTab(tabName) {
  $$('.tab-btn').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tab === tabName)
    button.setAttribute('aria-pressed', String(button.dataset.tab === tabName))
    if (button.getAttribute('role') === 'tab') {
      button.setAttribute('aria-selected', String(button.dataset.tab === tabName))
    }
  })
  $$('.tab-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.panel === tabName)
  })

  const isRootTab = tabName === 'checkout'
  $('#adminView')?.classList.remove('is-subview')
  const backButton = $('#backToLoansBtn')
  if (backButton) backButton.hidden = true
  if (isRootTab) focusBookCodeInput()
}

/* -------------------------
   Form wiring and setup
   ------------------------- */
function setup() {
  // Tabs
  $$('.tab-btn').forEach((b) => b.onclick = () => {
    setAdminTab(b.dataset.tab)
  })

  if ($('#acervoSearchInput')) $('#acervoSearchInput').oninput = (x) => { state.acervoQuery = x.target.value; renderBooks() }
  if ($('#readerSearchInput')) $('#readerSearchInput').oninput = (x) => { state.readerQuery = x.target.value; renderReaders() }
  if ($('#readerFilterSelect')) $('#readerFilterSelect').onchange = (event) => { state.readerFilter = event.target.value; renderReaders() }
  if ($('#loanSearchInput')) $('#loanSearchInput').oninput = (x) => { state.loanQuery = x.target.value; renderLoans() }
  if ($('#bookCodeInput')) $('#bookCodeInput').oninput = () => {
    const reader = state.readers.find((item) => item.id === $('#loanReaderIdInput')?.value)
    updateLoanQuantityLimit(reader)
  }
  if ($('#readerInput')) {
    $('#readerInput').oninput = () => {
      if ($('#loanReaderIdInput')) $('#loanReaderIdInput').value = ''
      updateLoanDaysLimit(null, true)
      updateLoanQuantityLimit(null)
      renderReaderSelector()
    }
    $('#readerInput').onkeydown = (event) => {
      if (event.key === 'Enter' && !$('#loanReaderIdInput')?.value) {
        const firstOption = $('[data-select-loan-reader]')
        if (firstOption) {
          event.preventDefault()
          selectLoanReader(firstOption.dataset.selectLoanReader)
        }
      }
      if (event.key === 'Escape' && $('#readerSuggestions')) {
        $('#readerSuggestions').hidden = true
        $('#readerInput').setAttribute('aria-expanded', 'false')
      }
    }
  }
  if ($('#readerSuggestions')) $('#readerSuggestions').onclick = (event) => {
    const option = event.target.closest('[data-select-loan-reader]')
    if (option) selectLoanReader(option.dataset.selectLoanReader)
  }

  if ($('#bookForm')) $('#bookForm').onsubmit = addBook
  if ($('#categoryForm')) $('#categoryForm').onsubmit = addCategory
  if ($('#readerForm')) $('#readerForm').onsubmit = addReader
  if ($('#librisConfigForm')) $('#librisConfigForm').onsubmit = saveLibrisConfiguration
  if ($('#removeSmtpPasswordBtn')) $('#removeSmtpPasswordBtn').onclick = removeSmtpPassword
  if ($('#loginForm')) $('#loginForm').onsubmit = handleLocalLogin
  if ($('#credeLoginForm')) $('#credeLoginForm').onsubmit = handleCredeLogin
  if ($('#toggleCredePasswordBtn')) {
    $('#toggleCredePasswordBtn').onclick = () => {
      const input = $('#credePasswordInput')
      const button = $('#toggleCredePasswordBtn')
      if (!input || !button) return

      const showing = input.type === 'password'
      input.type = showing ? 'text' : 'password'
      button.setAttribute('aria-pressed', String(showing))
      button.setAttribute('aria-label', showing ? 'Ocultar senha' : 'Mostrar senha')
    }
  }
  if ($('#toggleLocalPasswordBtn')) {
    $('#toggleLocalPasswordBtn').onclick = () => {
      const input = $('#localLoginPasswordInput')
      const button = $('#toggleLocalPasswordBtn')
      if (!input || !button) return

      const showing = input.type === 'password'
      input.type = showing ? 'text' : 'password'
      button.setAttribute('aria-pressed', String(showing))
      button.setAttribute('aria-label', showing ? 'Ocultar senha' : 'Mostrar senha')
    }
  }
  if ($('#bookCodeInput')) $('#bookCodeInput').onkeydown = handleBookCodeEntry
  if ($('#addLocalAccountBtn')) $('#addLocalAccountBtn').onclick = () => addLocalAccountRow()
  if ($('#openCredeLoginBtn')) $('#openCredeLoginBtn').onclick = () => {
    if ($('#loginForm')) $('#loginForm').hidden = true
    if ($('#credeLoginForm')) $('#credeLoginForm').hidden = false
    $('#credeEmailInput')?.focus()
  }
  if ($('#backToLocalLoginBtn')) $('#backToLocalLoginBtn').onclick = () => {
    if ($('#credeLoginForm')) $('#credeLoginForm').hidden = true
    if ($('#loginForm')) $('#loginForm').hidden = false
  }
  if ($('#schoolSettingsForm')) $('#schoolSettingsForm').onsubmit = saveSchoolSettings
  if ($('#themePreferenceInput')) {
    $('#themePreferenceInput').value = getThemePreference()
    $('#themePreferenceInput').onchange = (event) => applyThemePreference(event.target.value, true)
  }
  if ($('#readerTypeInput')) $('#readerTypeInput').onchange = updateReaderFields
  if ($('#registerLoanBtn')) $('#registerLoanBtn').onclick = registerLoan
  updateLoanDaysLimit(null)
  if ($('#scanBtn')) $('#scanBtn').onclick = openQrScanner

  if ($('#openBookModalBtn')) $('#openBookModalBtn').onclick = () => { resetBookForm(); modal('bookFormModal', true) }
  if ($('#openReaderModalBtn')) $('#openReaderModalBtn').onclick = () => { resetReaderForm(); modal('readerFormModal', true) }
  const openCategoryModal = () => {
    if ($('#categoryForm')) $('#categoryForm').reset()
    modal('categoryModal', true)
  }
  if ($('#openCategoryFromBookBtn')) $('#openCategoryFromBookBtn').onclick = openCategoryModal
  if ($('#openBookLabelsBtn')) $('#openBookLabelsBtn').onclick = () => {
    if ($('#labelBookSearchInput')) $('#labelBookSearchInput').value = ''
    renderLabelSelection()
    modal('bookLabelsModal', true)
  }
  if ($('#labelBookSearchInput')) $('#labelBookSearchInput').oninput = renderLabelBookList
  if ($('#labelBookList')) $('#labelBookList').onchange = (event) => {
    const checkbox = event.target.closest('[data-label-book]')
    if (checkbox) {
      if (checkbox.checked) selectedLabelQuantities.set(checkbox.dataset.labelBook, 1)
      else selectedLabelQuantities.delete(checkbox.dataset.labelBook)
      renderLabelSelection()
      return
    }

    const quantityInput = event.target.closest('[data-label-quantity]')
    if (!quantityInput) return
    const bookId = quantityInput.dataset.labelQuantity
    if (!selectedLabelQuantities.has(bookId)) return
    const quantity = Number(quantityInput.value)
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      toast('Informe uma quantidade inteira de etiquetas maior que zero.', 'error')
      renderLabelBookList()
      return
    }
    selectedLabelQuantities.set(bookId, quantity)
    renderLabelSelection()
  }
  if ($('#selectLabelSearchResultsBtn')) $('#selectLabelSearchResultsBtn').onclick = () => {
    const queryText = ($('#labelBookSearchInput')?.value || '').trim().toLocaleLowerCase('pt-BR')
    state.books.filter((book) => !queryText || [book.title, book.author, book.code].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(queryText))).forEach((book) => {
      if (!selectedLabelQuantities.has(book.id)) selectedLabelQuantities.set(book.id, 1)
    })
    renderLabelSelection()
  }
  if ($('#clearLabelSelectionBtn')) $('#clearLabelSelectionBtn').onclick = () => {
    selectedLabelQuantities.clear()
    renderLabelSelection()
  }
  if ($('#downloadLabelsJpgBtn')) $('#downloadLabelsJpgBtn').onclick = downloadLabelSheetJpg
  if ($('#downloadLabelsPdfBtn')) $('#downloadLabelsPdfBtn').onclick = downloadLabelSheetPdf
  if ($('#downloadDashboardJpgBtn')) $('#downloadDashboardJpgBtn').onclick = downloadDashboardChartsJpg
  if ($('#downloadDashboardPdfBtn')) $('#downloadDashboardPdfBtn').onclick = downloadDashboardChartsPdf
  if ($('#downloadDashboardReportBtn')) $('#downloadDashboardReportBtn').onclick = downloadDashboardReport

  if ($('#cancelBookEditBtn')) $('#cancelBookEditBtn').onclick = () => modal('bookFormModal', false)
  if ($('#cancelReaderEditBtn')) $('#cancelReaderEditBtn').onclick = () => modal('readerFormModal', false)
  if ($('#exportBtn')) $('#exportBtn').onclick = () => modal('exportModal', true)
  if ($('#exportCsvOption')) $('#exportCsvOption').onclick = exportCsv
  if ($('#openSettingsBtn')) $('#openSettingsBtn').onclick = () => {
    syncSchoolSettingsForm()
    if ($('#settingsModalTitle')) $('#settingsModalTitle').textContent = 'Configurações da escola'
    modal('settingsModal', true)
  }
  if ($('#openAboutBtn')) $('#openAboutBtn').onclick = () => modal('aboutModal', true)
  if ($('#openHelpBtn')) $('#openHelpBtn').onclick = () => modal('helpModal', true)
  $$('.chart-info-btn').forEach((button) => {
    button.onclick = () => {
      const title = $('#chartInfoTitle')
      const description = $('#chartInfoDescription')
      if (!title || !description) return
      title.textContent = button.dataset.chartInfoTitle || 'Informações do gráfico'
      description.textContent = button.dataset.chartInfo || ''
      modal('chartInfoModal', true)
    }
  })

  $$('.modal [data-close]').forEach((b) => b.onclick = () => {
    if (b.dataset.close === 'loginModal' && state.profile?.role !== 'admin') return
    if (b.dataset.close === 'settingsModal' && schoolSetupRequired) return toast('Informe o nome da escola para concluir a configuração inicial.', 'error')
    if (b.dataset.close === 'qrScannerModal') stopQrScanner()
    modal(b.dataset.close, false)
  })

  if ($('#copyNotificationBtn')) $('#copyNotificationBtn').onclick = async () => { try { await navigator.clipboard.writeText($('#notificationMessage')?.value || ''); toast('Mensagem copiada.') } catch { toast('Não foi possível copiar.', 'error') } }
  if ($('#sendWhatsappBtn')) $('#sendWhatsappBtn').onclick = () => triggerNotification('whatsapp')
  if ($('#sendEmailBtn')) $('#sendEmailBtn').onclick = () => triggerNotification('email')
  if ($('#sendCoordinationBtn')) $('#sendCoordinationBtn').onclick = () => triggerNotification('coordination')

  if ($('#logoutBtn')) $('#logoutBtn').onclick = async () => {
    const isCredeAdmin = state.profile?.role === 'libris_admin'
    resetAdminState()
    localStorage.removeItem(LOCAL_SESSION_KEY)
    modal('loginModal', true)
    if (isCredeAdmin && auth) {
      try { await signOut(auth) } catch (err) { error(err, 'Não foi possível encerrar a sessão da CREDE.') }
    }
    toast('Sessão encerrada.')
  }
}

/* -------------------------
   School settings
   ------------------------- */
function fillLibrisConfigurationForm(school = {}) {
  if ($('#librisConfigForm')) $('#librisConfigForm').dataset.schoolId = school.id || ''
  if ($('#librisSchoolInepInput')) $('#librisSchoolInepInput').value = school.inep || ''
  if ($('#librisSchoolNameInput')) $('#librisSchoolNameInput').value = school.name || ''
  if ($('#librisCoordinationEmailInput')) $('#librisCoordinationEmailInput').value = school.coordinationEmail || ''
  if ($('#librisSmtpHostInput')) $('#librisSmtpHostInput').value = school.smtp?.host || ''
  if ($('#librisSmtpPortInput')) $('#librisSmtpPortInput').value = String(school.smtp?.port || 587)
  if ($('#librisSmtpUsernameInput')) $('#librisSmtpUsernameInput').value = school.smtp?.username || ''
  if ($('#librisSmtpPasswordInput')) $('#librisSmtpPasswordInput').value = ''
  void updateEmailCredentialStatus('librisSmtpCredentialStatus', school.id)
  renderLocalAccountRows([])
}

function renderLocalAccountRows(accounts) {
  const container = $('#localAccountsList')
  if (!container) return
  container.replaceChildren()
  accounts.forEach((account) => addLocalAccountRow(account.email, account.id))
}

function addLocalAccountRow(email = '', id = '') {
  const container = $('#localAccountsList')
  if (!container) return
  const row = document.createElement('div')
  row.className = 'local-account-row'
  row.dataset.localAccountRow = ''
  row.dataset.userId = id
  const emailInput = document.createElement('input')
  emailInput.type = 'email'
  emailInput.autocomplete = 'off'
  emailInput.placeholder = 'email@escola.edu.br'
  emailInput.value = email
  emailInput.required = true
  emailInput.setAttribute('aria-label', 'Email da conta local')
  const passwordInput = document.createElement('input')
  passwordInput.type = 'password'
  passwordInput.autocomplete = 'new-password'
  passwordInput.placeholder = id ? 'Nova senha (vazio mantém a atual)' : 'Defina uma senha (mínimo 8 caracteres)'
  passwordInput.setAttribute('aria-label', 'Senha da conta local')
  passwordInput.dataset.localAccountPassword = ''
  passwordInput.required = !id
  const passwordField = document.createElement('div')
  passwordField.className = 'password-input'
  const passwordToggle = document.createElement('button')
  passwordToggle.type = 'button'
  passwordToggle.className = 'password-toggle'
  passwordToggle.textContent = '👁'
  passwordToggle.setAttribute('aria-label', 'Mostrar senha')
  passwordToggle.setAttribute('aria-pressed', 'false')
  passwordToggle.onclick = () => {
    const showing = passwordInput.type === 'password'
    passwordInput.type = showing ? 'text' : 'password'
    passwordToggle.setAttribute('aria-pressed', String(showing))
    passwordToggle.setAttribute('aria-label', showing ? 'Ocultar senha' : 'Mostrar senha')
  }
  passwordField.append(passwordInput, passwordToggle)
  const removeButton = document.createElement('button')
  removeButton.type = 'button'
  removeButton.className = 'small-btn danger'
  removeButton.textContent = 'Apagar'
  removeButton.onclick = () => row.remove()
  row.append(emailInput, passwordField, removeButton)
  container.append(row)
}

async function derivePasswordHash(password, salt, iterations = 310000) {
  if (!globalThis.crypto?.subtle) throw new Error('O armazenamento seguro de senhas não está disponível neste dispositivo.')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hashLocalPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return {
    passwordSalt: [...salt].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    passwordHash: await derivePasswordHash(password, salt),
    passwordIterations: 310000
  }
}

async function verifyLocalPassword(password, user) {
  const saltText = String(user.passwordSalt || '')
  if (!/^[a-f0-9]{32}$/i.test(saltText) || !user.passwordHash) return false
  const salt = new Uint8Array(saltText.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)))
  const iterations = Number(user.passwordIterations || 310000)
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false
  const hash = await derivePasswordHash(password, salt, iterations)
  if (hash.length !== user.passwordHash.length) return false
  let difference = 0
  for (let index = 0; index < hash.length; index += 1) difference |= hash.charCodeAt(index) ^ user.passwordHash.charCodeAt(index)
  return difference === 0
}

async function saveLibrisConfiguration(event) {
  event.preventDefault()
  if (state.profile?.role !== 'libris_admin') return toast('Somente a conta Libris pode alterar esta configuração.', 'error')

  const schoolInep = $('#librisSchoolInepInput')?.value.trim()
  const schoolName = $('#librisSchoolNameInput')?.value.trim()
  if (!/^\d{8}$/.test(schoolInep) || !schoolName) return toast('Informe o código INEP com 8 dígitos e o nome da escola.', 'error')
  const smtpHost = $('#librisSmtpHostInput')?.value.trim() || ''
  const smtpPort = Number($('#librisSmtpPortInput')?.value || 587)
  const smtpUsername = $('#librisSmtpUsernameInput')?.value.trim() || ''
  const smtpPassword = $('#librisSmtpPasswordInput')?.value || ''
  const smtpIsConfigured = Boolean(smtpHost || smtpUsername || smtpPassword)
  if (smtpIsConfigured && (!smtpHost || !smtpUsername || ![465, 587].includes(smtpPort))) {
    return toast('Para configurar SMTP, informe host, usuário/e-mail e porta segura 465 ou 587.', 'error')
  }
  if (smtpPassword && !isTauri()) {
    return toast('A senha SMTP só pode ser salva com segurança no aplicativo desktop Libris.', 'error')
  }
  const accounts = $$('[data-local-account-row]').map((row) => ({
    id: row.dataset.userId || '',
    email: row.querySelector('input[type="email"]')?.value.trim().toLowerCase() || '',
    password: row.querySelector('[data-local-account-password]')?.value || ''
  }))
  if (!accounts.length || accounts.some((account) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email))) return toast('Cadastre pelo menos uma conta com email válido.', 'error')
  if (new Set(accounts.map((account) => account.email)).size !== accounts.length) return toast('Cada email pode aparecer apenas uma vez.', 'error')
  if (accounts.some((account) => account.password && account.password.length < 8)) return toast('As senhas devem ter pelo menos 8 caracteres.', 'error')

  try {
    const existingSchools = await localStore.list('schools')
    const schoolId = existingSchools[0]?.id || schoolInep
    const existingSchool = existingSchools.find((item) => item.id === schoolId) || {}
    const existingSchoolSettings = { ...existingSchool }
    delete existingSchoolSettings.emailjs
    const school = {
      id: schoolId,
      schoolId,
      inep: schoolInep,
      name: schoolName,
      coordinationEmail: $('#librisCoordinationEmailInput')?.value.trim() || '',
      smtp: { host: smtpHost, port: smtpPort, username: smtpUsername },
      active: true,
      updatedAt: new Date()
    }
    const existingUsers = await localStore.list('users')
    const usersToSave = []
    for (const account of accounts) {
      const userId = `local-${encodeURIComponent(account.email)}`
      const previous = await localStore.get('users', account.id || userId)
      const credential = account.password
        ? await hashLocalPassword(account.password)
        : previous?.passwordHash && previous?.passwordSalt
          ? { passwordHash: previous.passwordHash, passwordSalt: previous.passwordSalt, passwordIterations: previous.passwordIterations || 310000 }
          : null
      if (!credential) throw new Error(`Defina uma senha para a nova conta ${account.email}.`)
      usersToSave.push({
        id: userId,
        email: account.email,
        role: 'admin',
        schoolId,
        active: true,
        ...credential,
        updatedAt: new Date()
      })
    }
    const batch = writeBatch(db)
    batch.set(doc(db, 'schools', schoolId), { ...existingSchoolSettings, ...school })
    existingUsers.filter((user) => user.schoolId === schoolId && user.role === 'admin').forEach((user) => {
      batch.set(doc(db, 'users', user.id), { ...user, active: false, updatedAt: new Date() }, { merge: true })
    })
    usersToSave.forEach((user) => batch.set(doc(db, 'users', user.id), user, { merge: true }))
    await batch.commit()
    if (smtpPassword) {
      try {
        await invoke('save_smtp_password', { schoolId, password: smtpPassword })
      } catch (err) {
        console.error('Configuração salva, mas a senha SMTP não foi salva:', err)
        return error(err, 'Configuração salva, mas não foi possível guardar a senha no cofre seguro. A senha não foi gravada localmente.')
      }
    }
    config.currentSchoolId = schoolId
    config.schoolName = schoolName
    config.smtp = school.smtp
    config.coordinationEmail = school.coordinationEmail
    if ($('#librisConfigForm')) $('#librisConfigForm').reset()
    resetAdminState()
    modal('loginModal', true)
    if (auth?.currentUser) await signOut(auth)
    toast('Configuração salva. As contas cadastradas já podem entrar com seus emails e senhas.')
  } catch (err) {
    error(err, 'Não foi possível salvar a configuração local.')
  }
}

async function saveSchoolSettings(event) {
  event.preventDefault()
  if (!db || !state.user) return toast('Entre com uma conta autorizada para alterar as configurações.', 'error')

  const schoolName = $('#schoolNameInput')?.value.trim() || ''
  const coordinationEmail = $('#coordinationEmailInput')?.value.trim() || ''

  const maxBooksStudent = Number($('#maxBooksStudentInput')?.value || config.maxBooksStudent || 2)
  const maxBooksTeacher = Number($('#maxBooksTeacherInput')?.value || config.maxBooksTeacher || 35)
  const studentLoanDays = Number($('#studentLoanDaysInput')?.value || 7)
  const teacherLoanDays = Number($('#teacherLoanDaysInput')?.value || 21)

  if (!schoolName) return toast('Informe o nome da escola para continuar.', 'error')
  if (!Number.isInteger(studentLoanDays) || studentLoanDays < 1 || studentLoanDays > 180 ||
      !Number.isInteger(teacherLoanDays) || teacherLoanDays < 1 || teacherLoanDays > 180) {
    return toast('Os prazos máximos devem ser números inteiros entre 1 e 180 dias.', 'error')
  }

  try {
    const schoolRef = doc(db, 'schools', config.currentSchoolId)
    const existingSchool = schoolSetupRequired ? await getDoc(schoolRef) : null
    const initialFields = schoolSetupRequired && !existingSchool?.exists() ? { active: true, bookSequences: {} } : {}
    await setDoc(schoolRef, {
      ...initialFields,
      name: schoolName,
      coordinationEmail,
      maxBooksStudent,
      maxBooksTeacher,
      studentLoanDays,
      teacherLoanDays,
      updatedAt: serverTimestamp()
    }, { merge: true })

    config.schoolName = schoolName
    config.coordinationEmail = coordinationEmail
    config.maxBooksStudent = maxBooksStudent
    config.maxBooksTeacher = maxBooksTeacher
    config.studentLoanDays = studentLoanDays
    config.teacherLoanDays = teacherLoanDays
    const selectedReader = state.readers.find((reader) => reader.id === $('#loanReaderIdInput')?.value)
    updateLoanDaysLimit(selectedReader)
    updateLoanQuantityLimit(selectedReader)
    syncSchoolSettingsForm(config)
    await logAudit(schoolSetupRequired ? 'school_initialized' : 'school_settings_updated', { schoolId: config.currentSchoolId, schoolName, coordinationEmail, maxBooksStudent, maxBooksTeacher, studentLoanDays, teacherLoanDays }, state.user?.uid || null)

    if (schoolSetupRequired) {
      if (!await loadSchoolData(config.currentSchoolId)) throw new Error('As configurações da escola não puderam ser recarregadas.')
      await subscribeAdmin()
      schoolSetupRequired = false
      if ($('#settingsModalTitle')) $('#settingsModalTitle').textContent = 'Configurações da escola'
      if ($('#adminView')) $('#adminView').hidden = false
      if ($('#openSettingsBtn')) $('#openSettingsBtn').hidden = false
      if ($('#logoutBtn')) $('#logoutBtn').hidden = false
      modal('loginModal', false)
      focusBookCodeInput()
    }

    modal('settingsModal', false)
    toast('Configurações salvas com sucesso.')
  } catch (err) {
    error(err, 'Não foi possível salvar as configurações da escola.')
  }
}

function syncSchoolSettingsForm(data = config) {
  const schoolNameInput = $('#schoolNameInput')
  const coordinationEmailInput = $('#coordinationEmailInput')
  const maxBooksStudentInput = $('#maxBooksStudentInput')
  const maxBooksTeacherInput = $('#maxBooksTeacherInput')
  const studentLoanDaysInput = $('#studentLoanDaysInput')
  const teacherLoanDaysInput = $('#teacherLoanDaysInput')
  const themePreferenceInput = $('#themePreferenceInput')
  const settings = data || {}

  if (schoolNameInput) schoolNameInput.value = settings.schoolName || ''
  if (coordinationEmailInput) coordinationEmailInput.value = settings.coordinationEmail || ''
  if (maxBooksStudentInput) maxBooksStudentInput.value = String(settings.maxBooksStudent ?? 2)
  if (maxBooksTeacherInput) maxBooksTeacherInput.value = String(settings.maxBooksTeacher ?? 35)
  if (studentLoanDaysInput) studentLoanDaysInput.value = String(settings.studentLoanDays ?? 7)
  if (teacherLoanDaysInput) teacherLoanDaysInput.value = String(settings.teacherLoanDays ?? 21)
  if (themePreferenceInput) themePreferenceInput.value = getThemePreference()
}

/* Load school settings after local email authorization. */
async function loadSchoolData(schoolId = config.currentSchoolId) {
  if (!db) return

  try {
    config.currentSchoolId = schoolId || config.currentSchoolId
    config.schoolName = ''
    config.coordinationEmail = ''
    config.reminderDays = 1
    config.coordinationDays = 7
    config.maxBooksStudent = 2
    config.maxBooksTeacher = 35
    config.studentLoanDays = 7
    config.teacherLoanDays = 21
    const school = await getDoc(doc(db, 'schools', config.currentSchoolId))
    if (school.exists()) {
      const data = school.data()
      config.schoolName = String(data.name || '').trim()
      config.coordinationEmail = data.coordinationEmail || ''
      config.reminderDays = Number(data.reminderDays ?? data.reminderBeforeDays ?? 1)
      config.coordinationDays = Number(data.coordinationDays ?? data.coordinationAfterDays ?? 7)
      config.maxBooksStudent = Number(data.maxBooksStudent ?? 2)
      config.maxBooksTeacher = Number(data.maxBooksTeacher ?? 35)
      config.studentLoanDays = Number(data.studentLoanDays ?? 7)
      config.teacherLoanDays = Number(data.teacherLoanDays ?? 21)
      config.smtp = {
        host: String(data.smtp?.host || ''),
        port: Number(data.smtp?.port || 587),
        username: String(data.smtp?.username || '')
      }
    } else {
      return false
    }
    const schoolNameNode = $('#schoolName')
    if (schoolNameNode) schoolNameNode.textContent = config.schoolName || 'Biblioteca escolar'
    syncSchoolSettingsForm()
    return Boolean(config.schoolName)
  } catch (err) {
    error(err, 'Não foi possível carregar a escola vinculada ao login.')
    return false
  }
}

async function enterSchoolPanel(user, persistSession = true) {
  if (!user?.active || user.role !== 'admin' || !user.schoolId) throw new Error('Esta conta não está ativa para uma escola.')
  state.user = { uid: user.id, email: user.email }
  state.profile = { role: 'admin', schoolId: user.schoolId, email: user.email, active: true }
  config.currentSchoolId = user.schoolId
  if (!await loadSchoolData(user.schoolId)) throw new Error('A escola desta conta ainda não foi configurada.')
  await subscribeAdmin()
  if (persistSession) {
    localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ userId: user.id, schoolId: user.schoolId }))
  }
  if ($('#adminView')) $('#adminView').hidden = false
  if ($('#librisAdminView')) $('#librisAdminView').hidden = true
  if ($('#openSettingsBtn')) $('#openSettingsBtn').hidden = false
  if ($('#logoutBtn')) $('#logoutBtn').hidden = false
  modal('loginModal', false)
  focusBookCodeInput()
}

async function handleLocalLogin(event) {
  event.preventDefault()
  const button = $('#localLoginBtn')
  const email = $('#localLoginEmailInput')?.value.trim().toLowerCase() || ''
  const password = $('#localLoginPasswordInput')?.value || ''
  loading(button, true, 'Validando acesso…')
  try {
    const users = await localStore.list('users')
    const user = users.find((record) => String(record.email || '').trim().toLowerCase() === email && record.active && record.role === 'admin')
    if (!user || !await verifyLocalPassword(password, user)) throw new Error('Email ou senha inválidos.')
    await enterSchoolPanel(user)
  } catch (err) {
    if (err?.message === 'Email ou senha inválidos.') toast(err.message, 'error')
    else error(err, 'Não foi possível iniciar a sessão local.')
  } finally {
    if ($('#localLoginPasswordInput')) $('#localLoginPasswordInput').value = ''
    loading(button, false)
  }
}

async function restoreLocalSession() {
  try {
    const session = JSON.parse(localStorage.getItem(LOCAL_SESSION_KEY) || 'null')
    if (!session?.userId || !session?.schoolId) return false
    const user = await localStore.get('users', session.userId)
    if (!user?.active || user.schoolId !== session.schoolId) {
      localStorage.removeItem(LOCAL_SESSION_KEY)
      return false
    }
    await enterSchoolPanel(user, false)
    return true
  } catch (err) {
    localStorage.removeItem(LOCAL_SESSION_KEY)
    error(err, 'Não foi possível restaurar a sessão local. Entre novamente.')
    return false
  }
}

async function handleCredeLogin(event) {
  event.preventDefault()
  const button = $('#credeLoginBtn')
  const email = $('#credeEmailInput')?.value.trim().toLowerCase() || ''
  const password = $('#credePasswordInput')?.value || ''
  loading(button, true, 'Validando acesso…')
  try {
    if (!auth) throw new Error('Autenticação administrativa indisponível. Verifique a configuração do Firebase.')
    const result = await signInWithEmailAndPassword(auth, email, password)
    state.user = result.user
    state.profile = { role: 'libris_admin', email: result.user.email || email }
    const schools = await localStore.list('schools')
    const school = schools[0] || {}
    fillLibrisConfigurationForm(school)
    if (school.id) {
      const users = (await localStore.list('users')).filter((user) => user.schoolId === school.id && user.role === 'admin' && user.active)
      renderLocalAccountRows(users)
    }
    if ($('#librisAdminView')) $('#librisAdminView').hidden = false
    if ($('#adminView')) $('#adminView').hidden = true
    if ($('#openSettingsBtn')) $('#openSettingsBtn').hidden = true
    if ($('#logoutBtn')) $('#logoutBtn').hidden = false
    if ($('#credeLoginForm')) $('#credeLoginForm').hidden = true
    if ($('#loginForm')) $('#loginForm').hidden = false
    modal('loginModal', false)
  } catch (err) {
    error(err, 'Não foi possível entrar como administração CREDE.')
  } finally {
    if ($('#credePasswordInput')) $('#credePasswordInput').value = ''
    loading(button, false)
  }
}

/* -------------------------
   Initialization
   ------------------------- */
setup()
syncSchoolSettingsForm()

if ($('#importCsvBtn')) $('#importCsvBtn').onclick = () => modal('importCsvFileModal', true)
if ($('#importCsvInput')) $('#importCsvInput').onchange = importCsv
const cancelCsvFileSelection = () => { if ($('#importCsvInput')) $('#importCsvInput').value = ''; modal('importCsvFileModal', false) }
if ($('#cancelCsvFileBtn')) $('#cancelCsvFileBtn').onclick = cancelCsvFileSelection
if ($('#closeCsvFileModalBtn')) $('#closeCsvFileModalBtn').onclick = cancelCsvFileSelection
const cancelCsvImport = () => { pendingCsvImport = null; modal('importCsvConfirmModal', false) }
if ($('#cancelCsvImportBtn')) $('#cancelCsvImportBtn').onclick = cancelCsvImport
if ($('#closeCsvImportBtn')) $('#closeCsvImportBtn').onclick = cancelCsvImport
if ($('#confirmCsvImportBtn')) $('#confirmCsvImportBtn').onclick = confirmCsvImport

async function init() {
  updateReaderFields()
  renderCategorySelect()
  renderCategoryList()
  renderBooks()
  renderReaders()
  renderLoans()
  renderDashboard()
  const adminView = $('#adminView')
  const settingsButton = $('#openSettingsBtn')
  const logoutButton = $('#logoutBtn')
  if (adminView) adminView.hidden = true
  if (settingsButton) settingsButton.hidden = true
  if (logoutButton) logoutButton.hidden = true
  if ($('#librisAdminView')) $('#librisAdminView').hidden = true
  if ($('#loginForm')) $('#loginForm').hidden = false
  if ($('#credeLoginForm')) $('#credeLoginForm').hidden = true
  const restored = await restoreLocalSession()
  if (!restored) {
    modal('loginModal', true)
    $('#localLoginEmailInput')?.focus()
  }
}

init()

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('PWA indisponível:', err))
  })
}
