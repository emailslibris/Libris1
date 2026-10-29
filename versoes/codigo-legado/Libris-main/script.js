/* Updated script.js — DOM blindagem e limpeza imediata de subscriptions ao signOut.
   Preserva obrigatoriedade schoolId, validações de estoque e regras de autenticação. */

import { firebaseReady, auth, googleProvider, googleDriveProvider, GoogleAuthProvider, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut } from './firebase.js'
import { createLocalStore } from './local-store.mjs'
import { createLocalDataApi } from './local-data.mjs'
import * as XLSX from 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm'

const localStore = createLocalStore()
const localData = createLocalDataApi(localStore)
const { db, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, query, where, onSnapshot, runTransaction, writeBatch, serverTimestamp, Timestamp, increment } = localData
const LIBRIS_ADMIN_EMAIL = 'admin@crede17.ce.gov.br'

const config = {
  organizationName: 'Libris',
  currentSchoolId: 'escola-padrao',
  schoolName: 'Biblioteca escolar',
  coordinationEmail: '',
  reminderDays: 1,
  coordinationDays: 7,
  maxBooksStudent: 2,
  maxBooksTeacher: 35,
  teacherLoanDays: 21
}

const defaultCategories = []
const categories = [{ id: 'all', name: 'Todas' }, ...defaultCategories]
const canUseFirebase = Boolean(firebaseReady && auth && db)

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
  loanQuery: '',
  adminUnsubs: [],
  driveAccessToken: '',
  loanFilter: 'all'
}

let pendingCsvImport = null
const selectedLabelBookIds = new Set()
let schoolSetupRequired = false

/* -------------------------
   DOM helpers & utilities (blindados)
   ------------------------- */
