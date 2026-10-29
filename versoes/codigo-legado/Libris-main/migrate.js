const fs = require('fs')
const path = require('path')
const admin = require('firebase-admin')

const DATA_FILE = path.resolve(process.cwd(), 'dados_antigos.json')
const CSV_FILE = path.resolve(process.cwd(), 'dados_antigos.csv')
const MAX_BATCH_SIZE = 500

function parseCsv(text) {
  const rows = text.trim().split(/\r?\n/).filter(Boolean)
  if (rows.length < 2) return []

  const headers = rows[0].split(';').map((field) => field.trim())
  return rows.slice(1).map((row) => {
    const values = row.split(';').map((value) => value.trim())
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  })
}

function normalizeRecord(record = {}, collectionName, schoolId) {
  const payload = { ...record }

  if (collectionName === 'books') {
    const total = Number(payload.total ?? payload.quantidade ?? 0)
    const available = Number(payload.available ?? total)
    return {
      code: String(payload.code ?? '').replace(/\D+/g, '').slice(0, 5).padStart(5, '0'),
      title: String(payload.title ?? payload.titulo ?? '').trim(),
      author: String(payload.author ?? payload.autor ?? '').trim(),
      categoryId: String(payload.categoryId ?? payload.categoria ?? '').trim(),
      schoolId,
      total: Number.isFinite(total) ? total : 0,
      available: Number.isFinite(available) ? Math.max(0, Math.min(available, total)) : 0,
      createdAt: payload.createdAt || admin.firestore.FieldValue.serverTimestamp()
    }
  }

  if (collectionName === 'readers') {
    return {
      name: String(payload.name ?? payload.nome ?? '').trim(),
      schoolId,
      class: String(payload.class ?? payload.turma ?? '').trim(),
      role: ['student', 'guardian', 'teacher'].includes(String(payload.role ?? '').toLowerCase()) ? String(payload.role).toLowerCase() : 'student',
      guardianUid: payload.guardianUid || null,
      email: String(payload.email ?? '').trim(),
      phone: String(payload.phone ?? '').trim()
    }
  }

  if (collectionName === 'loans') {
    return {
      readerId: String(payload.readerId ?? '').trim(),
      bookId: String(payload.bookId ?? '').trim(),
      schoolId,
      borrowedAt: payload.borrowedAt ? new Date(payload.borrowedAt) : admin.firestore.Timestamp.now(),
      dueAt: payload.dueAt ? new Date(payload.dueAt) : admin.firestore.Timestamp.now(),
      status: ['active', 'returned'].includes(String(payload.status ?? '')) ? String(payload.status) : 'active',
      notices: {
        reminder: Boolean(payload.notices?.reminder ?? false),
        overdue: Boolean(payload.notices?.overdue ?? false),
        coordination: Boolean(payload.notices?.coordination ?? false)
      }
    }
  }

  if (collectionName === 'reservations') {
    return {
      readerId: String(payload.readerId ?? '').trim(),
      bookId: String(payload.bookId ?? '').trim(),
      schoolId,
      guardianUid: String(payload.guardianUid ?? '').trim() || null,
      status: ['pending', 'fulfilled', 'cancelled'].includes(String(payload.status ?? '')) ? String(payload.status) : 'pending',
      createdAt: payload.createdAt ? new Date(payload.createdAt) : admin.firestore.Timestamp.now()
    }
  }

  return { ...payload, schoolId }
}

function readLegacyData() {
  const jsonPath = DATA_FILE
  if (fs.existsSync(jsonPath)) {
    const raw = fs.readFileSync(jsonPath, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : parsed.items || []
  }

  const csvPath = CSV_FILE
  if (fs.existsSync(csvPath)) {
    const raw = fs.readFileSync(csvPath, 'utf8')
    return parseCsv(raw)
  }

  throw new Error('Arquivo local de migração não encontrado. Crie dados_antigos.json ou dados_antigos.csv na raiz do projeto.')
}

async function migrateCollection(collectionName, rows, schoolId) {
  const db = admin.firestore()
  const documents = rows
    .map((row) => normalizeRecord(row, collectionName, schoolId))
    .filter((record) => Object.keys(record).length > 0)

  if (!documents.length) {
    return 0
  }

  let processed = 0
  for (let index = 0; index < documents.length; index += MAX_BATCH_SIZE) {
    const batch = db.batch()
    const slice = documents.slice(index, index + MAX_BATCH_SIZE)

    slice.forEach((record, itemIndex) => {
      const ref = db.collection(collectionName).doc()
      batch.set(ref, { ...record, migratedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
      if (itemIndex === slice.length - 1) {
        batch.set(db.collection('audit_logs').doc(), {
          schoolId,
          action: 'migration_batch',
          details: { collectionName, total: slice.length },
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true })
      }
    })

    await batch.commit()
    processed += slice.length
  }

  return processed
}

async function main() {
  try {
    const schoolId = String(process.env.SCHOOL_ID || '').trim()
    if (!schoolId) {
      throw new Error('Defina SCHOOL_ID com o ID da escola antes de iniciar a migração.')
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'librisce'
      })
    }

    const rawData = readLegacyData()
    const collections = ['books', 'readers', 'loans', 'reservations']
    const totals = {}

    const grouped = {
      books: [],
      readers: [],
      loans: [],
      reservations: []
    }

    rawData.forEach((row = {}) => {
      const key = String(row.collection || row.table || row.type || '').toLowerCase()
      if (key === 'books' || key === 'livros') grouped.books.push(row)
      else if (key === 'readers' || key === 'leitores') grouped.readers.push(row)
      else if (key === 'loans' || key === 'emprestimos') grouped.loans.push(row)
      else if (key === 'reservations' || key === 'reservas') grouped.reservations.push(row)
      else if (!row.collection && !row.table && !row.type) {
        grouped.books.push(row)
      }
    })

    for (const collectionName of collections) {
      totals[collectionName] = await migrateCollection(collectionName, grouped[collectionName], schoolId)
    }

    console.log('Migração concluída.', totals)
  } catch (error) {
    console.error('Falha na migração LGPD:', error)
    process.exit(1)
  }
}

main()
