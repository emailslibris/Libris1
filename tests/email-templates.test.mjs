import test from 'node:test'
import assert from 'node:assert/strict'
import { createCoordinationEmailHtml, createStudentEmailHtml } from '../email-templates.mjs'

test('gera o modelo do aluno com os detalhes do empréstimo e conteúdo escapado', () => {
  const html = createStudentEmailHtml({
    subject: 'Aviso <biblioteca>',
    schoolName: 'Escola & Biblioteca',
    message: 'Olá, Ana.\nSeu livro está atrasado.',
    bookTitle: '<Livro>',
    dueDate: '29/10/2026',
    loanDays: 7
  })

  assert.match(html, /Aviso &lt;biblioteca&gt;/)
  assert.match(html, /Escola &amp; Biblioteca/)
  assert.match(html, /Olá, Ana\.<br>Seu livro está atrasado\./)
  assert.match(html, /&lt;Livro&gt;/)
  assert.match(html, /29\/10\/2026/)
  assert.match(html, /7 dias/)
  assert.doesNotMatch(html, /\{\{[^}]+\}\}/)
})

test('gera o modelo da coordenação com leitor, atraso e dados escapados', () => {
  const html = createCoordinationEmailHtml({
    subject: 'Atraso',
    schoolName: 'Escola Central',
    message: 'Regularizar devolução.',
    readerName: 'Ana <Souza>',
    bookTitle: 'Livro & História',
    dueDate: '20/10/2026',
    daysOverdue: 9
  })

  assert.match(html, /Aviso à coordenação/)
  assert.match(html, /Ana &lt;Souza&gt;/)
  assert.match(html, /Livro &amp; História/)
  assert.match(html, /Livro em atraso: 9 dia\(s\)/)
  assert.doesNotMatch(html, /\{\{[^}]+\}\}/)
})
