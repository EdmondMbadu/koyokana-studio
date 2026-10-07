import { AppEnvironment } from './environment.model';

export const baseEnvironment: AppEnvironment = {
  production: true,
  useEmulators: false,
  firebase: {
    apiKey: 'AIzaSyAaqkN1QU9OvDXTW7k8H5Dn3og6gLexurc',
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
  },
  goalsHours: [10, 30],
};
