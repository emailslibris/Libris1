import test from 'node:test'
import assert from 'node:assert/strict'
import { isbnToEan13, normalizeIsbn } from '../book-identifiers.mjs'

test('normaliza ISBN com prefixo, espaços e hífens', () => {
  assert.equal(normalizeIsbn('ISBN-13: 978-0-306-40615-7'), '9780306406157')
})

test('preserva ISBN-13 válido como EAN-13', () => {
  assert.equal(isbnToEan13('9780306406157'), '9780306406157')
})

test('converte ISBN-10 válido para EAN-13', () => {
  assert.equal(isbnToEan13('0-306-40615-2'), '9780306406157')
})

test('rejeita ISBN inválido ou com checksum incorreto', () => {
  assert.equal(isbnToEan13('9780306406158'), null)
  assert.equal(isbnToEan13('12345'), null)
})