const $ = (s) => (typeof document !== 'undefined' ? document?.querySelector?.(s) ?? null : null)
const $$ = (s) => (typeof document !== 'undefined' ? Array.from(document?.querySelectorAll?.(s) || []) : [])
const esc = (v = '') => String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c])
const getCategoryOptions = () => (state.categories.length ? state.categories : defaultCategories)
const label = (id) => getCategoryOptions().find((x) => x.id === id)?.name || categories.find((x) => x.id === id)?.name || 'Geral'
const available = (b) => Number(b.available || 0) > 0
const bookStatus = (b) => available(b) ? 'disponivel' : 'emprestado'
const date = (v) => v?.toDate ? v.toDate() : v ? new Date(v) : null
const formatDate = (v) => date(v)?.toLocaleDateString('pt-BR') || '—'
const overdue = (l) => l.status === 'active' && date(l.dueAt) < new Date()

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
  body.innerHTML = list.length ? list.map((b) => `<tr><td>${esc(b.code)}</td><td>${esc(b.title)}</td><td>${esc(label(b.categoryId))}</td><td>${esc(b.tombamento || 'Não informado')}</td><td>${Number(b.total || 0)}</td><td>${esc(b.shelf || '—')}</td><td><span class="badge ${bookStatus(b) === 'disponivel' ? 'available' : 'borrowed'}">${bookStatus(b) === 'disponivel' ? 'Disponível' : 'Emprestado'}</span></td><td><div class="action-row"><button class="small-btn primary" type="button" data-edit-book="${b.id}">Editar</button><button class="small-btn danger" type="button" data-del-book="${b.id}">Apagar</button></div></td></tr>`).join('') : '<tr><td colspan="8">Nenhum livro cadastrado.</td></tr>'; 
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
  const list = state.readers.filter((r) => !q || [r.name, r.type, r.role, r.matricula].some((x) => String(x || '').toLowerCase().includes(q)))
  body.innerHTML = list.length ? list.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.type || r.role || 'Aluno')}</td><td>${esc(r.course || r.class || 'Não se aplica')}</td><td>${esc(r.type === 'Aluno' ? r.matricula : r.cpf || 'Não informado')}</td><td>${esc(r.email || '—')}<br><small>${esc(r.phone || '')}</small></td><td><div class="action-row"><button class="small-btn primary" type="button" data-edit-reader="${r.id}">Editar</button><button class="small-btn danger" type="button" data-del-reader="${r.id}">Apagar</button></div></td></tr>`).join('') : '<tr><td colspan="6">Nenhum leitor cadastrado.</td></tr>'; 
  $$('[data-edit-reader]').forEach((b) => b.onclick = () => editReader(b.dataset.editReader)); 
  $$('[data-del-reader]').forEach((b) => b.onclick = () => removeReader(b.dataset.delReader)); 
  renderReaderSelector()
}

function count(list, key) { const map = new Map(); list.forEach((x) => { const k = key(x); map.set(k, (map.get(k) || 0) + 1) }); return [...map].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value) }

function renderBars(target, data) { if (!target) return; if (!data.length) { target.innerHTML = '<p class="empty-state">Sem dados.</p>'; return }; const max = Math.max(...data.map((x) => x.value), 1); target.innerHTML = data.map((x) => `<div class="bar-row"><span>${esc(x.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${x.value / max * 100}%"></div></div><strong>${x.value}</strong></div>`).join('') }

function renderDashboard() { 
  const active = state.loans.filter((l) => l.status === 'active') 
  const overdueCount = active.filter(overdue).length

  const values = [
    ['Total de Livros', state.books.reduce((n, b) => n + Number(b.total || 0), 0), '📚', 'acervo'],
    ['Empréstimos Ativos', active.length, '📖', 'checkout'],
    ['Livros em Atraso', overdueCount, '⚠️', 'checkout'],
    ['Leitores Cadastrados', state.readers.length, '👥', 'leitores']
  ]

  const kpiGrid = $('#kpiGrid')
  if (kpiGrid) {
    kpiGrid.innerHTML = values.map(([name, value, icon, targetTab]) => `
      <div class="kpi-card panel clickable-kpi" data-target-tab="${targetTab}" style="cursor: pointer;">
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
        if (targetTab) {
          if (targetTab === 'checkout') {
            state.loanFilter = 'all'
          }
          $$('.tab-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === targetTab))
          $$('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === targetTab))
          renderLoans()
          $('.admin-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }
    })
  }

  renderBars($('#genreChart'), getCategoryOptions().map((c) => ({ label: c.name, value: state.books.filter((b) => b.categoryId === c.id).length })).filter((x) => x.value).sort((a, b) => b.value - a.value).slice(0, 5))
  const total = state.books.reduce((n, b) => n + Number(b.total || 0), 0)
  const free = state.books.reduce((n, b) => n + Number(b.available || 0), 0)
  const percent = total ? Math.round(free / total * 100) : 0
  if ($('#statusDonut')) $('#statusDonut').innerHTML = `<div class="donut" style="background:conic-gradient(var(--success) 0 ${percent}%,var(--warning) ${percent}% 100%)"><div class="donut-center">${percent}%</div></div>`
  if ($('#statusLegend')) $('#statusLegend').innerHTML = `<div class="legend-item"><span class="legend-dot success"></span>Disponíveis: ${free}</div><div class="legend-item"><span class="legend-dot warning"></span>Emprestados: ${Math.max(0, total - free)}</div>`
  renderBars($('#courseChart'), count(active, (l) => l.readerCourse || 'Não informado').slice(0, 5))
  const top = count(state.loans, (l) => l.readerName || 'Leitor').slice(0, 5)
  if ($('#readerChart')) $('#readerChart').innerHTML = top.length ? top.map((x) => `<div class="list-item"><strong>${esc(x.label)}</strong><span>${x.value} empréstimos</span></div>`).join('') : '<p class="empty-state">Sem dados.</p>'
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
  const role = String(reader.role || reader.type || 'student').toLowerCase()
  return role === 'teacher' ? Number(config.maxBooksTeacher || 35) : Number(config.maxBooksStudent || 2)
}

async function logAudit(action, details = {}, actorUid = null) {
  if (!canUseFirebase || !db) return
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
  const role = type === 'Professor' ? 'teacher' : type === 'Responsável' ? 'guardian' : 'student'
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
  if (!confirm('Apagar este livro do acervo?')) return
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
  const days = Number($('#loanDays')?.value || 7)
  const book = state.books.find((b) => b.code?.toUpperCase() === code)
  const reader = selectedReaderId ? state.readers.find((r) => r.id === selectedReaderId) : state.readers.find((r) => r.matricula === text || r.name?.toLocaleLowerCase('pt-BR') === text?.toLocaleLowerCase('pt-BR'))

  if (!book || !reader) {
    return toast(!book ? 'Livro não encontrado.' : 'Leitor não encontrado.', 'error')
  }

  const activeLoansForReader = state.loans.filter((loan) => loan.readerId === reader.id && loan.status === 'active')
  const loanLimit = getLoanLimitForReader(reader)

  if (activeLoansForReader.length >= loanLimit) {
    return toast(`Limite excedido para ${reader.role || reader.type || 'este perfil'}: ${loanLimit} empréstimos ativos (Já possui ${activeLoansForReader.length}).`, 'error')
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

  const role = String(reader.role || reader.type || 'student').toLowerCase()
  loading(button, true, 'Registrando…')

  try {
    await runTransaction(db, async (tx) => {
      const bookRef = doc(db, 'books', book.id)
      const bookSnap = await tx.get(bookRef)

      if (!bookSnap.exists() || Number(bookSnap.data().available || 0) < 1) {
        throw new Error('indisponível')
      }

      const availableCopies = Number(bookSnap.data().available || 0)
      const due = new Date()
      const effectiveDays = role === 'teacher' ? Number(config.teacherLoanDays || days || 21) : Number(days || 7)
      due.setDate(due.getDate() + effectiveDays)

      tx.update(bookRef, {
        available: increment(-1),
        status: availableCopies - 1 > 0 ? 'disponivel' : 'emprestado',
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
        days: effectiveDays,
        dueAt: Timestamp.fromDate(due),
        status: 'active',
        notices: {},
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
    })

    await logAudit('loan_created', { bookId: book.id, readerId: reader.id, days }, state.user?.uid || null)
    if ($('#bookCodeInput')) $('#bookCodeInput').value = ''
    if ($('#readerInput')) $('#readerInput').value = ''
    if ($('#loanReaderIdInput')) $('#loanReaderIdInput').value = ''
    if ($('#readerSuggestions')) $('#readerSuggestions').hidden = true
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
      const bookRef = doc(db, 'books', loanSnap.data().bookId)
      const bookSnap = await tx.get(bookRef)

      tx.update(loanRef, { status: 'returned', returnedAt: serverTimestamp(), updatedAt: serverTimestamp(), schoolId: loanSnap.data().schoolId || config.currentSchoolId })

      if (bookSnap.exists()) {
        const free = Math.min(Number(bookSnap.data().available || 0) + 1, Number(bookSnap.data().total || 0))
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
  try {
    const due = date(loan.dueAt) ? new Date(date(loan.dueAt)) : new Date()
    due.setDate(due.getDate() + days)
    await updateDoc(doc(db, 'loans', id), { days, dueAt: Timestamp.fromDate(due), notices: {}, schoolId: config.currentSchoolId, updatedAt: serverTimestamp() })
    await logAudit('loan_renewed', { loanId: id, days }, state.user?.uid || null)
    toast(`Renovação concluída por ${days} dias.`)
  } catch (err) { error(err, 'Não foi possível renovar o empréstimo.') }
}

/* Notifications */
function normalizePhone(phone = '') {
  return String(phone || '').replace(/\D/g, '')
}

function openWhatsAppMessage(reader, message) {
  const phone = normalizePhone(reader?.phone)
  if (!phone) return false
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
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
    return toast('O envio de e-mails está disponível somente no aplicativo desktop Libris.')
  }

  if (type === 'whatsapp') {
    const sent = openWhatsAppMessage(reader, message)
    if (!sent) return toast('Este leitor não possui telefone cadastrado para WhatsApp.', 'error')

    toast('WhatsApp aberto com a mensagem.')
    modal('notificationModal', false)
    return
  }

  return toast('O envio de e-mails está disponível somente no aplicativo desktop Libris.')
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
    if (field === 'synopsis' || field === 'coverUrl') return ''
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

  const collectionNames = ['reservations', 'counters', 'audit_logs', 'users']
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
    ['Leitores', recordsToExportRows(state.readers)],
    ['Categorias', recordsToExportRows(state.categories)],
    ['Reservas', recordsToExportRows(collectionRecords.reservations)],
    ['Contadores', recordsToExportRows(collectionRecords.counters)],
    ['Auditoria', recordsToExportRows(collectionRecords.audit_logs)],
    ['Usuarios', recordsToExportRows(collectionRecords.users)],
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

async function getDriveAccessToken() {
  if (state.driveAccessToken) return state.driveAccessToken
  const result = await signInWithPopup(auth, googleDriveProvider)
  const credential = GoogleAuthProvider.credentialFromResult(result)
  if (!credential?.accessToken) throw new Error('O Google não forneceu acesso ao Drive. Entre novamente e autorize o acesso aos arquivos.')
  const identityResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${credential.accessToken}` }
  })
  if (!identityResponse.ok) throw new Error('Não foi possível confirmar a conta Google usada no Drive.')
  const identity = await identityResponse.json()
  if (String(identity.email || '').toLowerCase() !== String(state.user?.email || '').toLowerCase()) {
    throw new Error('Entre no Drive com o mesmo email autorizado no Libris.')
  }
  state.driveAccessToken = credential.accessToken
  return state.driveAccessToken
}

async function updateDriveBackupStatus() {
  const button = $('#backupDriveBtn')
  const status = $('#backupDriveStatus')
  if (!button || !status || state.profile?.role !== 'admin') return false
  const backup = await getDoc(doc(db, '_local_metadata', `drive-backup-${config.currentSchoolId}`))
  const lastBackupAt = backup.exists() ? new Date(backup.data().lastBackupAt || 0) : null
  const due = !lastBackupAt || Date.now() - lastBackupAt.getTime() >= 7 * 24 * 60 * 60 * 1000
  button.hidden = false
  button.textContent = due ? 'Enviar backup semanal' : 'Backup no Drive'
  status.hidden = false
  status.textContent = due
    ? 'Backup semanal pendente. O envio ocorre com esta máquina ligada e conectada.'
    : `Último backup: ${lastBackupAt.toLocaleString('pt-BR')}`
  return due
}

async function uploadDriveBackup() {
  const button = $('#backupDriveBtn')
  if (!state.user || state.profile?.role !== 'admin') return
  loading(button, true, 'Enviando backup…')
  try {
    const accessToken = await getDriveAccessToken()
    const snapshot = await localStore.exportSchool(config.currentSchoolId)
    const boundary = `libris_${globalThis.crypto?.randomUUID?.() || Date.now()}`
    const filename = `${backupFileBaseName()}.json`
    const metadata = JSON.stringify({ name: filename, mimeType: 'application/json' })
    const content = JSON.stringify(snapshot)
    const body = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}`,
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}`,
      `--${boundary}--`
    ].join('\r\n')
    const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    })
    if (!response.ok) {
      const result = await response.json().catch(() => ({}))
      if (response.status === 401) state.driveAccessToken = ''
      throw new Error(result.error?.message || 'O Google Drive recusou o backup.')
    }
    const uploadedFile = await response.json()
    await setDoc(doc(db, '_local_metadata', `drive-backup-${config.currentSchoolId}`), {
      lastBackupAt: new Date(),
      filename,
      driveFileId: uploadedFile.id
    })
    toast('Backup semanal enviado ao Google Drive.')
  } catch (err) {
    console.error('Falha no backup semanal:', err)
    error(err, 'Não foi possível enviar o backup ao Google Drive.')
  } finally {
    loading(button, false)
    await updateDriveBackupStatus()
  }
}

