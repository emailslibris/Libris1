const admin = require('firebase-admin');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const { google } = require('googleapis');
const { Readable } = require('node:stream');

admin.initializeApp();

const db = admin.firestore();
const GOOGLE_DRIVE_BACKUP_CONFIG = defineSecret('GOOGLE_DRIVE_BACKUP_CONFIG');

function serializeBackupValue(value) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeBackupValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, serializeBackupValue(nested)]));
  }
  return value;
}

function safeDriveFilePart(value) {
  return String(value || 'school').replace(/[^a-z0-9_-]/gi, '_');
}

async function uploadSchoolBackup(drive, folderId, schoolDoc, generatedAt) {
  const schoolId = schoolDoc.id;
  const collectionNames = ['books', 'categories', 'readers', 'loans', 'reservations', 'counters', 'audit_logs', 'users'];
  const snapshots = await Promise.all(collectionNames.map((name) => db.collection(name).where('schoolId', '==', schoolId).get()));
  const collections = Object.fromEntries(collectionNames.map((name, index) => [
    name,
    snapshots[index].docs.map((document) => ({
      id: document.id,
      ...serializeBackupValue(document.data())
    }))
  ]));
  const backup = {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    schoolId,
    school: serializeBackupValue(schoolDoc.data()),
    collections
  };
  const fileName = `libris-backup-${safeDriveFilePart(schoolId)}-${generatedAt.toISOString().slice(0, 10)}.json`;
  const content = JSON.stringify(backup, null, 2);
  const result = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType: 'application/json',
      parents: [folderId]
    },
    supportsAllDrives: true,
    media: {
      mimeType: 'application/json',
      body: Readable.from([content])
    },
    fields: 'id,name'
  });

  return { fileId: result.data.id, fileName, schoolId, counts: Object.fromEntries(collectionNames.map((name, index) => [name, snapshots[index].size])) };
}

exports.weeklySchoolDriveBackup = onSchedule(
  {
    schedule: '0 3 * * 1',
    timeZone: 'America/Fortaleza',
    region: 'southamerica-east1',
    timeoutSeconds: 540,
    memory: '1GiB',
    secrets: [GOOGLE_DRIVE_BACKUP_CONFIG]
  },
  async () => {
    const configuration = JSON.parse(GOOGLE_DRIVE_BACKUP_CONFIG.value());
    const { clientEmail, privateKey, folderId } = configuration;
    if (!clientEmail || !privateKey || !folderId) {
      throw new Error('GOOGLE_DRIVE_BACKUP_CONFIG precisa conter clientEmail, privateKey e folderId.');
    }

    const auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    const drive = google.drive({ version: 'v3', auth });
    const schoolsSnapshot = await db.collection('schools').get();
    const generatedAt = new Date();
    const failures = [];

    for (const schoolDoc of schoolsSnapshot.docs) {
      try {
        const uploaded = await uploadSchoolBackup(drive, folderId, schoolDoc, generatedAt);
        logger.info('Backup escolar enviado ao Google Drive.', uploaded);
      } catch (error) {
        failures.push(schoolDoc.id);
        logger.error(`Falha no backup da escola ${schoolDoc.id}.`, error);
      }
    }

    if (failures.length) {
      throw new Error(`Falha no backup das escolas: ${failures.join(', ')}`);
    }
    return null;
  }
);
