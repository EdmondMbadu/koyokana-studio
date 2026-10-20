import { AppEnvironment } from './environment.model';
import { firebaseApiKey } from './firebase-key';

export const baseEnvironment: AppEnvironment = {
  production: true,
  useEmulators: false,
  firebase: {
    apiKey: firebaseApiKey,
    authDomain: 'koyokana-studio.firebaseapp.com',
    projectId: 'koyokana-studio',
    storageBucket: 'koyokana-studio.firebasestorage.app',
    messagingSenderId: '303635763719',
    appId: '1:303635763719:web:06f75839eb86cff3a9d0a2',
    measurementId: 'G-D5X5L2NS19',
  },
  // Accounts that become admin automatically on first sign-in.
  // Must match the list in firestore.rules (isOwnerEmail).
  ownerEmails: ['mbadungoma@gmail.com'],
  gcp: {
    projectId: 'koyokana-studio',
    region: 'us-central1',
    artifactRepo: 'koyokana',
    ttsImageDigest: 'sha256:d0d43f8dd12c43de3c900c402b42c34efcb418339a5c83d0f61fb8b1e46e6ea3',
  },
  goalsHours: [10, 30],
};