async function restoreLocalBackup(event) {
  const input = event.target
  const file = input.files?.[0]
  if (!file) return
  try {
    const snapshot = JSON.parse(await file.text())
    if (snapshot.schoolId !== config.currentSchoolId || !snapshot.collections) {
      throw new Error('Este arquivo não é um backup válido desta escola.')
    }
    if (!confirm(`O backup substituirá os dados locais de ${config.schoolName}. Deseja continuar?`)) return
    await localStore.replaceSchool(config.currentSchoolId, snapshot)
    if (!await loadSchoolData(config.currentSchoolId)) throw new Error('Não foi possível carregar as configurações restauradas.')
    await subscribeAdmin()
    toast('Backup restaurado nesta máquina.')
  } catch (err) {
    error(err, 'Não foi possível restaurar o backup JSON.')
  } finally {
    input.value = ''
  }
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function exportCsv() {
  const button = $('#exportCsvOption')
  loading(button, true, 'Preparando backup…')
  try {
    const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')
    const tables = await schoolBackupTables()
    const zip = new JSZip()
    tables.forEach(([name, rows]) => zip.file(`${name.toLocaleLowerCase('pt-BR')}.csv`, `\ufeff${csvFromRows(rows)}`))
    zip.file('LEIA-ME.txt', `Backup escolar Libris\nEscola: ${config.schoolName}\nID: ${config.currentSchoolId}\nGerado em: ${new Date().toISOString()}\n\nCada arquivo CSV corresponde a uma coleção da escola. Empréstimos inclui registros ativos e devolvidos; auditoria registra eventos disponíveis no sistema.`)
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
    downloadBlob(blob, `${backupFileBaseName()}.zip`)
    modal('exportModal', false)
  } catch (err) {
    console.error('Falha ao exportar backup CSV:', err)
    error(err, 'Não foi possível gerar o backup CSV da escola.')
  } finally {
    loading(button, false)
  }
}

async function exportXlsx() {
  const button = $('#exportXlsxOption')
  loading(button, true, 'Preparando backup…')
  try {
    const tables = await schoolBackupTables()
    const workbook = XLSX.utils.book_new()
    tables.forEach(([name, rows]) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name))
    XLSX.writeFile(workbook, `${backupFileBaseName()}.xlsx`)
    modal('exportModal', false)
  } catch (err) {
    console.error('Falha ao exportar backup XLSX:', err)
    error(err, 'Não foi possível gerar o backup XLSX da escola.')
  } finally {
    loading(button, false)
  }
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
  modal('importCsvFileModal', false)
  if (!canUseFirebase || !db || !state.user) { if (input) input.value = ''; return toast('Entre no painel administrativo para importar livros.', 'error') }

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

    const categoriesByName = new Map()
    getCategoryOptions().forEach((category) => {
      categoriesByName.set(normalizeCsvHeader(category.name), category)
      categoriesByName.set(normalizeCsvHeader(category.code || category.id), category)
    })
    const existingCodes = new Set(state.books.map((book) => String(book.code || '').trim().toUpperCase()))
    const existingDocumentIds = new Set(state.books.map((book) => book.id).filter(Boolean))
    const seenCodes = new Set()
    const booksToImport = []
    const countersToUpdate = new Map()
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
      const category = categoriesByName.get(normalizeCsvHeader(categoryName)) || categoriesByName.get(normalizeCsvHeader(categoryId))
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
      else if (!category) rowErrors.push(`categoria não cadastrada: ${categoryName || categoryId}`)
      if (total === null || total < 1) rowErrors.push('total inválido')
      if (available === null || available > total) rowErrors.push('disponíveis deve estar entre 0 e o total')
      if (year === null) rowErrors.push('ano inválido')
      if (sourceSchoolId && sourceSchoolId !== config.currentSchoolId) rowErrors.push(`arquivo pertence à escola ${sourceSchoolId}`)
      if (createdAtValue && !createdAt) rowErrors.push('data de criação inválida')
      if (updatedAtValue && !updatedAt) rowErrors.push('data de atualização inválida')
      if (sourceDocumentId && (sourceDocumentId.includes('/') || sourceDocumentId.length > 1500)) rowErrors.push('ID do documento inválido')
      if (codeParts && category && codeParts[1] !== String(category.code || category.id).toUpperCase()) rowErrors.push('prefixo do código não corresponde à categoria')
      if (rowErrors.length) {
        errors.push(`linha ${line} (${rowErrors.join(', ')})`)
        return
      }
      if (seenCodes.has(code)) {
        errors.push(`linha ${line} (código repetido no arquivo: ${code})`)
        return
      }
      seenCodes.add(code)
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
        categoryName: categoryName || category.name,
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
        schoolId: config.currentSchoolId
      })
      const [prefix, codeNumber] = [codeParts[1], Number(codeParts[2])]
      countersToUpdate.set(prefix, Math.max(countersToUpdate.get(prefix) || 0, codeNumber))
    })

    if (errors.length) { if (input) input.value = ''; return toast(`Corrija as linhas inválidas: ${errors.slice(0, 4).join('; ')}${errors.length > 4 ? '; …' : ''}. Nada foi importado.`, 'error') }
    if (!booksToImport.length) { if (input) input.value = ''; return toast(skipped.length ? `Nenhum livro novo. ${skipped.length} código(s) já existiam no acervo.` : 'Nenhum livro válido para importar.', 'error') }
    pendingCsvImport = { books: booksToImport, counters: countersToUpdate, skippedCount: skipped.length }
    if ($('#importCsvSummary')) $('#importCsvSummary').textContent = `Importar ${booksToImport.length} livro(s)? Códigos já existentes serão ignorados.`
    modal('importCsvConfirmModal', true)
  } catch (err) {
    error(err, 'Não foi possível ler ou validar o CSV.')
  } finally {
    if (input) input.value = ''
  }
}

