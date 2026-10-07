import { initializeApp } from 'firebase/app';
import { getAnalytics, isSupported } from 'firebase/analytics';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore } from 'firebase/firestore';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { environment } from '../../environments/environment';

/** Single Firebase app instance shared by every service. */
export const firebaseApp = initializeApp(environment.firebase);

export const auth = getAuth(firebaseApp);
export const db = initializeFirestore(firebaseApp, { ignoreUndefinedProperties: true });
export const storage = getStorage(firebaseApp);
export const bucketName = environment.firebase.storageBucket;

if (environment.useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
} else if (environment.firebase.measurementId) {
  isSupported()
    .then((ok) => ok && getAnalytics(firebaseApp))
    .catch(() => undefined);
}
