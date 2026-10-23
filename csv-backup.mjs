export const backupCollectionFiles = {
  'acervo.csv': 'books',
  'emprestimos.csv': 'loans',
  'leitores.csv': 'readers',
  'categorias.csv': 'categories',
  'reservas.csv': 'reservations',
  'contadores.csv': 'counters',
  'auditoria.csv': 'audit_logs',
  'escola.csv': 'schools'
}

export const optionalBackupCollectionFiles = {
  'emails-enviados.csv': 'email_logs',
  'uso-emails.csv': 'email_usage'
}

export const normalizeCsvHeader = (value) => String(value ?? '')
  .replace(/^\uFEFF/, '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

export function resolveLegacyCategory({ name, categoryId, code, categories = [] }) {
  const codeMatch = String(code || '').toUpperCase().match(/^([A-Z0-9]{1,4})-\d{4}$/)
  if (!codeMatch) return { error: 'código inválido para identificar a categoria' }
  const prefix = codeMatch[1]
  const normalizedName = normalizeCsvHeader(name)
  const normalizedId = normalizeCsvHeader(categoryId)
  const byName = categories.find((category) => normalizeCsvHeader(category.name) === normalizedName)
  const byId = categories.find((category) => [category.id, category.code, category.name]
    .some((value) => normalizeCsvHeader(value) === normalizedId))
  const byCode = categories.find((category) => String(category.code || category.id).toUpperCase() === prefix)
  const category = byName || byCode || byId
  if (category) {
    if (String(category.code || category.id).toUpperCase() !== prefix) {
      return { error: 'prefixo do código não corresponde à categoria' }
    }
    return { category, create: false }
  }
  if (!normalizedName && !normalizedId) return { error: 'categoria ausente' }
  return {
    category: { id: prefix, code: prefix, name: String(name || `Categoria ${prefix}`).trim() },
    create: true
  }
}

export const csvHeaderAliases = {
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
  status: ['status'],
  sinopse: ['sinopse', 'synopsis'],
  capa: ['url da capa', 'capa url', 'cover url', 'coverurl'],
  schoolId: ['id da escola', 'school id', 'schoolid'],
  schoolName: ['nome da escola', 'school name', 'schoolname'],
  criadoEm: ['criado em', 'created at', 'createdat'],
  atualizadoEm: ['atualizado em', 'updated at', 'updatedat']
}

const bookBackupFields = {
  documentId: 'id',
  codigo: 'code',
  titulo: 'title',
  autor: 'author',
  editora: 'publisher',
  categoriaId: 'categoryId',
  categoriaNome: 'categoryName',
  categoria: 'categoryName',
  ano: 'year',
  localizacao: 'shelf',
  sinopse: 'synopsis',
  capa: 'coverUrl',
  disponiveis: 'available',
  total: 'total',
  tombamento: 'tombamento',
  status: 'status',
  schoolId: 'schoolId',
  schoolName: 'schoolName',
  criadoEm: 'createdAt',
  atualizadoEm: 'updatedAt'
}

export function csvFromRows(rows) {
  return rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(';')).join('\n')
}

export function parseBackupCell(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true'
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed)
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const parsedDate = new Date(trimmed)
    if (!Number.isNaN(parsedDate.getTime())) return parsedDate
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed) } catch { return value }
  }
  return value
}

export function backupRecordFromRow(headers, row, collectionName) {
  const record = {}
  headers.forEach((header, index) => {
    const normalized = normalizeCsvHeader(header)
    const alias = Object.entries(csvHeaderAliases).find(([, aliases]) => aliases.includes(normalized))?.[0]
    const field = collectionName === 'books'
      ? bookBackupFields[alias] || String(header).trim()
      : String(header).trim()
    if (field) record[field] = parseBackupCell(row[index])
  })
  return record
}
