const DATABASE_VERSION = 1
const RECORDS_STORE = 'records'
const COLLECTION_INDEX = 'collection'
const SCHOOL_INDEX = 'schoolId'

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function asRecord(entry) {
  return { ...entry.data, id: entry.id }
}

export function createLocalStore({ dbName = 'libris-local', indexedDBImpl = globalThis.indexedDB } = {}) {
  if (!indexedDBImpl) throw new Error('IndexedDB não está disponível neste navegador.')

  let databasePromise
  const subscribers = new Map()
  const channel = typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new BroadcastChannel(`${dbName}-changes`)
    : null

  function openDatabase() {
    if (databasePromise) return databasePromise

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(dbName, DATABASE_VERSION)

      request.onupgradeneeded = () => {
        const database = request.result
        const records = database.objectStoreNames.contains(RECORDS_STORE)
          ? request.transaction.objectStore(RECORDS_STORE)
          : database.createObjectStore(RECORDS_STORE, { keyPath: ['collection', 'id'] })
        if (!records.indexNames.contains(COLLECTION_INDEX)) records.createIndex(COLLECTION_INDEX, COLLECTION_INDEX)
        if (!records.indexNames.contains(SCHOOL_INDEX)) records.createIndex(SCHOOL_INDEX, SCHOOL_INDEX)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('Não foi possível abrir o armazenamento local.'))
      request.onblocked = () => reject(new Error('Feche as outras abas do Libris para atualizar o armazenamento local.'))
    })

    return databasePromise
  }

  async function transact(mode, operation) {
    const database = await openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(RECORDS_STORE, mode)
      let result
      try {
        result = operation(transaction.objectStore(RECORDS_STORE))
      } catch (error) {
        transaction.abort()
        reject(error)
        return
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error || new Error('Falha no armazenamento local.'))
      transaction.onabort = () => reject(transaction.error || new Error('Operação local cancelada.'))
    })
  }

  function emit(collection) {
    channel?.postMessage({ collection })
    const listeners = subscribers.get(collection)
    if (listeners) for (const listener of listeners) listener()
  }

  async function readCollection(collection) {
    const getResult = await transact('readonly', (records) => {
      let result = []
      records.index(COLLECTION_INDEX).getAll(collection).onsuccess = (event) => {
        result = event.target.result.map(asRecord)
      }
      return () => result
    })
    return getResult()
  }

  function normalizeEntry(collection, record, schoolId) {
    const data = { ...record }
    const id = String(data.id || makeId())
    delete data.id
    if (schoolId && !data.schoolId) data.schoolId = schoolId
    return { collection, id, schoolId: data.schoolId || '', data }
  }

  async function put(collection, record) {
    const entry = normalizeEntry(collection, record)
    await transact('readwrite', (records) => records.put(entry))
    emit(collection)
    return asRecord(entry)
  }

  async function putMany(collection, records) {
    const entries = records.map((record) => normalizeEntry(collection, record))
    await transact('readwrite', (objectStore) => entries.forEach((entry) => objectStore.put(entry)))
    emit(collection)
    return entries.map(asRecord)
  }

  async function applyBatch(operations) {
    const entries = operations.map((operation) => operation.type === 'delete'
      ? { type: 'delete', collection: operation.collection, id: String(operation.id) }
      : { type: 'put', entry: normalizeEntry(operation.collection, operation.record) })
    await transact('readwrite', (records) => entries.forEach((operation) => {
      if (operation.type === 'delete') records.delete([operation.collection, operation.id])
      else records.put(operation.entry)
    }))
    for (const collection of new Set(entries.map((operation) => operation.collection || operation.entry.collection))) emit(collection)
  }

  async function remove(collection, id) {
    await transact('readwrite', (records) => records.delete([collection, String(id)]))
    emit(collection)
  }

  async function exportSchool(schoolId, collectionNames) {
    const names = collectionNames || await transact('readonly', (records) => {
      let result = []
      records.getAllKeys().onsuccess = (event) => {
        result = [...new Set(event.target.result.map(([name]) => name))]
      }
      return () => result
    }).then((getResult) => getResult())

    const collections = Object.fromEntries(await Promise.all(names.map(async (name) => {
      const records = await readCollection(name)
      return [name, records.filter((record) => record.schoolId === schoolId)]
    })))
    return { schemaVersion: 1, schoolId, exportedAt: new Date().toISOString(), collections }
  }

  async function replaceSchool(schoolId, snapshot) {
    if (!snapshot || snapshot.schoolId !== schoolId || !snapshot.collections || typeof snapshot.collections !== 'object') {
      throw new Error('O arquivo de dados não corresponde à escola selecionada.')
    }

    const collections = { ...snapshot.collections }
    if (snapshot.school && !collections.schools) {
      collections.schools = [{ ...snapshot.school, id: schoolId, schoolId }]
    }

    const entries = Object.entries(collections).flatMap(([collection, records]) => {
      if (!Array.isArray(records)) throw new Error(`Coleção inválida no arquivo: ${collection}`)
      return records.map((record) => normalizeEntry(collection, record, schoolId))
    })
    const affectedCollections = new Set(Object.keys(collections))

    await transact('readwrite', (records) => {
      const cursorRequest = records.index(SCHOOL_INDEX).openCursor(schoolId)
      cursorRequest.onsuccess = (event) => {
        const cursor = event.target.result
        if (cursor) {
          affectedCollections.add(cursor.value.collection)
          cursor.delete()
          cursor.continue()
          return
        }
        entries.forEach((entry) => records.put(entry))
      }
    })

    for (const collection of affectedCollections) emit(collection)
  }

  function watch(collection, callback) {
    const listeners = subscribers.get(collection) || new Set()
    const refresh = () => readCollection(collection).then(callback).catch((error) => console.error('Falha ao atualizar dados locais:', error))
    listeners.add(refresh)
    subscribers.set(collection, listeners)
    refresh()
    return () => {
      listeners.delete(refresh)
      if (!listeners.size) subscribers.delete(collection)
    }
  }

  if (channel) channel.onmessage = (event) => {
    const listeners = subscribers.get(event.data?.collection)
    if (listeners) for (const listener of listeners) listener()
  }

  return {
    list: readCollection,
    get: async (collection, id) => {
      const getResult = await transact('readonly', (records) => {
        let result = null
        records.get([collection, String(id)]).onsuccess = (event) => {
          const entry = event.target.result
          result = entry ? asRecord(entry) : null
        }
        return () => result
      })
      return getResult()
    },
    put,
    putMany,
    applyBatch,
    remove,
    exportSchool,
    replaceSchool,
    watch,
    close: async () => {
      channel?.close()
      const database = await databasePromise
      database?.close()
      databasePromise = null
    }
  }
}