async function confirmCsvImport() {
  const pending = pendingCsvImport
  if (!pending || !state.user || !canUseFirebase || !db) return
  const button = $('#confirmCsvImportBtn')
  loading(button, true, 'Importando…')

  try {
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
  selectedLabelBookIds.clear()
  schoolSetupRequired = false
  state.user = null
  state.profile = null
  state.driveAccessToken = ''
  state.readers = []
  state.loans = []
  state.books = []
  state.categories = []
  if ($('#librisAdminView')) $('#librisAdminView').hidden = true
  if ($('#adminView')) $('#adminView').hidden = true
  if ($('#backupDriveBtn')) $('#backupDriveBtn').hidden = true
  if ($('#backupDriveStatus')) $('#backupDriveStatus').hidden = true
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
    return state.books.filter((book) => selectedLabelBookIds.has(book.id))
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
    context.font = '700 22px Georgia, serif'
    context.fillText('LIBRIS', 58, 82)
    context.fillStyle = '#718078'
    context.font = '600 17px Arial, sans-serif'
    context.fillText(String(config.schoolName || 'Biblioteca escolar').toLocaleUpperCase('pt-BR').slice(0, 48), 58, 112)
    context.strokeStyle = '#e2e9e4'
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(58, 138)
    context.lineTo(745, 138)
    context.stroke()

    context.fillStyle = '#24352b'
    context.font = '700 38px Georgia, serif'
    drawWrappedLabelText(context, book.title || 'Livro sem título', 58, 206, 655, 52, 2)
    context.fillStyle = '#4f6256'
    context.font = '500 25px Arial, sans-serif'
    drawWrappedLabelText(context, book.author || 'Autoria não informada', 58, 326, 650, 34, 2)

    context.fillStyle = '#1e5b3d'
    context.font = '700 18px Arial, sans-serif'
    context.fillText(String(book.categoryName || label(book.categoryId) || '').toLocaleUpperCase('pt-BR').slice(0, 42), 58, 418)
    context.fillStyle = '#718078'
    context.font = '600 15px Arial, sans-serif'
    context.fillText('CÓDIGO DO ACERVO', 58, 490)
    context.fillStyle = '#24352b'
    context.font = '700 34px Arial, sans-serif'
    context.fillText(String(book.code || '').toLocaleUpperCase('pt-BR').slice(0, 18), 58, 540)

    context.fillStyle = '#ffffff'
    context.fillRect(770, 144, 300, 324)
    context.drawImage(qrImage, 780, 154, 280, 280)
    context.fillStyle = '#718078'
    context.font = '700 14px Arial, sans-serif'
    context.textAlign = 'center'
    context.fillText('IDENTIFICAÇÃO DIGITAL', 920, 455)
    context.fillStyle = '#1e5b3d'
    context.font = '700 17px Arial, sans-serif'
    context.fillText('ESCANEIE PARA CONFERIR', 920, 484)
    context.textAlign = 'start'

    return canvas
  }

  let labelPreviewRequest = 0

  function renderLabelBookList() {
    const list = $('#labelBookList')
    if (!list) return
    const queryText = ($('#labelBookSearchInput')?.value || '').trim().toLocaleLowerCase('pt-BR')
    const books = state.books.filter((book) => !queryText || [book.title, book.author, book.code].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(queryText)))

    list.innerHTML = books.length ? books.map((book) => `
      <label class="label-book-option">
        <input type="checkbox" data-label-book="${esc(book.id)}" ${selectedLabelBookIds.has(book.id) ? 'checked' : ''} />
        <span><strong>${esc(book.title || 'Livro sem título')}</strong><small>${esc(book.code || 'Sem código')} · ${esc(book.author || 'Autoria não informada')}</small></span>
      </label>
    `).join('') : '<p class="label-book-empty">Nenhum livro encontrado nesta escola.</p>'
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

    if (count) count.textContent = `${books.length} selecionado${books.length === 1 ? '' : 's'}`
    if (jpgButton) {
      jpgButton.disabled = books.length === 0 || books.length > 20
      jpgButton.title = books.length > 20 ? 'Selecione até 20 livros para gerar uma única folha JPG.' : ''
    }
    if (pdfButton) pdfButton.disabled = books.length === 0

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
      if (caption) caption.textContent = books.length > 1 ? `Prévia da primeira de ${books.length} etiquetas.` : 'Etiqueta no formato pronto para impressão.'
    } catch (err) {
      console.error('Falha ao gerar prévia QR:', err)
      if (caption) caption.textContent = 'Não foi possível gerar o QR. Confira sua conexão e tente novamente.'
    }
  }

  function renderLabelSelection() {
    renderLabelBookList()
    updateLabelPreview()
  }

  function downloadCanvas(canvas, filename) {
    const link = document.createElement('a')
    link.download = filename
    link.href = canvas.toDataURL('image/jpeg', 0.94)
    link.click()
  }

  async function downloadLabelSheetJpg() {
    const books = selectedLabelBooks()
    if (!books.length || books.length > 20) return
    const button = $('#downloadLabelsJpgBtn')
    loading(button, true, 'Gerando JPG…')
    try {
      const labels = await Promise.all(books.map(createBookLabelCanvas))
      const columns = 2
      const rows = Math.ceil(labels.length / columns)
      const gap = 24
      const sheet = document.createElement('canvas')
      sheet.width = 2 * 1104 + 3 * gap
      sheet.height = rows * 600 + (rows + 1) * gap
      const context = sheet.getContext('2d')
      context.fillStyle = '#f1f4f1'
      context.fillRect(0, 0, sheet.width, sheet.height)
      labels.forEach((labelCanvas, index) => {
        const column = index % columns
        const row = Math.floor(index / columns)
        context.drawImage(labelCanvas, gap + column * (1104 + gap), gap + row * (600 + gap))
      })
      const safeSchoolId = String(config.currentSchoolId).replace(/[^a-z0-9_-]/gi, '_')
      downloadCanvas(sheet, `etiquetas-${safeSchoolId}.jpg`)
    } catch (err) {
      console.error('Falha ao gerar etiquetas JPG:', err)
      toast('Não foi possível gerar o JPG. Tente novamente.', 'error')
    } finally {
      loading(button, false)
    }
  }

  async function downloadLabelSheetPdf() {
    const books = selectedLabelBooks()
    if (!books.length) return
    const button = $('#downloadLabelsPdfBtn')
    loading(button, true, 'Gerando PDF…')
    try {
      const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
      const cardWidth = 90
      const cardHeight = cardWidth * 600 / 1104
      const columnGap = 10
      const rowGap = 5
      const leftMargin = 10
      const topMargin = 14

      for (const [index, book] of books.entries()) {
        if (index > 0 && index % 10 === 0) pdf.addPage()
        const position = index % 10
        const column = position % 2
        const row = Math.floor(position / 2)
        const x = leftMargin + column * (cardWidth + columnGap)
        const y = topMargin + row * (cardHeight + rowGap)
        const labelCanvas = await createBookLabelCanvas(book)
        pdf.addImage(labelCanvas.toDataURL('image/jpeg', 0.95), 'JPEG', x, y, cardWidth, cardHeight, undefined, 'FAST')
      }

      pdf.setProperties({ title: `Etiquetas de ${config.schoolName}`, subject: `Acervo ${config.currentSchoolId}`, author: 'Libris' })
      const safeSchoolId = String(config.currentSchoolId).replace(/[^a-z0-9_-]/gi, '_')
      pdf.save(`etiquetas-${safeSchoolId}.pdf`)
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
  if (!canUseFirebase || !db) return
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
  })

  tbody.innerHTML = list.length ? list.map((l) => {
    const selectedDays = Number(l.days || 7)
    const renewOptions = [7, 14, 21, 30].map((days) => `<option value="${days}" ${days === selectedDays ? 'selected' : ''}>${days} dias</option>`).join('')
    return `<tr><td>${esc(l.bookTitle)}<br><small>${esc(l.bookCode)}</small></td><td>${esc(l.readerName)}</td><td><div>${formatDate(l.dueAt)}</div><small>Prazo: ${selectedDays} dias</small></td><td><span class="badge ${overdue(l) ? 'borrowed' : 'available'}">${overdue(l) ? 'Em atraso' : 'Em dia'}</span></td><td><div class="action-row"><select class="renew-days" data-renew-days="${l.id}" aria-label="Dias para renovar">${renewOptions}</select><button class="small-btn primary" data-return="${l.id}" type="button">Devolver</button><button class="small-btn warning" data-renew="${l.id}" type="button">Renovar</button><button class="small-btn danger" data-notify="${l.id}" type="button">Notificar</button></div></td></tr>`
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
function notify(id) {
  const loan = state.loans.find((l) => l.id === id)
  const reader = state.readers.find((r) => r.id === loan?.readerId)
  if (!loan) return
  if ($('#notificationContact')) $('#notificationContact').textContent = `${reader?.email || loan.readerEmail || 'E-mail não informado'} · ${reader?.phone || 'Telefone não informado'}`
  if ($('#notificationMessage')) $('#notificationMessage').value = `Olá, ${loan.readerName}. O empréstimo do livro "${loan.bookTitle}" vence em ${formatDate(loan.dueAt)}. Por favor, procure a biblioteca escolar.`
  const modalEl = $('#notificationModal')
  if (modalEl) modalEl.dataset.loanId = String(id)
  modal('notificationModal', true)
}

/* -------------------------
   QR scanner
   ------------------------- */
let qrScannerStream = null
let qrScannerControls = null
let qrHardwareScanTimer = null

function stopQrScanner() {
  clearTimeout(qrHardwareScanTimer)
  qrHardwareScanTimer = null
  qrScannerControls?.stop()
  qrScannerControls = null
  const video = $('#qrScannerVideo')
  const stream = qrScannerStream || video?.srcObject
  stream?.getTracks().forEach((track) => track.stop())
  qrScannerStream = null
  if (video) {
    video.pause()
    video.srcObject = null
  }
}

function openQrScanner() {
  stopQrScanner()
  if ($('#qrCameraPanel')) $('#qrCameraPanel').hidden = true
  if ($('#qrHardwarePanel')) $('#qrHardwarePanel').hidden = true
  if ($('#qrCameraModeBtn')) $('#qrCameraModeBtn').classList.remove('is-active')
  if ($('#qrHardwareModeBtn')) $('#qrHardwareModeBtn').classList.remove('is-active')
  if ($('#qrCameraModeBtn')) $('#qrCameraModeBtn').setAttribute('aria-pressed', 'false')
  if ($('#qrHardwareModeBtn')) $('#qrHardwareModeBtn').setAttribute('aria-pressed', 'false')
  if ($('#hardwareScannerInput')) $('#hardwareScannerInput').value = ''
  modal('qrScannerModal', true)
  $('#qrCameraModeBtn')?.focus()
}

function acceptScannedBook(rawValue) {
  const normalizedValue = String(rawValue || '').trim()
  if (!normalizedValue) return false

  let payload = null
  try { payload = JSON.parse(normalizedValue) } catch { /* Leitores antigos podem enviar somente o código */ }
  const payloadSchoolId = payload?.schoolId || payload?.s
  const payloadBookId = payload?.bookId || payload?.b
  const payloadCode = payload?.code || payload?.c
  if (payloadSchoolId && payloadSchoolId !== config.currentSchoolId) {
    const message = 'Este código pertence a outra escola. Use uma etiqueta desta unidade.'
    if ($('#hardwareScannerStatus')) $('#hardwareScannerStatus').textContent = message
    if ($('#qrScannerStatus')) $('#qrScannerStatus').textContent = message
    toast(message, 'error')
    return false
  }

  const matchedCode = payloadCode || normalizedValue.match(/(?:^|[^A-Z0-9])([A-Z0-9]{1,4}-\d{4})(?:$|[^A-Z0-9])/i)?.[1] || normalizedValue
  const book = payloadBookId
    ? state.books.find((item) => item.id === payloadBookId)
    : state.books.find((item) => item.code?.toUpperCase() === String(matchedCode).toUpperCase())
  if (!book) {
    const message = 'Livro não encontrado no acervo desta escola.'
    if ($('#hardwareScannerStatus')) $('#hardwareScannerStatus').textContent = message
    if ($('#qrScannerStatus')) $('#qrScannerStatus').textContent = `${message} Aponte para outra etiqueta.`
    toast(message, 'error')
    return false
  }

  if ($('#bookCodeInput')) $('#bookCodeInput').value = String(book.code || matchedCode).toUpperCase()
  stopQrScanner()
  modal('qrScannerModal', false)
  $('#bookCodeInput')?.focus()
  toast('Código lido. Confira o livro e registre o empréstimo.')
  return true
}

function processHardwareScan() {
  const input = $('#hardwareScannerInput')
  const value = input?.value.trim()
  if (!value) return
  const accepted = acceptScannedBook(value)
  if (!accepted && input) {
    input.value = ''
    input.focus()
  }
}

function selectQrInputMode(mode) {
  stopQrScanner()
  const useCamera = mode === 'camera'
  if ($('#qrCameraPanel')) $('#qrCameraPanel').hidden = !useCamera
  if ($('#qrHardwarePanel')) $('#qrHardwarePanel').hidden = useCamera
  if ($('#qrCameraModeBtn')) $('#qrCameraModeBtn').classList.toggle('is-active', useCamera)
  if ($('#qrHardwareModeBtn')) $('#qrHardwareModeBtn').classList.toggle('is-active', !useCamera)
  if ($('#qrCameraModeBtn')) $('#qrCameraModeBtn').setAttribute('aria-pressed', String(useCamera))
  if ($('#qrHardwareModeBtn')) $('#qrHardwareModeBtn').setAttribute('aria-pressed', String(!useCamera))

  if (useCamera) {
    startQrCamera()
  } else {
    if ($('#hardwareScannerInput')) {
      $('#hardwareScannerInput').value = ''
      $('#hardwareScannerInput').focus()
    }
    if ($('#hardwareScannerStatus')) $('#hardwareScannerStatus').textContent = 'Leitor pronto. Mire o código ou escaneie a etiqueta QR.'
  }
}

async function startQrCamera() {
  const status = $('#qrScannerStatus')
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = 'Para usar a câmera do celular, abra o Libris pelo endereço HTTPS publicado. Acesso local por HTTP pode bloquear a câmera.'
    if (status) status.textContent = message
    return toast(message, 'error')
  }
  const video = $('#qrScannerVideo')
  if (!video) return toast('A janela do leitor QR não está disponível.', 'error')
  if (status) status.textContent = 'Carregando leitor QR e solicitando acesso à câmera…'
  try {
    const { BrowserQRCodeReader } = await import('https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm')
    const reader = new BrowserQRCodeReader()
    qrScannerControls = await reader.decodeFromVideoDevice(
      undefined,
      video,
      (result, scanError, controls) => {
        if (result) {
          if (acceptScannedBook(result.getText())) controls.stop()
        }
        if (scanError && scanError.name !== 'NotFoundException') {
          console.warn('Falha durante a leitura do QR code:', scanError)
        }
      },
      { video: { facingMode: { ideal: 'environment' } }, audio: false }
    )
    qrScannerStream = video.srcObject
    if (status) status.textContent = 'Aponte a câmera para o QR code do livro.'
  } catch (err) {
    stopQrScanner()
    const message = err?.name === 'NotAllowedError'
      ? 'Permita o acesso à câmera para escanear o livro.'
      : err?.name === 'NotFoundError'
        ? 'Nenhuma câmera foi encontrada neste dispositivo.'
        : 'Não foi possível iniciar o leitor QR. Digite o código do livro manualmente.'
    if (status) status.textContent = `${message} Você também pode escolher um leitor externo.`
    toast(message, 'error')
  }
}

/* -------------------------
   Form wiring and setup
   ------------------------- */
function setup() {
  // Tabs
  $$('.tab-btn').forEach((b) => b.onclick = () => {
    $$('.tab-btn').forEach((tb) => tb.classList.toggle('is-active', tb === b))
    $$('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === b.dataset.tab))
  })

  if ($('#acervoSearchInput')) $('#acervoSearchInput').oninput = (x) => { state.acervoQuery = x.target.value; renderBooks() }
  if ($('#readerSearchInput')) $('#readerSearchInput').oninput = (x) => { state.readerQuery = x.target.value; renderReaders() }
  if ($('#loanSearchInput')) $('#loanSearchInput').oninput = (x) => { state.loanQuery = x.target.value; renderLoans() }
  if ($('#readerInput')) {
    $('#readerInput').oninput = () => {
      if ($('#loanReaderIdInput')) $('#loanReaderIdInput').value = ''
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
  if ($('#schoolSettingsForm')) $('#schoolSettingsForm').onsubmit = saveSchoolSettings
  if ($('#readerTypeInput')) $('#readerTypeInput').onchange = updateReaderFields
  if ($('#registerLoanBtn')) $('#registerLoanBtn').onclick = registerLoan
  if ($('#scanBtn')) $('#scanBtn').onclick = openQrScanner
  if ($('#qrScannerModal')) $('#qrScannerModal').onclick = (event) => {
    const modeButton = event.target.closest('[data-qr-mode]')
    if (modeButton) selectQrInputMode(modeButton.dataset.qrMode)
  }
  if ($('#hardwareScannerInput')) {
    $('#hardwareScannerInput').oninput = () => {
      clearTimeout(qrHardwareScanTimer)
      if ($('#hardwareScannerStatus')) $('#hardwareScannerStatus').textContent = 'Leitura recebida. Aguardando o término do código…'
      qrHardwareScanTimer = setTimeout(processHardwareScan, 350)
    }
    $('#hardwareScannerInput').onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        processHardwareScan()
      }
    }
  }

  if ($('#openBookModalBtn')) $('#openBookModalBtn').onclick = () => { resetBookForm(); modal('bookFormModal', true) }
  if ($('#openReaderModalBtn')) $('#openReaderModalBtn').onclick = () => { resetReaderForm(); modal('readerFormModal', true) }
  if ($('#openCategoryModalBtn')) $('#openCategoryModalBtn').onclick = () => { if ($('#categoryForm')) $('#categoryForm').reset(); modal('categoryModal', true) }
  if ($('#openBookLabelsBtn')) $('#openBookLabelsBtn').onclick = () => {
    if ($('#labelBookSearchInput')) $('#labelBookSearchInput').value = ''
    renderLabelSelection()
    modal('bookLabelsModal', true)
  }
  if ($('#labelBookSearchInput')) $('#labelBookSearchInput').oninput = renderLabelBookList
  if ($('#labelBookList')) $('#labelBookList').onchange = (event) => {
    const checkbox = event.target.closest('[data-label-book]')
    if (!checkbox) return
    if (checkbox.checked) selectedLabelBookIds.add(checkbox.dataset.labelBook)
    else selectedLabelBookIds.delete(checkbox.dataset.labelBook)
    updateLabelPreview()
  }
  if ($('#selectLabelSearchResultsBtn')) $('#selectLabelSearchResultsBtn').onclick = () => {
    const queryText = ($('#labelBookSearchInput')?.value || '').trim().toLocaleLowerCase('pt-BR')
    state.books.filter((book) => !queryText || [book.title, book.author, book.code].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(queryText))).forEach((book) => selectedLabelBookIds.add(book.id))
    renderLabelSelection()
  }
  if ($('#clearLabelSelectionBtn')) $('#clearLabelSelectionBtn').onclick = () => {
    selectedLabelBookIds.clear()
    renderLabelSelection()
  }
  if ($('#downloadLabelsJpgBtn')) $('#downloadLabelsJpgBtn').onclick = downloadLabelSheetJpg
  if ($('#downloadLabelsPdfBtn')) $('#downloadLabelsPdfBtn').onclick = downloadLabelSheetPdf

  if ($('#cancelBookEditBtn')) $('#cancelBookEditBtn').onclick = () => modal('bookFormModal', false)
  if ($('#cancelReaderEditBtn')) $('#cancelReaderEditBtn').onclick = () => modal('readerFormModal', false)
  if ($('#exportBtn')) $('#exportBtn').onclick = () => modal('exportModal', true)
  if ($('#backupDriveBtn')) $('#backupDriveBtn').onclick = () => uploadDriveBackup()
  if ($('#restoreBackupBtn')) $('#restoreBackupBtn').onclick = () => $('#restoreBackupInput')?.click()
  if ($('#restoreBackupInput')) $('#restoreBackupInput').onchange = restoreLocalBackup
  if ($('#exportCsvOption')) $('#exportCsvOption').onclick = exportCsv
  if ($('#exportXlsxOption')) $('#exportXlsxOption').onclick = exportXlsx
  if ($('#openSettingsBtn')) $('#openSettingsBtn').onclick = () => {
    syncSchoolSettingsForm()
    if ($('#settingsModalTitle')) $('#settingsModalTitle').textContent = 'Configurações da escola'
    modal('settingsModal', true)
  }

  $$('.modal [data-close]').forEach((b) => b.onclick = () => {
    if (b.dataset.close === 'loginModal' && state.profile?.role !== 'admin') return
    if (b.dataset.close === 'settingsModal' && schoolSetupRequired) return toast('Informe o nome da escola para concluir a configuração inicial.', 'error')
    if (b.dataset.close === 'qrScannerModal') stopQrScanner()
    modal(b.dataset.close, false)
  })

  if ($('#copyNotificationBtn')) $('#copyNotificationBtn').onclick = async () => { try { await navigator.clipboard.writeText($('#notificationMessage')?.value || ''); toast('Mensagem copiada.') } catch { toast('Não foi possível copiar.', 'error') } }
  if ($('#sendWhatsappBtn')) $('#sendWhatsappBtn').onclick = () => triggerNotification('whatsapp')
  if ($('#logoutBtn')) $('#logoutBtn').onclick = async () => {
    resetAdminState()
    modal('loginModal', true)
    if (!canUseFirebase || !auth) {
      toast('Sessão local encerrada.')
      return
    }
    try { await signOut(auth); toast('Sessão encerrada.') } catch (err) { error(err) }
  }
}

/* -------------------------
   School settings
   ------------------------- */
function fillLibrisConfigurationForm(school = {}) {
  if ($('#librisSchoolIdInput')) $('#librisSchoolIdInput').value = school.id || ''
  if ($('#librisSchoolNameInput')) $('#librisSchoolNameInput').value = school.name || ''
  if ($('#librisAuthorizedEmailsInput')) $('#librisAuthorizedEmailsInput').value = (school.authorizedEmails || []).join('\n')
}

async function saveLibrisConfiguration(event) {
  event.preventDefault()
  if (state.profile?.role !== 'libris_admin') return toast('Somente a conta Libris pode alterar esta configuração.', 'error')

  const schoolId = $('#librisSchoolIdInput')?.value.trim().toLowerCase()
  const schoolName = $('#librisSchoolNameInput')?.value.trim()
  const authorizedEmails = [...new Set(String($('#librisAuthorizedEmailsInput')?.value || '')
    .split(/[\n,;]/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean))]
  if (!schoolId || !/^[a-z0-9_-]+$/.test(schoolId) || !schoolName) return toast('Informe um identificador válido e o nome da escola.', 'error')
  if (!authorizedEmails.length || authorizedEmails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return toast('Informe pelo menos um email válido por linha.', 'error')

  const school = {
    id: schoolId,
    schoolId,
    name: schoolName,
    authorizedEmails,
    active: true,
    updatedAt: new Date()
  }

  try {
    const existingSchools = await localStore.list('schools')
    if (existingSchools.length && !existingSchools.some((item) => item.id === schoolId)) {
      return toast('Este computador já está configurado para outra escola. Não altere o identificador por aqui.', 'error')
    }
    const existingSchool = existingSchools.find((item) => item.id === schoolId) || {}
    const existingSchoolSettings = { ...existingSchool }
    delete existingSchoolSettings.emailjs
    await setDoc(doc(db, 'schools', schoolId), { ...existingSchoolSettings, ...school })
    const existingUsers = await localStore.list('users')
    for (const user of existingUsers.filter((item) => item.schoolId === schoolId && item.email)) {
      const active = authorizedEmails.includes(String(user.email).toLowerCase())
      await setDoc(doc(db, 'users', user.id), { ...user, active, updatedAt: new Date() }, { merge: true })
    }
    for (const email of authorizedEmails) {
      await setDoc(doc(db, 'users', email), { email, role: 'admin', schoolId, active: true, updatedAt: new Date() }, { merge: true })
    }
    config.currentSchoolId = schoolId
    config.schoolName = schoolName
    toast('Configuração local salva. Os emails autorizados podem entrar nesta máquina.')
  } catch (err) {
    error(err, 'Não foi possível salvar a configuração local.')
  }
}

async function saveSchoolSettings(event) {
  event.preventDefault()
  if (!canUseFirebase || !db) return toast('Entre com uma conta autorizada para alterar as configurações.', 'error')

  const schoolName = $('#schoolNameInput')?.value.trim() || ''
  const coordinationEmail = $('#coordinationEmailInput')?.value.trim() || ''
  const reminderDays = Number($('#reminderDaysInput')?.value || 1)
  const coordinationDays = Number($('#coordinationDaysInput')?.value || 7)

  const maxBooksStudent = Number($('#maxBooksStudentInput')?.value || config.maxBooksStudent || 2)
  const maxBooksTeacher = Number($('#maxBooksTeacherInput')?.value || config.maxBooksTeacher || 35)
  const teacherLoanDays = Number($('#teacherLoanDaysInput')?.value || config.teacherLoanDays || 21)

  if (!schoolName) return toast('Informe o nome da escola para continuar.', 'error')

  try {
    const schoolRef = doc(db, 'schools', config.currentSchoolId)
    const existingSchool = schoolSetupRequired ? await getDoc(schoolRef) : null
    const initialFields = schoolSetupRequired && !existingSchool?.exists() ? { active: true, bookSequences: {} } : {}
    await setDoc(schoolRef, {
      ...initialFields,
      name: schoolName,
      coordinationEmail,
      reminderDays,
      coordinationDays,
      maxBooksStudent,
      maxBooksTeacher,
      teacherLoanDays,
      updatedAt: serverTimestamp()
    }, { merge: true })

    config.schoolName = schoolName
    config.coordinationEmail = coordinationEmail
    config.reminderDays = reminderDays
    config.coordinationDays = coordinationDays
    config.maxBooksStudent = maxBooksStudent
    config.maxBooksTeacher = maxBooksTeacher
    config.teacherLoanDays = teacherLoanDays
    syncSchoolSettingsForm(config)
    await logAudit(schoolSetupRequired ? 'school_initialized' : 'school_settings_updated', { schoolId: config.currentSchoolId, schoolName, coordinationEmail, reminderDays, coordinationDays, maxBooksStudent, maxBooksTeacher, teacherLoanDays }, state.user?.uid || null)

    if (schoolSetupRequired) {
      if (!await loadSchoolData(config.currentSchoolId)) throw new Error('As configurações da escola não puderam ser recarregadas.')
      await subscribeAdmin()
      if (auth.currentUser?.uid !== state.user?.uid) return
      schoolSetupRequired = false
      if ($('#settingsModalTitle')) $('#settingsModalTitle').textContent = 'Configurações da escola'
      if ($('#adminView')) $('#adminView').hidden = false
      if ($('#openSettingsBtn')) $('#openSettingsBtn').hidden = false
      if ($('#logoutBtn')) $('#logoutBtn').hidden = false
      if ($('#backupDriveBtn')) $('#backupDriveBtn').hidden = false
      modal('loginModal', false)
      await updateDriveBackupStatus()
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
  const reminderDaysInput = $('#reminderDaysInput')
  const coordinationDaysInput = $('#coordinationDaysInput')
  const maxBooksStudentInput = $('#maxBooksStudentInput')
  const maxBooksTeacherInput = $('#maxBooksTeacherInput')
  const teacherLoanDaysInput = $('#teacherLoanDaysInput')
  const settings = data || {}

  if (schoolNameInput) schoolNameInput.value = settings.schoolName || ''
  if (coordinationEmailInput) coordinationEmailInput.value = settings.coordinationEmail || ''
  if (reminderDaysInput) reminderDaysInput.value = String(settings.reminderDays ?? 1)
  if (coordinationDaysInput) coordinationDaysInput.value = String(settings.coordinationDays ?? 7)
  if (maxBooksStudentInput) maxBooksStudentInput.value = String(settings.maxBooksStudent ?? 2)
  if (maxBooksTeacherInput) maxBooksTeacherInput.value = String(settings.maxBooksTeacher ?? 35)
  if (teacherLoanDaysInput) teacherLoanDaysInput.value = String(settings.teacherLoanDays ?? 21)
}

/* Load school settings after local email authorization. */
async function loadSchoolData(schoolId = config.currentSchoolId) {
  if (!canUseFirebase || !db) return

  try {
    config.currentSchoolId = schoolId || config.currentSchoolId
    config.schoolName = ''
    config.coordinationEmail = ''
    config.reminderDays = 1
    config.coordinationDays = 7
    config.maxBooksStudent = 2
    config.maxBooksTeacher = 35
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
      config.teacherLoanDays = Number(data.teacherLoanDays ?? 21)
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

async function resolveUserSchool(user) {
  if (!canUseFirebase || !db || !user) return null

  try {
    const email = String(user.email || '').trim().toLowerCase()
    if (!email) return null
    if (email === LIBRIS_ADMIN_EMAIL) {
      const usesPasswordProvider = user.providerData?.some((provider) => provider.providerId === 'password')
      return usesPasswordProvider ? { role: 'libris_admin', email } : null
    }

    const schools = await localStore.list('schools')
    const school = schools.find((item) => (item.authorizedEmails || []).map((value) => String(value).toLowerCase()).includes(email))
    if (school) {
      const usesGoogleProvider = user.providerData?.some((provider) => provider.providerId === 'google.com')
      if (!usesGoogleProvider) return null
      const profile = { role: 'admin', schoolId: school.id, email, active: true }
      await setDoc(doc(db, 'users', user.uid), profile, { merge: true })
      return profile
    }

    const localUserDoc = await getDoc(doc(db, 'users', user.uid))
    const profile = localUserDoc.exists() ? localUserDoc.data() : null

    if (profile?.role === 'admin' && typeof profile.schoolId === 'string' && profile.schoolId.trim()) {
      const schoolDoc = await getDoc(doc(db, 'schools', profile.schoolId))
      const allowedEmails = schoolDoc.exists() ? schoolDoc.data().authorizedEmails : null
      if (Array.isArray(allowedEmails) && allowedEmails.length && !allowedEmails.map((value) => String(value).toLowerCase()).includes(email)) return null
      return { ...profile, email }
    }

    return null
  } catch (err) {
    error(err, 'Não foi possível recuperar a escola deste usuário.')
    return null
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

if ($('#googleLoginBtn')) {
  $('#googleLoginBtn').onclick = async () => {
    const button = $('#googleLoginBtn')
    loading(button, true, 'Abrindo Google…')
    if (!canUseFirebase || !auth || !googleProvider) {
      toast('Login Google indisponível. Verifique a configuração de autenticação.', 'error')
      loading(button, false)
      return
    }
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (err) {
      error(err, 'Não foi possível entrar com a conta Google.')
    } finally {
      loading(button, false)
    }
  }
}

if ($('#credeLoginForm')) {
  $('#credeLoginForm').onsubmit = async (event) => {
    event.preventDefault()
    const button = $('#credeLoginBtn')
    const password = $('#credePasswordInput')?.value || ''
    loading(button, true, 'Validando acesso…')
    if (!canUseFirebase || !auth) {
      toast('Autenticação indisponível. Verifique o Firebase Authentication.', 'error')
      loading(button, false)
      return
    }
    try {
      await signInWithEmailAndPassword(auth, LIBRIS_ADMIN_EMAIL, password)
    } catch (err) {
      error(err, 'Não foi possível entrar com a conta administrativa CREDE.')
    } finally {
      if ($('#credePasswordInput')) $('#credePasswordInput').value = ''
      loading(button, false)
    }
  }
}

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
  const backupButton = $('#backupDriveBtn')
  if (adminView) adminView.hidden = true
  if (settingsButton) settingsButton.hidden = true
  if (logoutButton) logoutButton.hidden = true
  if (backupButton) backupButton.hidden = true

  if (!canUseFirebase || !db) {
    state.user = null
    state.profile = null
    modal('loginModal', true)
    toast('Firebase Auth indisponível. Verifique a configuração do projeto.', 'error')
    return
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      resetAdminState()
      modal('loginModal', true)
      $('#loginForm input[type="email"]')?.focus()
      return
    }

    state.user = user
    state.profile = await resolveUserSchool(user)
    if (auth.currentUser?.uid !== user.uid) return

    if (state.profile?.role === 'libris_admin') {
      const schools = await localStore.list('schools')
      fillLibrisConfigurationForm(schools[0] || {})
      if ($('#librisAdminView')) $('#librisAdminView').hidden = false
      if (adminView) adminView.hidden = true
      if (settingsButton) settingsButton.hidden = true
      if (logoutButton) logoutButton.hidden = false
      modal('loginModal', false)
      return
    }

    if (state.profile?.role !== 'admin' || typeof state.profile.schoolId !== 'string' || !state.profile.schoolId.trim()) {
      resetAdminState()
      modal('loginModal', true)
      toast('Esta conta não possui acesso administrativo vinculado a uma escola.', 'error')
      try { await signOut(auth) } catch (e) { /* ignore */ }
      return
    }

    if (!await loadSchoolData(state.profile.schoolId)) {
      schoolSetupRequired = true
      if (adminView) adminView.hidden = true
      if (settingsButton) settingsButton.hidden = true
      if (logoutButton) logoutButton.hidden = false
      if ($('#settingsModalTitle')) $('#settingsModalTitle').textContent = 'Configuração inicial da escola'
      if ($('#schoolNameInput')) $('#schoolNameInput').value = ''
      modal('loginModal', false)
      modal('settingsModal', true)
      $('#schoolNameInput')?.focus()
      return
    }

    if (auth.currentUser?.uid !== user.uid) return
    try {
      await subscribeAdmin()
    } catch (err) {
      error(err, 'Não foi possível carregar os dados administrativos desta escola.')
      resetAdminState()
      modal('loginModal', true)
      try { await signOut(auth) } catch (e) { /* ignore */ }
      return
    }
    if (auth.currentUser?.uid !== user.uid) {
      clearAdminSubscriptions()
      return
    }
    if (adminView) adminView.hidden = false
    if (settingsButton) settingsButton.hidden = false
    if (logoutButton) logoutButton.hidden = false
    if (backupButton) backupButton.hidden = false
    modal('loginModal', false)
    await updateDriveBackupStatus()
  })
}

init()

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('PWA indisponível:', err))
  })
}
