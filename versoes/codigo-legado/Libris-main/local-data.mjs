function documentData(record) {
  if (!record) return undefined
  const { id, ...data } = record
  return data
}

function makeDocumentSnapshot(record, id) {
  return {
    id,
    exists: () => Boolean(record),
    data: () => documentData(record)
  }
}

function matches(record, constraints) {
  return constraints.every(({ field, operator, value }) => {
    const actual = field.split('.').reduce((current, part) => current?.[part], record)
    if (operator === '==') return actual === value
    if (operator === '!=') return actual !== value
    if (operator === 'in') return Array.isArray(value) && value.includes(actual)
    if (operator === 'array-contains') return Array.isArray(actual) && actual.includes(value)
    if (operator === '>') return actual > value
    if (operator === '>=') return actual >= value
    if (operator === '<') return actual < value
    if (operator === '<=') return actual <= value
    throw new Error(`Operador local não suportado: ${operator}`)
  })
}

function snapshotFor(records) {
  const docs = records.map((record) => ({
    id: record.id,
    data: () => documentData(record)
  }))
  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach: (callback) => docs.forEach(callback)
  }
}

function mergeData(existing, incoming) {
  const merged = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    if (value && typeof value === 'object' && Number.isFinite(value.__librisIncrement)) {
      merged[key] = Number(merged[key] || 0) + value.__librisIncrement
    } else {
      merged[key] = value
    }
  }
  return merged
}

export function createLocalDataApi(store) {
  const db = Object.freeze({ type: 'libris-local' })
  let transactionQueue = Promise.resolve()

  function collection(_database, name) {
    return { type: 'collection', name }
  }

  function doc(databaseOrCollection, nameOrId, maybeId) {
    if (databaseOrCollection?.type === 'collection') {
      return { type: 'document', collection: databaseOrCollection.name, id: String(nameOrId || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`) }
    }
    return { type: 'document', collection: nameOrId, id: String(maybeId) }
  }

  function where(field, operator, value) {
    return { type: 'where', field, operator, value }
  }

  function query(collectionReference, ...constraints) {
    return {
      type: 'query',
      collection: collectionReference.collection || collectionReference.name,
      constraints: [...(collectionReference.constraints || []), ...constraints]
    }
  }

  async function getDoc(reference) {
    const record = await store.get(reference.collection, reference.id)
    return makeDocumentSnapshot(record, reference.id)
  }

  async function recordsFor(reference) {
    const records = await store.list(reference.collection || reference.name)
    return reference.constraints ? records.filter((record) => matches(record, reference.constraints)) : records
  }

  async function getDocs(reference) {
    return snapshotFor(await recordsFor(reference))
  }

  async function applyWrites(writes) {
    const operations = []
    for (const write of writes) {
      if (write.type === 'delete') {
        operations.push({ type: 'delete', collection: write.reference.collection, id: write.reference.id })
        continue
      }

      const existing = await store.get(write.reference.collection, write.reference.id)
      if (write.type === 'update' && !existing) throw new Error('O registro local que você tentou atualizar não existe.')
      const incoming = write.data
      const record = write.merge || write.type === 'update'
        ? mergeData(existing || {}, incoming)
        : mergeData({}, incoming)
      operations.push({
        type: 'put',
        collection: write.reference.collection,
        record: { ...record, id: write.reference.id }
      })
    }
    if (operations.length) await store.applyBatch(operations)
  }

  async function setDoc(reference, data, options = {}) {
    await applyWrites([{ type: 'set', reference, data, merge: options.merge === true }])
  }

  async function addDoc(reference, data) {
    const documentReference = doc(reference)
    await setDoc(documentReference, data)
    return documentReference
  }

  async function updateDoc(reference, data) {
    await applyWrites([{ type: 'update', reference, data }])
  }

  async function deleteDoc(reference) {
    await applyWrites([{ type: 'delete', reference }])
  }

  function runTransaction(_database, callback) {
    const run = transactionQueue.then(async () => {
      const writes = []
      const transaction = {
        get: getDoc,
        set: (reference, data, options = {}) => writes.push({ type: 'set', reference, data, merge: options.merge === true }),
        update: (reference, data) => writes.push({ type: 'update', reference, data }),
        delete: (reference) => writes.push({ type: 'delete', reference })
      }
      const result = await callback(transaction)
      await applyWrites(writes)
      return result
    })
    transactionQueue = run.catch(() => {})
    return run
  }

  function writeBatch(_database) {
    const writes = []
    return {
      set: (reference, data, options = {}) => writes.push({ type: 'set', reference, data, merge: options.merge === true }),
      update: (reference, data) => writes.push({ type: 'update', reference, data }),
      delete: (reference) => writes.push({ type: 'delete', reference }),
      commit: () => applyWrites(writes)
    }
  }

  function onSnapshot(reference, onData, onError = console.error) {
    const collectionName = reference.collection || reference.name
    return store.watch(collectionName, (records) => {
      try {
        onData(snapshotFor(reference.constraints ? records.filter((record) => matches(record, reference.constraints)) : records))
      } catch (error) {
        onError(error)
      }
    })
  }

  return {
    db,
    collection,
    doc,
    getDoc,
    getDocs,
    addDoc,
    setDoc,
    updateDoc,
    deleteDoc,
    query,
    where,
    onSnapshot,
    runTransaction,
    writeBatch,
    serverTimestamp: () => new Date(),
    Timestamp: { fromDate: (date) => date },
    increment: (amount) => ({ __librisIncrement: amount })
  }
}