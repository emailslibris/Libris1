import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { indexedDB } from 'fake-indexeddb'
import { createLocalStore } from '../local-store.mjs'
import { createLocalDataApi } from '../local-data.mjs'

let store
let testDatabaseNumber = 0

afterEach(async () => {
  await store?.close()
  store = null
})

function createApi() {
  testDatabaseNumber += 1
  store = createLocalStore({ dbName: `libris-data-test-${testDatabaseNumber}`, indexedDBImpl: indexedDB })
  return createLocalDataApi(store)
}

test('suporta consultas por escola e snapshots', async () => {
  const local = createApi()
  await local.addDoc(local.collection(local.db, 'books'), { schoolId: 'school-a', title: 'Livro A' })
  await local.addDoc(local.collection(local.db, 'books'), { schoolId: 'school-b', title: 'Livro B' })

  const result = await local.getDocs(local.query(
    local.collection(local.db, 'books'),
    local.where('schoolId', '==', 'school-a')
  ))

  assert.equal(result.size, 1)
  assert.equal(result.docs[0].data().title, 'Livro A')
})

test('aplica uma transação de empréstimo com incremento', async () => {
  const local = createApi()
  const bookReference = local.doc(local.db, 'books', 'book-1')
  const loanReference = local.doc(local.db, 'loans', 'loan-1')
  await local.setDoc(bookReference, { schoolId: 'school-a', available: 2, status: 'disponivel' })

  await local.runTransaction(local.db, async (transaction) => {
    const book = await transaction.get(bookReference)
    transaction.update(bookReference, {
      available: local.increment(-1),
      status: book.data().available === 1 ? 'emprestado' : 'disponivel'
    })
    transaction.set(loanReference, { schoolId: 'school-a', status: 'active' })
  })

  assert.equal((await local.getDoc(bookReference)).data().available, 1)
  assert.equal((await local.getDoc(loanReference)).data().status, 'active')
})

test('lote inválido não grava parcialmente', async () => {
  const local = createApi()
  const validReference = local.doc(local.db, 'books', 'book-1')
  const missingReference = local.doc(local.db, 'books', 'missing')
  await local.setDoc(validReference, { title: 'Original' })
  const batch = local.writeBatch(local.db)
  batch.set(validReference, { title: 'Alterado' })
  batch.update(missingReference, { title: 'Inválido' })

  await assert.rejects(batch.commit(), /não existe/)
  assert.equal((await local.getDoc(validReference)).data().title, 'Original')
})