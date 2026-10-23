import test from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { backupCollectionFiles, backupRecordFromRow, csvFromRows, optionalBackupCollectionFiles, resolveLegacyCategory } from '../csv-backup.mjs'

test('exporta o modelo de acervo CSV e preserva valores com separadores e aspas', () => {
  const rows = [
    ['ID do documento', 'Código', 'Título', 'Autor', 'Editora', 'ID da categoria', 'Categoria', 'Ano', 'Localização', 'Sinopse', 'URL da capa', 'Disponíveis', 'Total', 'Tombamento', 'Status', 'ID da escola', 'Nome da escola', 'Criado em', 'Atualizado em'],
    ['book-1', 'CF-0002', 'Título; "especial"', 'Autora', 'Editora', 'CF', 'Contos', '1991', 'Estante 1; prateleira 1', 'Sinopse, com vírgula', 'https://exemplo.test/capa.jpg', '15', '15', '123456789', 'disponivel', 'escola_1', 'Escola de teste', '2026-10-09T13:58:30.757Z', '2026-10-09T14:11:57.012Z']
  ]
  const csv = `\uFEFF${csvFromRows(rows)}`
  const workbook = XLSX.read(csv, { type: 'string', raw: false })
  const parsedRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '', raw: false })

  const book = backupRecordFromRow(parsedRows[0], parsedRows[1], 'books')
  assert.equal(book.id, 'book-1')
  assert.equal(book.code, 'CF-0002')
  assert.equal(book.title, 'Título; "especial"')
  assert.equal(book.shelf, 'Estante 1; prateleira 1')
  assert.equal(book.available, 15)
  assert.equal(book.synopsis, 'Sinopse, com vírgula')
  assert.equal(book.coverUrl, 'https://exemplo.test/capa.jpg')
  assert.equal(book.status, 'disponivel')
  assert.equal(book.schoolId, 'escola_1')
  assert.ok(book.createdAt instanceof Date)
})

test('reconhece os conjuntos CSV necessários para restaurar backup completo', () => {
  assert.deepEqual(Object.values(backupCollectionFiles), [
    'books',
    'loans',
    'readers',
    'categories',
    'reservations',
    'counters',
    'audit_logs',
    'schools'
  ])
  assert.deepEqual(Object.values(optionalBackupCollectionFiles), ['email_logs', 'email_usage'])
  assert.equal(backupRecordFromRow(['id', 'schoolId', 'active'], ['user-1', 'escola_1', 'false'], 'readers').active, false)
})

test('resolve categorias do CSV legado pelo nome ou prefixo e cria as ausentes', () => {
  const category = resolveLegacyCategory({
    name: 'Contos de Fadas',
    categoryId: 'categoria_antiga_1',
    code: 'CF-0002'
  })
  assert.deepEqual(category, {
    category: { id: 'CF', code: 'CF', name: 'Contos de Fadas' },
    create: true
  })

  const existing = resolveLegacyCategory({
    name: 'Leitura Infantil',
    categoryId: 'old-school-category-id',
    code: 'LI-0004',
    categories: [{ id: 'LI', code: 'LI', name: 'Literatura Infantil' }]
  })
  assert.equal(existing.category.name, 'Literatura Infantil')
  assert.equal(existing.create, false)

  const invalid = resolveLegacyCategory({
    name: 'Romance',
    code: 'CF-0005',
    categories: [{ id: 'RM', code: 'RM', name: 'Romance' }]
  })
  assert.equal(invalid.error, 'prefixo do código não corresponde à categoria')
})
