import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'

export const firebaseConfig = {
  apiKey: 'AIzaSyBWVnNcSHqt3LqsnvZYbCMc7S5wHZuWwaY',
  authDomain: 'librisce.firebaseapp.com',
  projectId: 'librisce',
  storageBucket: 'librisce.firebasestorage.app',
  messagingSenderId: '1003932601888',
  appId: '1:1003932601888:web:8ea81e3f6d0ba2cbd8f645',
  measurementId: 'G-SCSF9Y5G2S'
}

export const firebaseReady = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.appId
)

export const app = firebaseReady ? initializeApp(firebaseConfig) : null
export const auth = app ? getAuth(app) : null
export const googleProvider = auth ? new GoogleAuthProvider() : null
export const googleDriveProvider = auth ? new GoogleAuthProvider() : null
if (googleDriveProvider) googleDriveProvider.addScope('https://www.googleapis.com/auth/drive.file')

export {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  GoogleAuthProvider
}
