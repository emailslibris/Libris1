import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { indexedDB } from 'fake-indexeddb'
import { createLocalStore } from '../local-store.mjs'

let store
let testDatabaseNumber = 0

afterEach(async () => {
  await store?.close()
  store = null
})

function createStore() {
  testDatabaseNumber += 1
  store = createLocalStore({ dbName: `libris-test-${testDatabaseNumber}`, indexedDBImpl: indexedDB })
  return store
}

test('grava, lista, atualiza e remove registros locais', async () => {
  const local = createStore()
  await local.put('books', { id: 'book-1', schoolId: 'school-a', title: 'A Biblioteca' })
  await local.put('books', { id: 'book-1', schoolId: 'school-a', title: 'Biblioteca Atualizada' })

  assert.deepEqual(await local.get('books', 'book-1'), {
    schoolId: 'school-a',
    title: 'Biblioteca Atualizada',
    id: 'book-1'
  })
  assert.equal((await local.list('books')).length, 1)

  await local.remove('books', 'book-1')
  assert.equal(await local.get('books', 'book-1'), null)
})

test('exporta apenas os registros da escola solicitada', async () => {
  const local = createStore()
  await local.putMany('books', [
    { id: 'a-1', schoolId: 'school-a', title: 'Livro A' },
    { id: 'b-1', schoolId: 'school-b', title: 'Livro B' }
  ])

  const backup = await local.exportSchool('school-a')
  assert.equal(backup.schoolId, 'school-a')
  assert.deepEqual(backup.collections.books.map((book) => book.id), ['a-1'])
})

test('restaura uma escola sem alterar registros de outra', async () => {
  const local = createStore()
  await local.putMany('books', [
    { id: 'a-old', schoolId: 'school-a', title: 'Antigo' },
    { id: 'b-1', schoolId: 'school-b', title: 'Preservado' }
  ])

  await local.replaceSchool('school-a', {
    schemaVersion: 1,
    schoolId: 'school-a',
    collections: {
      books: [{ id: 'a-new', title: 'Restaurado' }],
      readers: [{ id: 'reader-a', name: 'Leitor A' }]
    }
  })

  assert.deepEqual((await local.list('books')).map((book) => book.id).sort(), ['a-new', 'b-1'])
  assert.deepEqual(await local.get('readers', 'reader-a'), {
    name: 'Leitor A',
    schoolId: 'school-a',
    id: 'reader-a'
  })
})

test('rejeita um backup destinado a outra escola', async () => {
  const local = createStore()
  await assert.rejects(
    local.replaceSchool('school-a', { schoolId: 'school-b', collections: {} }),
    /não corresponde à escola selecionada/
  )
})

test('restaura o formato legado com escola fora das coleções', async () => {
  const local = createStore()
  await local.replaceSchool('school-a', {
    schemaVersion: 1,
    schoolId: 'school-a',
    school: { name: 'Escola A' },
    collections: { books: [{ id: 'book-a', title: 'Livro A' }] }
  })

  assert.equal((await local.get('schools', 'school-a')).name, 'Escola A')
  assert.equal((await local.get('books', 'book-a')).title, 'Livro A')
})